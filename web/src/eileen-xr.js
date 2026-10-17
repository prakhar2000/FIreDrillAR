import * as THREE from 'three';
import { connectPoseChannel } from './eileen-pose-channel.js';
import { loadHeadsetRoom, roomToXRMatrix } from './eileen-xr-room.js';
import { createHeadsetAnnotations } from './eileen-xr-annotations.js';
import { createRoomEffects } from './eileen-effects.js';

const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const roomInput = document.querySelector('#room');
const support = document.querySelector('#support');
const connection = document.querySelector('#connection');
const tracking = document.querySelector('#tracking');
roomInput.value = new URLSearchParams(location.search).get('room') || 'firedrill';
let renderer, scene, camera, session = null, channel = null, reference = null;
let sessionId, seq = 0, lastSend = -Infinity, hasPose = false, sent = 0, label;
let roomRoot, roomPreview, roomReady = false;
let pendingAlignment = null;
let updateAnnotations;
let effects, previousFrameTime = null, latestHeadY = 1.6, modelAlignment = null;
const soundButton = document.querySelector('#effects-sound');
const effectsStatus = document.querySelector('#effects-status');
const roomStatus = document.querySelector('#model-status');

function resetTracking() {
  pendingAlignment = null;
  modelAlignment = null;
  sessionId = crypto.randomUUID(); seq = 0; lastSend = -Infinity; hasPose = false;
  channel?.tracking('reset');
  if (roomRoot && roomPreview) {
    roomRoot.matrix.copy(roomPreview);
    roomStatus.textContent = 'Room preview. Align on the computer to enter the room.';
  }
}

function applyRoomAlignment(data) {
  if (data.sessionId !== sessionId) return;
  pendingAlignment = data;
  if (!roomReady) return;
  roomRoot.matrix.copy(roomToXRMatrix(data));
  modelAlignment = data;
  roomStatus.textContent = 'Room aligned with computer. Head movement is live.';
}

function makeView() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(640, 320);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.querySelector('#view').append(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x72879a);
  roomRoot = new THREE.Group(); scene.add(roomRoot);
  updateAnnotations = createHeadsetAnnotations(roomRoot);
  effects = createRoomEffects(roomRoot);
  roomStatus.textContent = 'Loading scanned room and textures...';
  loadHeadsetRoom(roomRoot).then(({ preview, missingTexture }) => {
    roomPreview = preview; roomReady = true;
    roomStatus.textContent = missingTexture ? 'Room loaded with missing textures. Align on the computer.'
      : 'Room preview ready. Align on the computer to enter the room.';
    if (pendingAlignment) applyRoomAlignment(pendingAlignment);
  }).catch((error) => { roomStatus.textContent = `Room loading failed: ${error.message}. Reload to retry.`; });
  scene.add(new THREE.GridHelper(8, 16, 0x75aebd, 0x345261));
  camera = new THREE.PerspectiveCamera(60, 2, 0.05, 100);
  scene.add(camera);
  camera.position.set(0, 1.6, 2.5);
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);
  label = { canvas, texture, text: '' };
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
  sign.position.set(0, 1.6, -2); scene.add(sign);
  renderer.setAnimationLoop((time, frame) => {
    const dt = previousFrameTime === null ? 0 : Math.min(0.05, Math.max(0, (time - previousFrameTime) / 1000));
    previousFrameTime = time;
    if (frame && session && reference) {
      const pose = session.visibilityState === 'visible' ? frame.getViewerPose(reference) : null;
      if (pose && !pose.emulatedPosition) {
        latestHeadY = modelAlignment ? pose.transform.position.y * modelAlignment.scale + modelAlignment.target[1] : 1.6;
        if (!hasPose) { resetTracking(); hasPose = true; }
        if (time - lastSend >= 50) {
          const p = pose.transform.position, q = pose.transform.orientation;
          if (channel?.sendPose({ sessionId, seq: seq++, position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] })) {
            sent++; tracking.textContent = `Sending head poses · ${sent} packets`;
          } else tracking.textContent = 'Connection unavailable. Waiting for relay acknowledgement.';
          lastSend = time;
        }
      } else {
        if (hasPose) channel?.tracking('lost');
        hasPose = false;
        tracking.textContent = session.visibilityState !== 'visible'
          ? `Tracking paused: session ${session.visibilityState}. Close system menus.`
          : !pose ? 'No viewer pose. Look around slowly in a well-lit space.'
            : 'Position is emulated. Waiting for physical head tracking.';
      }
    }
    const text = `${session ? connection.textContent : 'Ready for VR'} | ${roomStatus.textContent} | ${tracking.textContent} | ${effectsStatus.textContent}`;
    if (label.text !== text) {
      label.text = text;
      const ctx = label.canvas.getContext('2d');
      ctx.fillStyle = '#152a3c'; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#74f3c6'; ctx.font = 'bold 44px Arial'; ctx.textAlign = 'center';
      ctx.fillText(roomStatus.textContent, 512, 100, 980);
      ctx.fillStyle = '#ffffff'; ctx.font = '30px Arial';
      ctx.fillText(tracking.textContent, 512, 165, 980);
      ctx.font = '26px Arial';
      ctx.fillText(effectsStatus.textContent, 512, 220, 980);
      label.texture.needsUpdate = true;
    }
    effects.update(dt, latestHeadY);
    effects.beforeView(camera, Boolean(session && modelAlignment));
    renderer.render(scene, camera);
  });
}

function endSession() {
  pendingAlignment = null;
  modelAlignment = null;
  effects?.enableSound(camera, false);
  soundButton.textContent = 'Enable sound'; soundButton.setAttribute('aria-pressed', 'false');
  reference?.removeEventListener('reset', resetTracking);
  reference = null; session = null; hasPose = false;
  channel?.tracking('ended'); channel?.close(); channel = null;
  startButton.disabled = false; stopButton.disabled = true; roomInput.disabled = false;
  tracking.textContent = 'VR ended. Start again and recalibrate on the computer.';
  connection.textContent = 'Not connected';
}

startButton.addEventListener('click', async () => {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(roomInput.value)) {
    support.textContent = 'Pairing code: use 1–32 letters, numbers, underscores or hyphens.'; return;
  }
  startButton.disabled = true; roomInput.disabled = true;
  try {
    // Request directly in the click handler to preserve Safari user activation.
    session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
    session.addEventListener('end', endSession, { once: true });
    makeView();
    channel = connectPoseChannel({ role: 'publisher', room: roomInput.value,
      onEffects(data) {
        effects.apply(data.roomId === '10_17_2026' ? data : { ...data, running: false, fires: [] });
        effectsStatus.textContent = data.roomId === '10_17_2026'
          ? `${data.fires.length} fires | Smoke ${data.running ? 'running' : 'stopped'}`
          : 'Computer is showing the sample room. Select Scanned room to sync effects.';
      },
      onAnnotations: (snapshot) => updateAnnotations(snapshot),
      onAlignment: applyRoomAlignment,
      onStatus: (message) => { connection.textContent = message; } });
    camera.position.set(0, 0, 0);
    await renderer.xr.setSession(session);
    reference = renderer.xr.getReferenceSpace();
    reference.addEventListener('reset', resetTracking);
    resetTracking(); sent = 0;
    stopButton.disabled = false;
    support.textContent = 'VR active. Exit using the Digital Crown or Stop VR.';
  } catch (error) {
    const failedSession = session;
    if (failedSession) await failedSession.end().catch(() => {});
    endSession();
    support.textContent = `Could not start VR: ${error.message || error.name}. Check permission, HTTPS and local-floor support.`;
  }
});
stopButton.addEventListener('click', () => session?.end());
soundButton.addEventListener('click', () => {
  const enabled = soundButton.getAttribute('aria-pressed') !== 'true';
  effects.enableSound(camera, enabled);
  soundButton.setAttribute('aria-pressed', String(enabled));
  soundButton.textContent = enabled ? 'Mute sound' : 'Enable sound';
});

async function checkSupport() {
  if (!window.isSecureContext) { support.textContent = 'Open this page over trusted HTTPS.'; return; }
  if (!navigator.xr) { support.textContent = 'WebXR is unavailable here. Open in Vision Pro Safari.'; return; }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    const response = await fetch('/__eileen/relay');
    const relay = response.ok ? await response.json().catch(() => null) : null;
    if (!relay?.ok) { support.textContent = 'Start the computer server with vite.eileen.config.js, then reload.'; return; }
    startButton.disabled = !supported;
    support.textContent = supported ? 'Immersive VR supported. Choose Start VR and allow the request.'
      : 'This browser does not support immersive VR. Use Vision Pro Safari.';
  } catch (error) { support.textContent = `Compatibility check failed: ${error.message}`; }
}
makeView();
void checkSupport();
