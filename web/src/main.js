import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { setStatus } from './hud.js';
import { Fire, Smoke, ExitSign, createFireBloom } from './effects.js';
import { loadScanMesh, start as startRoom } from './room.js';
import { start as startDesktop } from './desktop.js';
import { drill } from './drill.js';
import { parseCommand, start as startVoice } from './voice.js';
import { connect as connectHeat } from './heat.js';

const fires = [];
const exits = [];
let drillOn = false;
let ceilingY = 0.7;
let floorY = -1.1;

export function addFire(pos) {
  const fire = new Fire(pos);
  if (fire.group.parent !== scene) scene.add(fire.group);
  fires.push(fire);
  if (!drillOn) {
    drillOn = true;
    smoke.start(ceilingY);
    fire.startSound();
  }
  return fire;
}

export function addExit(pos, blocked = false) {
  const exit = new ExitSign(pos, blocked);
  scene.add(exit.sprite);
  exits.push(exit);
  return exit;
}

export function startDrill() {
  drill.start();
  if (!fires.length) return;
  drillOn = true;
  smoke.start(ceilingY);
  fires[0].startSound();
}

export function stopDrill(reason) {
  drill.stop(reason);
  drillOn = false;
  smoke.stop();
  fires[0]?.stopSound();
}

export function resetDrill() {
  clearAll();
}

export function clearAll() {
  for (const fire of fires) fire.dispose();
  fires.length = 0;
  for (const exit of exits) exit.sprite?.removeFromParent();
  exits.length = 0;
  drillOn = false;
  smoke.reset();
}

startRoom();
startDesktop();
startVoice();
connectHeat();
parseCommand('');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x111111, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(ARButton.createButton(renderer, {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking', 'plane-detection', 'mesh-detection'],
}));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(12, 6, 18);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(4, 0, 5);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 0.55);
sun.position.set(8, 12, 6);
scene.add(sun);

const smoke = new Smoke(scene, camera, { size: 18, minY: -0.7, headHeight: 0.3 });
const bloom = createFireBloom(renderer, scene, camera);

const raycaster = new THREE.Raycaster();
const hitMeshes = [];
let roomBox = null;

function pointOnMesh(x, z) {
  if (!hitMeshes.length || !roomBox) return null;
  raycaster.set(new THREE.Vector3(x, roomBox.max.y + 2, z), new THREE.Vector3(0, -1, 0));
  const hits = raycaster.intersectObjects(hitMeshes, false);
  if (!hits.length) return null;
  const point = hits[hits.length - 1].point.clone();
  point.y += 0.04;
  return point;
}

function placeFire(point) {
  addFire(point);
  setStatus('Fire placed · tap Start AR on the Quest · click to add another · R to clear');
}

renderer.xr.addEventListener('sessionstart', () => {
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  controls.enabled = false;
  setStatus('In AR · you are standing in the scan · look for the fire');
});
renderer.xr.addEventListener('sessionend', () => {
  scene.background = new THREE.Color(0x111111);
  renderer.setClearColor(0x111111, 1);
  controls.enabled = true;
  setStatus('Left AR · tap Start AR to enter again');
});

setStatus('Loading room scan…');

loadScanMesh()
  .then((mesh) => {
    mesh.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) mat.side = THREE.DoubleSide;
      hitMeshes.push(child);
    });
    scene.add(mesh);
    const bounds = new THREE.Box3().setFromObject(mesh);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    mesh.position.set(-center.x, -bounds.min.y, -center.z);
    roomBox = new THREE.Box3().setFromObject(mesh);
    floorY = 0;
    ceilingY = roomBox.max.y;
    smoke.minY = 0.45;
    smoke.headHeight = 1.1;
    smoke.setCenter(0, 0);
    const span = Math.max(size.x, size.y, size.z);
    controls.target.set(0, ceilingY * 0.35, 0);
    camera.position.set(size.x * 0.2, ceilingY + span * 0.35, span * 0.7);
    camera.far = span * 8;
    camera.updateProjectionMatrix();
    controls.update();

    const seeds = [
      pointOnMesh(0, 0),
      pointOnMesh(0, -size.z * 0.22),
      pointOnMesh(size.x * 0.18, size.z * 0.15),
    ].filter(Boolean);
    for (const point of seeds) addFire(point);
    setStatus(seeds.length
      ? 'Fire is on the scan · tap Start AR on the Quest · click to add fire · R to clear'
      : 'Room loaded · tap Start AR on the Quest');
  })
  .catch((err) => {
    console.error(err);
    setStatus('Room scan failed to load');
  });

const pointer = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  down = { x: event.clientX, y: event.clientY };
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
    down = null;
    return;
  }
  down = null;
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(hitMeshes, false)[0];
  if (hit) placeFire(hit.point);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyR') clearAll();
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const inAR = renderer.xr.isPresenting;
  if (!inAR) controls.update();
  for (const fire of fires) fire.update(dt, drillOn);
  for (const exit of exits) exit.update?.(dt);
  const headY = inAR ? renderer.xr.getCamera().position.y : 0.3;
  smoke.update(dt, headY, fires);
  bloom.render();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
