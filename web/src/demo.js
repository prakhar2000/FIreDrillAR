// Mouse-driven live demo on the real scan (Devaj): place fire / exits / blocked doors, run the drill first-person,
// ask the voice coach, watch the wrist heat, get the review. Open https://<ip>:5173/demo.html.
// Reuses the headset pieces: eileen-xr-room.js (scan), effects.js (fire, smoke, signs, bloom), hud.js, drill.js, heat.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadHeadsetRoom } from './eileen-xr-room.js';
import { createXRFire, ExitSign, createFireBloom } from './effects.js';
import { createXRHud } from './hud.js';
import { drill } from './drill.js';
import { connect as connectHeat, send as sendHeat, heatFrom } from './heat.js';

const $ = (s) => document.querySelector(s);
const status = (t) => { $('#status').textContent = t; };

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0c0b);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.02, 200);
scene.add(camera);
const roomRoot = new THREE.Group();
scene.add(roomRoot);
await loadHeadsetRoom(roomRoot);
roomRoot.matrix.identity(); // scan coordinates are metres
roomRoot.updateMatrixWorld(true);
const scanMeshes = [];
roomRoot.traverse((o) => { if (o.isMesh) scanMeshes.push(o); });
const bounds = new THREE.Box3().setFromObject(roomRoot);
const center = bounds.getCenter(new THREE.Vector3());

const ray = new THREE.Raycaster();
ray.set(new THREE.Vector3(center.x, bounds.max.y + 1, center.z), new THREE.Vector3(0, -1, 0));
const FLOOR = ray.intersectObjects(scanMeshes)[0]?.point.y ?? bounds.min.y;

const fire = createXRFire(roomRoot, camera);
const bloom = createFireBloom(renderer, scene, camera, { fire: fire.fire });
bloom.bloom.threshold = 0.92;
bloom.bloom.strength = 0.45;
$('#loading').remove();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(center.x, FLOOR + 0.3, center.z);
camera.position.set(center.x + 8, FLOOR + 8, center.z - 9);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});

// ---------- drill state ----------
const signs = [];      // ExitSign
let start = new THREE.Vector3(4.4, FLOOR, 7);
let tool = null, drillOn = false, done = false, speed = 1, crouch = false, ignited = false;
let yaw = 0, pitch = -0.1, eye = 1.6;
let hud = null, heatOn = true, testUntil = 0, idleSent = false;

const startMarker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.75, 2), toneMapped: false, transparent: true, depthWrite: false }));
roomRoot.add(startMarker);

// glowing chevrons from the start to the nearest open exit
// ponytail: straight line, no pathfinding; the observer's Auto route (desktop.js) does the real grid search
const route = new THREE.Group();
roomRoot.add(route);
const chevronGeo = new THREE.ShapeGeometry(new THREE.Shape([
  new THREE.Vector2(-0.16, -0.1), new THREE.Vector2(0, 0.06), new THREE.Vector2(0.16, -0.1),
  new THREE.Vector2(0.16, 0.0), new THREE.Vector2(0, 0.16), new THREE.Vector2(-0.16, 0.0),
])).rotateX(-Math.PI / 2);
const openExits = () => signs.filter((s) => !s.blocked);
function nearestExit(from) {
  let best = null, d = Infinity;
  for (const s of openExits()) {
    const dd = Math.hypot(s.position.x - from.x, s.position.z - from.z);
    if (dd < d) { d = dd; best = s; }
  }
  return best;
}
function buildRoute() {
  route.clear();
  const exit = nearestExit(start);
  if (!exit) return;
  const a = new THREE.Vector2(start.x, start.z), b = new THREE.Vector2(exit.position.x, exit.position.z);
  const n = Math.max(1, Math.round(a.distanceTo(b) / 0.45));
  const angle = Math.atan2(b.x - a.x, b.y - a.y) + Math.PI;
  for (let k = 1; k < n; k++) {
    const p = a.clone().lerp(b, k / n);
    const m = new THREE.Mesh(chevronGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.25, 2.2, 0.7), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    m.position.set(p.x, FLOOR + 0.03, p.y);
    m.rotation.y = angle;
    m.userData.k = k;
    route.add(m);
  }
}

function placeSign(p, blocked) {
  const s = new ExitSign(new THREE.Vector3(p.x, 0, p.z), blocked);
  s.position.y = Math.max(p.y, FLOOR + 1.1); // above the door, not up at the default 1.9 m (scan floor is below 0)
  roomRoot.add(s.sprite);
  signs.push(s);
  buildRoute();
}
let lastFire = null;
function ignite(p) {
  lastFire = p.clone();
  fire.ignite([p.x, p.y, p.z]);
  ignited = true;
  $('#coachBtn').disabled = false;
}
function setStart(p) { start.set(p.x, FLOOR, p.z); buildRoute(); }

function loadExample() {
  resetAll();
  ignite(new THREE.Vector3(6.2, 0, 2.9));      // the kitchen counter
  placeSign(new THREE.Vector3(3.5, FLOOR + 1.1, -0.5), false);
  placeSign(new THREE.Vector3(3.6, FLOOR + 1.1, 11.6), true);
  setStart(new THREE.Vector3(4.4, FLOOR, 7));
  status('Example loaded: fire on the counter, one open exit, one blocked door. Press Start drill.');
}

// ---------- tools (click on the scan) ----------
const toolHint = {
  fire: 'Click the scan where the fire starts.', exit: 'Click a door or floor spot for an EXIT sign.',
  blocked: 'Click a door to mark it BLOCKED.', start: 'Click the floor where the trainee starts.',
};
function setTool(t) {
  tool = tool === t ? null : t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  status(tool ? toolHint[tool] : 'Drag to orbit, scroll to zoom.');
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, yaw, pitch }; });
addEventListener('pointerup', (e) => {
  const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
  down = null;
  if (!click || drillOn || !tool || e.target !== renderer.domElement) return;
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(scanMeshes)[0];
  if (!hit) return status('That missed the scan. Click on the room.');
  const p = hit.point;
  if (tool === 'fire') { ignite(p); status('Fire placed. Add exits, then Start drill.'); }
  if (tool === 'exit') { placeSign(p, false); status('EXIT marked. The green arrows show the way out.'); }
  if (tool === 'blocked') { placeSign(p, true); status('Door marked BLOCKED.'); }
  if (tool === 'start') { setStart(p); status('Trainee start set.'); }
});
addEventListener('pointermove', (e) => {
  if (!drillOn || !down) return;
  yaw = down.yaw - (e.clientX - down.x) * 0.004;
  pitch = THREE.MathUtils.clamp(down.pitch - (e.clientY - down.y) * 0.004, -1.2, 1.2);
});

// ---------- drill ----------
function makeHud() {
  if (hud) camera.children.filter((c) => c.renderOrder === 1000).forEach((c) => c.removeFromParent());
  hud = createXRHud(camera);
  const panel = camera.children.find((c) => c.renderOrder === 1000);
  panel.position.set(-0.42, -0.24, -1);
  panel.scale.setScalar(0.5);
}
function startDrill() {
  if (drillOn) return stopDrill('Drill stopped.');
  if (!ignited) return status('Place a fire first (or Load example drill).');
  if (!openExits().length) return status('Mark at least one open EXIT first.');
  setTool(null);
  drillOn = true; done = false; crouch = false; eye = 1.6;
  controls.enabled = false;
  camera.fov = 70; camera.updateProjectionMatrix();
  camera.position.set(start.x, FLOOR + eye, start.z);
  const exit = nearestExit(start);
  yaw = Math.atan2(-(exit.position.x - start.x), -(exit.position.z - start.z)); // face the exit
  pitch = -0.1;
  makeHud();
  drill.start();
  $('#review').style.display = 'none';
  $('#drill').firstChild.textContent = 'Stop drill ';
  status('Get out! WASD to walk, drag to look, C to crouch under the smoke.');
  if (heatOn) connectHeat();
}
function stopDrill(msg) {
  drillOn = false;
  controls.enabled = true;
  camera.fov = 50; camera.updateProjectionMatrix();
  camera.position.set(center.x + 8, FLOOR + 8, center.z - 9);
  controls.update();
  camera.children.filter((c) => c.renderOrder === 1000).forEach((c) => { c.visible = false; });
  $('#drill').firstChild.textContent = 'Start drill ';
  if (msg) status(msg);
}
function finish(state) {
  done = true;
  drill.stop(state.escaped ? 'escaped' : 'timeout');
  const st = drill.stats();
  hud.review(st);
  camera.children.filter((c) => c.renderOrder === 1000).forEach((c) => { c.visible = false; }); // the DOM card shows it bigger
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  $('#rvTitle').textContent = state.escaped ? 'Escaped' : 'Out of air';
  $('#rvTitle').style.color = state.escaped ? 'var(--exit)' : 'var(--blocked)';
  $('#rvTime').textContent = mmss(st.time);
  $('#rvOx').textContent = `${Math.round(st.oxygen * 100)}%`;
  $('#rvSmoke').textContent = `${st.smokeTime.toFixed(1)} s`;
  $('#rvLow').textContent = `${Math.round(st.pctLow * 100)}%`;
  $('#review').style.display = 'block';
  status(state.escaped ? 'Safe! The Dots go cool at the exit.' : 'The smoke got you. Stay low next time.');
}
function resetAll() {
  if (drillOn) stopDrill();
  fire.reset();
  signs.splice(0).forEach((s) => s.dispose());
  route.clear();
  ignited = false; done = false;
  drill.stop('reset');
  $('#coachBtn').disabled = true;
  $('#coach').style.display = 'none';
  $('#review').style.display = 'none';
  status('Cleared. Place a fire on the scan, or Load example drill.');
}

// ---------- voice coach: the server's /py/agent (Claude), with a local fallback ----------
const head = new THREE.Vector3(), quat = new THREE.Quaternion();
function localReply(ctx) {
  const exit = nearestExit(head);
  if (!exit) return 'I can\'t see an open exit. Stay low and move away from the fire.';
  const dx = exit.position.x - head.x, dz = exit.position.z - head.z;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const ang = Math.atan2(fwd.x * dz - fwd.z * dx, fwd.x * dx + fwd.z * dz);
  const dir = Math.abs(ang) < 0.5 ? 'straight ahead' : Math.abs(ang) > 2.4 ? 'behind you' : ang > 0 ? 'to your right' : 'to your left';
  const m = Math.max(1, Math.round(Math.hypot(dx, dz)));
  return `The open exit is ${dir}, about ${m} metres away.${ctx.smoke > 0.2 ? ' Stay low, there is smoke.' : ''}`;
}
async function askCoach() {
  if (!ignited) return;
  const ctx = {
    transcript: 'Which way do I go?',
    head: head.toArray(), facing: new THREE.Vector3(0, 0, -1).applyQuaternion(quat).toArray(),
    fires: fire.worldFires().map((v) => v.toArray()),
    exits: openExits().map((s) => [s.position.x, FLOOR, s.position.z]),
    blocked: signs.filter((s) => s.blocked).map((s) => [s.position.x, FLOOR, s.position.z]),
    smoke: lastDepth,
  };
  $('#coach').style.display = 'block';
  $('#coach .text').textContent = '“Which way do I go?” …';
  let reply;
  try {
    const r = await fetch('/py/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx), signal: AbortSignal.timeout(7000) });
    reply = (await r.json()).reply;
  } catch { /* server not reachable: answer locally */ }
  reply ||= localReply(ctx);
  $('#coach .text').textContent = reply;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(reply));
}

// ---------- buttons + keys (e.code, works on any layout) ----------
$('#example').addEventListener('click', loadExample);
$('#drill').addEventListener('click', startDrill);
$('#again').addEventListener('click', () => { $('#review').style.display = 'none'; stopDrill(); fire.reset(); loadExampleKeepLayout(); });
$('#reset').addEventListener('click', resetAll);
$('#coachBtn').addEventListener('click', askCoach);
$('#speed').addEventListener('click', toggleSpeed);
$('#dots').addEventListener('change', (e) => {
  heatOn = e.target.checked;
  if (heatOn) connectHeat(); else sendHeat({ left: 0, right: 0, buzz: false, cool: false });
});
$('#testDots').addEventListener('click', testDots);
function testDots() { $('#dots').checked = heatOn = true; connectHeat(); testUntil = t + 3; }
connectHeat();
// what the server sees: "4 Dot(s), …" or "no Dots (El Jefe plugged in and powered?)"
async function pollDots() {
  let text = 'server unreachable (/py/health)', ok = false;
  try {
    const j = await (await fetch('/py/health', { signal: AbortSignal.timeout(2500) })).json();
    text = j.dots ?? 'server has no Dots driver';
    ok = /Dot\(s\)/.test(text);
  } catch { /* keep the unreachable text */ }
  $('#dotsStatus').textContent = `Dots: ${text}`;
  $('#dotsStatus').style.color = ok ? 'var(--exit)' : 'var(--blocked)';
}
pollDots();
setInterval(pollDots, 3000);
function toggleSpeed() { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('#speed').firstChild.textContent = `Fire ${speed}× `; }
// Run again: relight the same fire spot, keep the signs
function loadExampleKeepLayout() { if (lastFire) ignite(lastFire); startDrill(); }

const keys = {};
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (e.code === 'Digit1') setTool('fire');
  if (e.code === 'Digit2') setTool('exit');
  if (e.code === 'Digit3') setTool('blocked');
  if (e.code === 'Digit4') setTool('start');
  if (e.code === 'KeyE') loadExample();
  if (e.code === 'Space') { e.preventDefault(); startDrill(); }
  if (e.code === 'KeyR') resetAll();
  if (e.code === 'KeyF') toggleSpeed();
  if (e.code === 'KeyQ') askCoach();
  if (e.code === 'KeyT') testDots();
  if (e.code === 'KeyC' && drillOn) crouch = !crouch;
  if (e.code === 'Escape' && drillOn) stopDrill('Drill stopped.');
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------- loop ----------
const clock = new THREE.Timer();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
let lastDepth = 0, t = 0;
renderer.setAnimationLoop((time) => {
  clock.update(time);
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;

  if (drillOn && !done) {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const v = (crouch ? 0.8 : 1.4) * dt;
    if (keys.KeyW || keys.ArrowUp) camera.position.addScaledVector(fwd, v);
    if (keys.KeyS || keys.ArrowDown) camera.position.addScaledVector(fwd, -v);
    if (keys.KeyD || keys.ArrowRight) camera.position.addScaledVector(right, v);
    if (keys.KeyA || keys.ArrowLeft) camera.position.addScaledVector(right, -v);
    eye += ((crouch ? 0.9 : 1.6) - eye) * Math.min(1, dt * 8);
    camera.position.y = FLOOR + eye;
  } else if (!drillOn) controls.update();

  camera.getWorldPosition(head);
  camera.getWorldQuaternion(quat);
  for (let i = 0; i < speed; i++) lastDepth = fire.update(dt, drillOn && !done);
  for (const s of signs) {
    s.update(dt);
    s._ring.position.y = (FLOOR + 0.03 - s.position.y) / s.sprite.scale.y; // ring on the scan floor
  }
  startMarker.position.set(start.x, FLOOR + 0.02, start.z);
  startMarker.visible = !drillOn;
  for (const m of route.children) m.material.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 5 - m.userData.k * 0.7));

  // drill + HUD + wrist heat
  let heat = { left: 0, right: 0 }, buzz = false, cool = false;
  if (drillOn && !done) {
    const state = drill.update(dt, { smokeDepth: lastDepth, head: { x: head.x, y: head.y - FLOOR, z: head.z },
      exits: openExits().map((s) => ({ x: s.position.x, z: s.position.z })) });
    hud.update(state);
    heat = heatFrom(head, quat, fire.worldFires());
    buzz = lastDepth > 0.5;
    if (state.escaped || state.timedOut) finish(state);
  }
  if (done && $('#rvTitle').textContent === 'Escaped') cool = true;
  if (t < testUntil) heat = { left: 1, right: 1 };
  const temp = (h) => (h > 0.05 ? `${(33 + 5 * h).toFixed(1)}°C` : '—');
  $('#hl').style.width = `${heat.left * 100}%`;
  $('#hr').style.width = `${heat.right * 100}%`;
  $('#tl').textContent = cool ? '20°C' : temp(heat.left);
  $('#tr').textContent = cool ? '20°C' : temp(heat.right);
  $('#hstate').textContent = cool ? 'cool pulse' : buzz ? 'BUZZ · smoke' : heat.left + heat.right > 0.05 ? 'warming' : 'idle';
  $('#hstate').style.color = cool ? 'var(--cool)' : buzz ? 'var(--blocked)' : 'var(--fg)';
  const active = drillOn || cool || t < testUntil;
  if (heatOn && active) { sendHeat({ ...heat, buzz, cool }); idleSent = false; }
  else if (heatOn && !idleSent) { sendHeat({ left: 0, right: 0, buzz: false, cool: false }); idleSent = true; } // pads off

  bloom.render();
});
window.demo = { loadExample, startDrill, askCoach, camera, keys, setTool }; // for scripted checks
