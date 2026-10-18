import * as THREE from 'three';
import { connectPoseChannel } from './eileen-pose-channel.js';
import { loadHeadsetRoom, roomToXRMatrix } from './eileen-xr-room.js';
import { createHeadsetAnnotations } from './eileen-xr-annotations.js';
import { createXRFire } from './effects.js';
import { createXRHud } from './hud.js';
import { drill } from './drill.js';
import { startAgent } from './voice.js';
import { connect as connectHeat, send as sendHeat, heatFrom } from './heat.js';

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
const roomStatus = document.querySelector('#model-status');

// Drill: the observer's `fire` marker ignites; each frame feeds fire → drill → HUD, heat and the voice agent.
let fire, hud, items = [], firedAt = '', drillOn = false, lastTime = 0;
const head = new THREE.Vector3(), headQuat = new THREE.Quaternion();
const worldPoints = (type) => items.filter((item) => item.type === type)
  .map((item) => roomRoot.localToWorld(new THREE.Vector3().fromArray(item.position)));

function onSnapshot(snapshot) {
  if (snapshot?.roomId !== '10_17_2026') return;
  items = snapshot.items;
  const marker = items.find((item) => item.type === 'fire');
  const key = marker ? marker.position.join() : '';
  if (key === firedAt) return;
  firedAt = key;
  fire.reset();
  drillOn = !!marker;
  if (marker) { fire.ignite(marker.position); drill.start(); }
}

function stepDrill(dt, smokeDepth) {
  const state = drill.update(dt, { smokeDepth, head, exits: worldPoints('exit') });
  hud.update(state);
  const done = state.escaped || state.timedOut;
  sendHeat(done ? { left: 0, right: 0, buzz: false, cool: true }
    : { ...heatFrom(head, headQuat, fire.worldFires()), buzz: smokeDepth > 0.5, cool: false });
  if (!done) return;
  drillOn = false;
  drill.stop(state.escaped ? 'escaped' : 'timeout');
  hud.review(drill.stats());
}

// Test without the observer: firedrill.ignite([x, y, z]) in the console (scan coordinates).
window.firedrill = { ignite: (position) => onSnapshot({ roomId: '10_17_2026',
  items: [...items.filter((item) => item.type !== 'fire'), { type: 'fire', position }] }) };

const agentContext = () => ({
  head: head.toArray(),
  facing: new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat).toArray(),
  fires: fire.worldFires().map((v) => v.toArray()),
  exits: worldPoints('exit').map((v) => v.toArray()),
  blocked: worldPoints('blocked').map((v) => v.toArray()),
});

function resetTracking() {
  pendingAlignment = null;
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
  roomStatus.textContent = 'Loading scanned room and textures...';
  loadHeadsetRoom(roomRoot).then(({ preview, missingTexture }) => {
    roomPreview = preview; roomReady = true;
    roomStatus.textContent = missingTexture ? 'Room loaded with missing textures. Align on the computer.'
      : 'Room preview ready. Align on the computer to enter the room.';
    if (pendingAlignment) applyRoomAlignment(pendingAlignment);
  }).catch((error) => { roomStatus.textContent = `Room loading failed: ${error.message}. Reload to retry.`; });
  scene.add(new THREE.GridHelper(8, 16, 0x75aebd, 0x345261));
  camera = new THREE.PerspectiveCamera(60, 2, 0.05, 100);
  camera.position.set(0, 1.6, 2.5);
  scene.add(camera); // so HUD children of the camera render
  fire = createXRFire(roomRoot, camera);
  hud = createXRHud(camera);
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);
  label = { canvas, texture, text: '' };
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
  sign.position.set(0, 1.6, -2); scene.add(sign);
  renderer.setAnimationLoop((time, frame) => {
    const dt = Math.min(0.1, (time - lastTime) / 1000 || 0); lastTime = time;
    const smokeDepth = fire.update(dt, drillOn);
    if (frame && session && reference) {
      const pose = session.visibilityState === 'visible' ? frame.getViewerPose(reference) : null;
      if (pose && !pose.emulatedPosition) {
        if (!hasPose) { resetTracking(); hasPose = true; }
        head.copy(pose.transform.position); headQuat.copy(pose.transform.orientation);
        if (drillOn) stepDrill(dt, smokeDepth);
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
    const text = `${session ? connection.textContent : 'Ready for VR'} | ${roomStatus.textContent} | ${tracking.textContent}`;
    if (label.text !== text) {
      label.text = text;
      const ctx = label.canvas.getContext('2d');
      ctx.fillStyle = '#152a3c'; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#74f3c6'; ctx.font = 'bold 44px Arial'; ctx.textAlign = 'center';
      ctx.fillText(roomStatus.textContent, 512, 100, 980);
      ctx.fillStyle = '#ffffff'; ctx.font = '30px Arial';
      ctx.fillText(tracking.textContent, 512, 165, 980);
      label.texture.needsUpdate = true;
    }
    renderer.render(scene, camera);
  });
}

function endSession() {
  pendingAlignment = null;
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
      onAnnotations: (snapshot) => { updateAnnotations(snapshot); onSnapshot(snapshot); },
      onAlignment: applyRoomAlignment,
      onStatus: (message) => { connection.textContent = message; } });
    camera.position.set(0, 0, 0);
    await renderer.xr.setSession(session);
    reference = renderer.xr.getReferenceSpace();
    reference.addEventListener('reset', resetTracking);
    resetTracking(); sent = 0;
    connectHeat();
    startAgent(agentContext);
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
