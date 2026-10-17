import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setStatus } from './hud.js';
import { Fire, Smoke, ExitSign } from './effects.js';
import { loadScanMesh, start as startRoom } from './room.js';
import { start as startDesktop } from './desktop.js';
import { drill } from './drill.js';
import { parseCommand, start as startVoice } from './voice.js';
import { connect as connectHeat } from './heat.js';

const fires = [];
const exits = [];

export function addFire(pos) {
  const fire = new Fire(pos);
  fires.push(fire);
  return fire;
}

export function addExit(pos, blocked = false) {
  const exit = new ExitSign(pos, blocked);
  exits.push(exit);
  return exit;
}

export function startDrill() {
  drill.start();
}

export function stopDrill(reason) {
  drill.stop(reason);
}

export function resetDrill() {}

export function clearAll() {
  fires.length = 0;
  exits.length = 0;
}

startRoom();
startDesktop();
startVoice();
connectHeat();
new Smoke(null, null);
parseCommand('');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(12, 6, 18);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(4, 0, 5);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(8, 12, 6);
scene.add(sun);

setStatus('Loading room scan…');

loadScanMesh()
  .then((mesh) => {
    mesh.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) mat.side = THREE.DoubleSide;
    });
    scene.add(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    const grid = new THREE.GridHelper(Math.ceil(span), 12, 0x555555, 0x2a2a2a);
    grid.position.set(center.x, box.min.y, center.z);
    scene.add(grid);
    controls.target.copy(center);
    camera.position.set(center.x + size.x * 0.15, center.y + span * 0.55, center.z + span * 0.7);
    camera.far = span * 8;
    camera.updateProjectionMatrix();
    controls.update();
    setStatus(`Room loaded · ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m · drag to orbit`);
  })
  .catch((err) => {
    console.error(err);
    setStatus('Room scan failed to load');
  });

function frame() {
  requestAnimationFrame(frame);
  controls.update();
  renderer.render(scene, camera);
}
frame();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
