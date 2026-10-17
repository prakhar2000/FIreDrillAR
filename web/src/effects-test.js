// Test page for effects.js (Varnika). Open /effects-test.html.
// Desktop: fake room (or data/room.json via /api/room), WASD + drag, C to crouch.
// Quest: tap "START AR", pinch: right hand = fire, left hand = exit / blocked sign.
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { Fire, Smoke, ExitSign, FireSpread } from './effects.js';

let CEILING = 2.6;

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x15171c, 1);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer, {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking'],
}));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 60);
camera.position.set(0, 1.6, 2.8);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- room (hidden in AR) ----------
const room = new THREE.Group();
scene.add(room);
room.add(new THREE.HemisphereLight(0xdde3ff, 0x2a2420, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(3, 5, 2);
room.add(sun);
const solids = [];

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z).toArray();
const rect = (w, d) => [[-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2]];
const boxVerts = (w, h, d) => {
  const v = [];
  for (const x of [-w / 2, w / 2]) for (const y of [0, h]) for (const z of [-d / 2, d / 2]) v.push(x, y, z);
  return v;
};

// Fake room in the README room.json format (horizontal planes: polygon in the x/z plane)
const FAKE_ROOM = {
  version: 1,
  surfaces: [
    { kind: 'plane', label: 'floor', matrix: T(0, 0, 0), polygon: rect(8, 8) },
    { kind: 'plane', label: 'ceiling', matrix: T(0, 2.6, 0), polygon: rect(8, 8) },
    { kind: 'plane', label: 'wall', matrix: T(0, 0, -4), polygon: [[-4, 0, 0], [4, 0, 0], [4, 2.6, 0], [-4, 2.6, 0]] },
    { kind: 'plane', label: 'wall', matrix: T(0, 0, 4), polygon: [[-4, 0, 0], [4, 0, 0], [4, 2.6, 0], [-4, 2.6, 0]] },
    { kind: 'plane', label: 'wall', matrix: T(-4, 0, 0), polygon: [[0, 0, -4], [0, 0, 4], [0, 2.6, 4], [0, 2.6, -4]] },
    { kind: 'plane', label: 'wall', matrix: T(4, 0, 0), polygon: [[0, 0, -4], [0, 0, 4], [0, 2.6, 4], [0, 2.6, -4]] },
    { kind: 'plane', label: 'table', matrix: T(0, 0.75, -1.5), polygon: rect(1.2, 0.7) },
    { kind: 'mesh', label: 'couch', matrix: T(2.3, 0, -1.4), vertices: boxVerts(1.8, 0.45, 0.8), indices: [] },
    { kind: 'plane', label: 'desk', matrix: T(-2.3, 0.75, -2.2), polygon: rect(1.0, 0.6) },
    { kind: 'plane', label: 'door', matrix: T(-3.95, 0, 1.0), polygon: [[0, 0, -0.45], [0, 2, -0.45], [0, 2, 0.45], [0, 0, 0.45]] },
    { kind: 'plane', label: 'door', matrix: T(3.95, 0, 1.5), polygon: [[0, 0, -0.45], [0, 2, -0.45], [0, 2, 0.45], [0, 0, 0.45]] },
  ],
};

const COLORS = { floor: 0x57534e, table: 0x8b5a2b, couch: 0x3f5f8a, desk: 0x6b4423, door: 0x2e7d32, wall: 0x78716c };

// Draw any room.json surface as a solid box around its points (good enough to click on)
function buildRoom(data) {
  room.children.filter((c) => c.isMesh).forEach((m) => { m.geometry.dispose(); room.remove(m); });
  solids.length = 0;
  for (const s of data.surfaces || []) {
    const label = (s.label || '').toLowerCase();
    if (label === 'ceiling') {
      const m = new THREE.Matrix4().fromArray(s.matrix || T(0, 2.6, 0));
      CEILING = new THREE.Vector3().setFromMatrixPosition(m).y || 2.6;
      continue;
    }
    const pts = [];
    const src = s.polygon ?? s.vertices ?? [];
    const m = new THREE.Matrix4();
    if (s.matrix?.length === 16) m.fromArray(s.matrix);
    if (typeof src[0] === 'number') for (let i = 0; i + 2 < src.length; i += 3) pts.push(new THREE.Vector3(src[i], src[i + 1], src[i + 2]));
    else for (const q of src) pts.push(Array.isArray(q) ? new THREE.Vector3(...q) : new THREE.Vector3(q.x, q.y, q.z));
    if (!pts.length) continue;
    const box = new THREE.Box3();
    pts.forEach((p) => box.expandByPoint(p.applyMatrix4(m)));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // flat furniture planes become solid boxes down to the floor
    if (label !== 'floor' && size.y < 0.05 && box.max.y > 0.1) { size.y = box.max.y; center.y = box.max.y / 2; }
    size.x = Math.max(size.x, 0.04); size.y = Math.max(size.y, 0.02); size.z = Math.max(size.z, 0.04);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshStandardMaterial({ color: COLORS[label] ?? COLORS.wall, roughness: 0.9 }),
    );
    mesh.position.copy(center);
    mesh.name = label;
    room.add(mesh);
    solids.push(mesh);
  }
  spread.setSurfaces(data.surfaces || []);
}

// ---------- effects ----------
const smoke = new Smoke(scene, camera); // adds itself + head fog + audio listener
const fires = [];
const signs = [];
let drillRunning = false;

function addFire(pos) {
  const f = new Fire(pos);
  scene.add(f.group);
  fires.push(f);
  if (drillRunning) f.startSound();
  return f;
}
function addSign(pos, blocked) {
  const s = new ExitSign(pos, blocked);
  scene.add(s.sprite);
  signs.push(s);
}
function startDrill() {
  if (!fires.length) { log('Place a fire first (key 1, then click).'); return; }
  drillRunning = true;
  smoke.start(CEILING);
  fires.forEach((f) => f.startSound());
  log('Drill running: crouch with C to stay under the smoke.');
}
function resetAll() {
  drillRunning = false;
  fires.splice(0).forEach((f) => f.dispose());
  signs.splice(0).forEach((s) => s.dispose());
  smoke.reset();
  spread.reset();
  log('');
}

const spread = new FireSpread({
  interval: 12,
  onSpread: (pos, surface) => { addFire(pos); log(`Fire spread to the ${surface.label}!`); },
});

buildRoom(FAKE_ROOM);
fetch('/api/room')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => { if (data?.surfaces?.length) { buildRoom(data); log('Loaded the real room from data/room.json'); } })
  .catch(() => {});

// ---------- desktop controls ----------
let tool = 'fire';
let crouch = false;
let yaw = 0, pitch = -0.15;
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Digit1') tool = 'fire';
  if (e.code === 'Digit2') tool = 'exit';
  if (e.code === 'Digit3') tool = 'blocked';
  if (e.code === 'KeyC') crouch = !crouch;
  if (e.code === 'Space') { e.preventDefault(); startDrill(); }
  if (e.code === 'KeyR') resetAll();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, yaw, pitch }; });
addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) place(e);
  down = null;
});
addEventListener('pointermove', (e) => {
  if (!down) return;
  yaw = down.yaw - (e.clientX - down.x) * 0.004;
  pitch = THREE.MathUtils.clamp(down.pitch - (e.clientY - down.y) * 0.004, -1.4, 1.4);
});

const ray = new THREE.Raycaster();
function place(e) {
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(solids)[0];
  if (!hit) return;
  if (tool === 'fire') addFire(hit.point);
  else addSign(hit.point, tool === 'blocked');
}

// ---------- AR ----------
renderer.xr.addEventListener('sessionstart', () => {
  room.visible = false;
  renderer.setClearColor(0x000000, 0);
});
renderer.xr.addEventListener('sessionend', () => {
  room.visible = true;
  renderer.setClearColor(0x15171c, 1);
});
const _fwd = new THREE.Vector3();
for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  scene.add(ctrl);
  ctrl.addEventListener('connected', (e) => { ctrl.userData.hand = e.data.handedness; });
  ctrl.addEventListener('select', () => {
    const xrCam = renderer.xr.getCamera();
    _fwd.set(0, 0, -1).applyQuaternion(xrCam.quaternion).setY(0).normalize();
    const p = xrCam.position.clone().addScaledVector(_fwd, 1.2);
    if (ctrl.userData.hand === 'left') addSign(p, signs.length % 2 === 1);
    else {
      addFire(p.setY(0.75));
      if (!drillRunning) startDrill();
    }
  });
}

// ---------- HUD ----------
const statsEl = document.getElementById('stats');
const logEl = document.getElementById('log');
function log(msg) { logEl.textContent = msg; }

// ---------- loop ----------
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
let fps = 60;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const inXR = renderer.xr.isPresenting;

  if (!inXR) {
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const speed = 1.6 * dt;
    if (keys.KeyW) camera.position.addScaledVector(fwd, speed);
    if (keys.KeyS) camera.position.addScaledVector(fwd, -speed);
    if (keys.KeyD) camera.position.addScaledVector(right, speed);
    if (keys.KeyA) camera.position.addScaledVector(right, -speed);
    const targetY = crouch ? 0.9 : 1.6;
    camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * 8);
  }

  const headY = inXR ? renderer.xr.getCamera().position.y : camera.position.y;
  for (const f of fires) f.update(dt, drillRunning);
  const depth = smoke.update(dt, headY, fires);
  for (const s of signs) s.update(dt);
  if (drillRunning) spread.update(dt, fires);

  statsEl.innerHTML =
    `Tool: <b>${tool}</b> · ${Math.round(fps)} FPS<br>` +
    `Head ${headY.toFixed(2)} m${crouch ? ' (crouched)' : ''} · fires ${fires.length}<br>` +
    `Smoke bottom ${smoke.group.visible ? smoke.bottom.toFixed(2) + ' m' : 'off'} · depth <b>${depth.toFixed(2)}</b>`;

  renderer.render(scene, camera);
});
