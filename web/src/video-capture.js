// Footage source for the pitch video (video/, Devaj). Reuses the real scan, fire, smoke, signs and HUD;
// video/capture/record.cjs steps it frame by frame (window.cap) so the clips come out at an exact 30 fps.
import * as THREE from 'three';
import { loadHeadsetRoom } from './eileen-xr-room.js';
import { createXRFire, ExitSign, createFireBloom } from './effects.js';
import { createXRHud } from './hud.js';
import { drill } from './drill.js';

let simTime = 0;
performance.now = () => simTime * 1000; // the heat shimmer reads this clock

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.02, 200);
scene.add(camera);
const roomRoot = new THREE.Group();
scene.add(roomRoot);
const { missingTexture } = await loadHeadsetRoom(roomRoot);
roomRoot.matrix.identity(); // scan coordinates are metres
roomRoot.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(roomRoot);

const fire = createXRFire(roomRoot, camera);
const bloom = createFireBloom(renderer, scene, camera, { fire: fire.fire });
let hud = null;
const signs = [];
const route = new THREE.Group();
roomRoot.add(route);
let running = false;
let speed = 1;
let routeAlpha = 0;

const RING_LIFT = 0.03;
const floorY = () => fire.fire.sim.floorY ?? bounds.min.y;

// glowing chevrons along the escape route (values > 1 so the bloom picks them up)
const chevronGeo = new THREE.ShapeGeometry(new THREE.Shape([
  new THREE.Vector2(-0.16, -0.1), new THREE.Vector2(0, 0.06), new THREE.Vector2(0.16, -0.1),
  new THREE.Vector2(0.16, 0.0), new THREE.Vector2(0, 0.16), new THREE.Vector2(-0.16, 0.0),
])).rotateX(-Math.PI / 2);

function setRoute(points) {
  route.clear();
  const y = floorY() + 0.03;
  for (let i = 0; i < points.length - 1; i++) {
    const a = new THREE.Vector2(...points[i]), b = new THREE.Vector2(...points[i + 1]);
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.round(len / 0.45));
    const angle = Math.atan2(b.x - a.x, b.y - a.y);
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, (k + 0.5) / n);
      const m = new THREE.Mesh(chevronGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.25, 2.2, 0.7), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }));
      m.position.set(p.x, y, p.y);
      m.rotation.y = angle + Math.PI; // shape points along -z after rotateX; turn it toward b
      m.userData.order = route.children.length;
      route.add(m);
    }
  }
}

function render() {
  const t = simTime;
  for (const m of route.children) {
    const wave = 0.5 + 0.5 * Math.sin(t * 5 - m.userData.order * 0.7);
    m.material.opacity = routeAlpha * (0.35 + 0.65 * wave);
  }
  bloom.render();
}

window.cap = {
  missingTexture,
  fx: { fire, bloom, roomRoot, camera, scene },
  info: () => ({ min: bounds.min.toArray(), max: bounds.max.toArray(), floorY: floorY(), ceilingY: fire.fire.ceilingY }),
  look(pos, target, fov = 50) {
    camera.position.fromArray(pos);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.lookAt(new THREE.Vector3().fromArray(target));
  },
  ignite(p) { fire.ignite(p); running = true; },
  exit(p, blocked = false) {
    const s = new ExitSign(new THREE.Vector3(...p), blocked);
    s.position.y = p[1]; // scan floor is below 0, keep the given height
    roomRoot.add(s.sprite);
    signs.push(s);
  },
  route: setRoute,
  routeAlpha(a) { routeAlpha = a; },
  speed(k) { speed = k; },
  hud(on, pos = [-0.34, -0.2, -1], scale = 0.55) {
    if (on && !hud) { hud = createXRHud(camera); drill.start(); }
    const panel = camera.children.find((c) => c.renderOrder === 1000);
    if (panel) { panel.visible = on; panel.position.fromArray(pos); panel.scale.setScalar(scale); }
  },
  smoke(on) { fire.smoke.group.visible = on; fire.smoke._hidden = !on; },
  review() { drill.stop('escaped'); hud?.review(drill.stats()); },
  hudPanel: () => camera.children.find((c) => c.renderOrder === 1000),
  step(dt = 1 / 30) {
    simTime += dt;
    let depth = 0;
    const sub = Math.max(1, Math.round(speed));
    for (let i = 0; i < sub; i++) depth = fire.update(dt * speed / sub, running);
    for (const s of signs) {
      s.update(dt);
      s._ring.position.y = (floorY() + RING_LIFT - s.position.y) / s.sprite.scale.y; // scan floor is below y = 0
    }
    if (hud) {
      const head = camera.getWorldPosition(new THREE.Vector3());
      head.y -= floorY(); // drill expects height above the floor
      hud.update(drill.update(dt, { smokeDepth: depth, head, exits: [] }));
    }
    render();
    return depth;
  },
  render,
};
render();
window.capReady = true;
