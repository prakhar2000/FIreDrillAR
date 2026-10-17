import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { connectPoseChannel } from './eileen-pose-channel.js';
import { createAlignment, alignPose } from './eileen-pose-alignment.js';
import scanObjUrl from '../../10_17_2026/10_17_2026.obj?url';
import scanMtlUrl from '../../10_17_2026/10_17_2026.mtl?url';
import scanTextureOne from '../../10_17_2026/textures/dd3d245ca8809c56baa2936ab44c0a87.jpg?url';
import scanTextureTwo from '../../10_17_2026/textures/ea6461fa5f57fcf8e26ee4fe903ea979.jpg?url';

/**
 * Eileen's observer prototype: sample room + head-position monitor.
 * start() works with the current scaffold. For integration, pass
 * { scene, camera, renderer } and call update(dt) from the shared loop.
 * updateHeadPose({ position: [x,y,z], quaternion: [x,y,z,w] }) accepts
 * meters in the ROOM frame: +Y up, identity rotation looks toward -Z.
 * The sender must align its XR reference space with this room first.
 * Scan assets are bundled from the original 10_17_2026 folder; preserve it
 * when sharing this module. Original model coordinates and scale are retained.
 * The initial floor is estimated; click a floor point to set the simulated
 * start and floor height. Headset coordinates require explicit alignment.
 * Progress: textured OBJ / sample room / simulated pose / receiver API implemented;
 * manual exit / blocked markers and route waypoints can be drawn and exported.
 * Auto route builds a conservative floor grid and searches toward marked exits.
 * Scan units and floor estimates are unverified; generated routes are drafts.
 * These annotations are local demo overlays, not the shared scenario exits.
 * Vision Pro pose relay + yaw/translation/scale calibration implemented.
 * Use vite.eileen.config.js for the development WebSocket relay.
 */
let active;
const UP = new THREE.Vector3(0, 1, 0);
const validArray = (value, size) => Array.isArray(value)
  && value.length === size && value.every(Number.isFinite);

function box(parent, size, position, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function label(parent, text, position, color = '#dce8f3') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#142333';
  ctx.fillRect(0, 0, 512, 96);
  ctx.font = 'bold 40px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
  sprite.position.set(...position);
  sprite.scale.set(1.7, 0.32, 1);
  parent.add(sprite);
}

function createRoom(root) {
  // Six by four meters. Low walls intentionally expose the interior.
  box(root, [6, 0.12, 4], [0, -0.06, 0], 0x263b4e);
  box(root, [6, 0.5, 0.12], [0, 0.25, -2], 0x8093a5);
  box(root, [0.12, 0.5, 4], [-3, 0.25, 0], 0x8093a5);
  box(root, [0.12, 0.5, 4], [3, 0.25, 0], 0x8093a5);
  // Door opening on the +Z wall.
  box(root, [4, 0.5, 0.12], [-1, 0.25, 2], 0x8093a5);
  box(root, [0.8, 0.5, 0.12], [2.6, 0.25, 2], 0x8093a5);
  box(root, [1.2, 0.025, 0.35], [1.6, 0.015, 1.85], 0x47d9a4);
  label(root, 'DOOR', [1.6, 0.75, 2], '#74f3c6');
  box(root, [1.5, 0.12, 0.8], [-0.8, 0.75, -0.45], 0xccaa7e);
  for (const x of [-1.4, -0.2]) {
    for (const z of [-0.72, -0.18]) {
      box(root, [0.08, 0.7, 0.08], [x, 0.35, z], 0x687b8c);
    }
  }
  label(root, 'TABLE', [-0.8, 1.2, -0.45]);
  box(root, [1.5, 0.4, 0.65], [1.8, 0.2, -1.35], 0x557b97);
  box(root, [1.5, 0.6, 0.12], [1.8, 0.55, -1.65], 0x557b97);
  const points = [];
  for (let x = -3; x <= 3; x++) points.push(x, 0.008, -2, x, 0.008, 2);
  for (let z = -2; z <= 2; z++) points.push(-3, 0.008, z, 3, 0.008, z);
  root.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)),
    new THREE.LineBasicMaterial({ color: 0x577086, transparent: true, opacity: 0.45 }),
  ));
  label(root, '-Z / FORWARD', [0, 0.85, -2]);
  label(root, '+X', [3, 0.85, 0]);
}

function releaseObjects(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      if (material) { materials.add(material); if (material.map) textures.add(material.map); }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function redrawAnnotations(state) {
  const group = state.annotations;
  releaseObjects(group);
  group.clear();
  const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
  const waypoints = [];
  for (const item of items) {
    const position = new THREE.Vector3().fromArray(item.position);
    const route = item.type === 'waypoint';
    const blocked = item.type === 'blocked';
    const color = blocked ? 0xff6262 : 0x55f0ad;
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(route ? 0.08 : 0.24,
      route ? 0.08 : 0.24, 0.035, 24), new THREE.MeshBasicMaterial({ color }));
    marker.position.copy(position).addScaledVector(UP, 0.06);
    group.add(marker);
    if (route) {
      waypoints.push(position.clone().addScaledVector(UP, 0.09));
    } else {
      label(group, blocked ? 'BLOCKED' : 'EXIT',
        [position.x, position.y + 0.65, position.z], blocked ? '#ff9090' : '#74f3c6');
    }
  }
  if (waypoints.length > 1) {
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(waypoints),
      new THREE.LineBasicMaterial({ color: 0x55f0ad })));
    for (let i = 1; i < waypoints.length; i++) {
      const direction = waypoints[i].clone().sub(waypoints[i - 1]);
      const length = direction.length();
      if (length < 0.05) continue;
      direction.normalize();
      const count = Math.min(30, Math.max(1, Math.ceil(length / 0.8)));
      const arrowLength = Math.min(0.45, length / count * 0.75);
      for (let j = 0; j < count; j++) {
        const origin = waypoints[i - 1].clone().addScaledVector(direction, (j + 0.15) * length / count);
        group.add(new THREE.ArrowHelper(direction, origin, arrowLength, 0x55f0ad,
          Math.min(0.15, arrowLength * 0.4), Math.min(0.14, arrowLength * 0.35)));
      }
    }
  }
  // Overlay markers stay readable on noisy scan geometry. Segments are manually
  // drawn and have no obstacle validation; visibility is not proof of clearance.
  group.traverse((object) => {
    if (object.material) { object.material.depthTest = false; object.renderOrder = 4; }
  });
  const exits = items.filter((item) => item.type === 'exit').length;
  syncAnnotations(state);
  const blocked = items.filter((item) => item.type === 'blocked').length;
  state.panel.querySelector('[data-layout]').textContent =
    `Marked exits: ${exits} · Blocked: ${blocked} · Route points: ${waypoints.length}${items.some((item) => item.source === 'geometry-draft') ? ' · Automatically generated draft' : ''}`;
}

function syncAnnotations(state) {
  state.poseChannel?.sendAnnotations?.({ roomId: '10_17_2026',
    items: state.scan?.model.visible ? state.layouts.scan : [] });
}

function invalidateAutoRoute(state) {
  const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].source === 'geometry-draft') items.splice(i, 1);
  }
  redrawAnnotations(state);
}

function setAnnotationTool(state, tool = null) {
  state.annotationTool = tool;
  state.pickingSpawn = false;
  state.panel.querySelector('[data-action="spawn"]').textContent = 'Set start on floor';
  for (const button of state.panel.querySelectorAll('[data-mark]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mark === tool));
    button.style.background = button.dataset.mark === tool ? '#22694f' : '#263b4e';
  }
  state.panel.querySelector('[data-edit]').textContent = tool === 'exit'
    ? 'Click the floor at a known exit. Choose another tool or press Esc when done.'
    : tool === 'blocked' ? 'Click the floor at a blocked passage. Press Esc when done.'
      : tool === 'waypoint' ? 'Click floor points in travel order, including turns around obstacles and the exit. Finish route or Esc ends drawing.'
        : 'Manual demo annotations only; routes are not checked for obstacles. Export before refreshing to keep a copy.';
}

/** Geometry-only draft planning; requires user-supplied exit positions.
 * Missing floor and geometry in the standing-height band are impassable.
 * Four-neighbor search never cuts diagonally between occupied cells.
 */
export function planRoomRoute({ surface, bounds, floorY, start, exits, blocked = [] }) {
  if (!exits.length) return { error: 'Mark at least one known exit first.' };
  const step = 0.2;
  const width = Math.ceil((bounds.max.x - bounds.min.x) / step);
  const depth = Math.ceil((bounds.max.z - bounds.min.z) / step);
  const total = width * depth;
  if (!total || total > 40000) return { error: 'Room scale is too large for this demo. Verify model units first.' };
  const floor = new Uint8Array(total), obstacles = new Uint8Array(total);
  const minX = bounds.min.x, minZ = bounds.min.z;
  const point = (id) => new THREE.Vector3(minX + (id % width + 0.5) * step,
    floorY + 0.02, minZ + (Math.floor(id / width) + 0.5) * step);
  const cell = (p) => {
    const x = Math.floor((p[0] - minX) / step), z = Math.floor((p[2] - minZ) / step);
    return x < 0 || z < 0 || x >= width || z >= depth ? -1 : z * width + x;
  };
  const edgeDistanceSq = (x, z, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  surface.updateWorldMatrix(true, true);
  surface.traverse((object) => {
    if (!object.isMesh) return;
    const attr = object.geometry.attributes.position, index = object.geometry.index;
    const count = index ? index.count : attr.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(attr, index ? index.getX(i) : i).applyMatrix4(object.matrixWorld);
      b.fromBufferAttribute(attr, index ? index.getX(i + 1) : i + 1).applyMatrix4(object.matrixWorld);
      c.fromBufferAttribute(attr, index ? index.getX(i + 2) : i + 2).applyMatrix4(object.matrixWorld);
      const low = Math.min(a.y, b.y, c.y), high = Math.max(a.y, b.y, c.y);
      const body = high > floorY + 0.22 && low < floorY + 1.9;
      normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
      const ground = Math.abs(normal.y) > 0.75 && low <= floorY + 0.18 && high >= floorY - 0.18;
      if (!ground && !body) continue;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - minX) / step));
      const x1 = Math.min(width - 1, Math.floor((Math.max(a.x, b.x, c.x) - minX) / step));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - minZ) / step));
      const z1 = Math.min(depth - 1, Math.floor((Math.max(a.z, b.z, c.z) - minZ) / step));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const px = minX + (x + 0.5) * step, pz = minZ + (z + 0.5) * step;
        const u = denominator ? ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / denominator : -1;
        const v = denominator ? ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / denominator : -1;
        const inside = u >= -1e-6 && v >= -1e-6 && u + v <= 1.000001;
        const id = z * width + x;
        const y = u * a.y + v * b.y + (1 - u - v) * c.y;
        if (ground && inside && Math.abs(y - floorY) <= 0.18) floor[id] = 1;
        if (body && (inside || Math.min(edgeDistanceSq(px, pz, a, b), edgeDistanceSq(px, pz, b, c),
          edgeDistanceSq(px, pz, c, a)) <= step * step / 2)) obstacles[id] = 1;
      }
    }
  });
  for (let id = 0; id < total; id++) {
    const p = point(id);
    if (blocked.some((b) => Math.hypot(p.x - b[0], p.z - b[2]) < 0.6)) obstacles[id] = 1;
  }
  // One-cell buffer around obstacles, missing floor, and scan boundaries.
  const walkable = new Uint8Array(total);
  for (let z = 1; z < depth - 1; z++) for (let x = 1; x < width - 1; x++) {
    let clear = true;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const id = (z + dz) * width + x + dx;
      if (!floor[id] || obstacles[id]) clear = false;
    }
    walkable[z * width + x] = Number(clear);
  }
  const from = cell(start);
  if (from < 0 || !walkable[from]) return { error: 'Start is not on clear scanned floor. Use Set start on floor on a clear area; verify floor height.' };
  const targets = new Set(exits.map(cell).filter((id) => id >= 0 && walkable[id]));
  if (!targets.size) return { error: 'Marked exits are outside clear floor. Mark the approach area just inside a known exit.' };
  const previous = new Int32Array(total).fill(-1), queue = new Int32Array(total);
  previous[from] = from;
  queue[0] = from;
  let head = 0, tail = 1, found = -1;
  while (head < tail) {
    const id = queue[head++];
    if (targets.has(id)) { found = id; break; }
    const x = id % width, z = Math.floor(id / width);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, next = nz * width + nx;
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth || !walkable[next] || previous[next] !== -1) continue;
      previous[next] = id; queue[tail++] = next;
    }
  }
  if (found < 0) return { error: 'No connected route found through scanned floor. Check scan holes, start, exits and blocked marks, or draw a route manually.' };
  const cells = [found];
  while (cells[cells.length - 1] !== from) cells.push(previous[cells[cells.length - 1]]);
  cells.reverse();
  if (cells.length < 2) return { error: 'Start is already at the marked exit. Choose a different start to draw a route.' };
  const turns = cells.filter((id, i) => i === 0 || i === cells.length - 1 || id - cells[i - 1] !== cells[i + 1] - id);
  return { points: turns.map((id) => point(id).toArray()), cells: cells.length, step };
}

function calculateRoute(state) {
  setAnnotationTool(state);
  const live = state.mode === 'live';
  if (live && (!state.alignment || state.lastPose === null || !state.rawPose
    || performance.now() - state.rawPoseAt > 2000)) {
    state.panel.querySelector('[data-edit]').textContent = 'Current headset position unavailable. Restore tracking and align before planning a route.';
    return;
  }
  const routeStart = (live ? state.position : state.spawn).clone();
  routeStart.y = state.floorY;
  const scanned = Boolean(state.scan?.model.visible);
  const room = scanned ? 'scan' : 'sample';
  const items = state.layouts[room];
  const result = planRoomRoute({
    surface: scanned ? state.scan.model : state.sample,
    bounds: state.bounds, floorY: state.floorY, start: routeStart.toArray(),
    exits: items.filter((item) => item.type === 'exit').map((item) => item.position),
    blocked: items.filter((item) => item.type === 'blocked').map((item) => item.position),
  });
  if (result.error) { state.panel.querySelector('[data-edit]').textContent = result.error; return; }
  state.layouts[room] = items.filter((item) => item.type !== 'waypoint').concat(
    result.points.map((position) => ({ type: 'waypoint', position, source: 'geometry-draft' })));
  redrawAnnotations(state);
  state.panel.querySelector('[data-edit]').textContent =
    `Draft route from ${live ? 'current headset position' : 'selected start'} (X ${routeStart.x.toFixed(2)}, Z ${routeStart.z.toFixed(2)}). Click Auto route again after moving to replan. Verify the real path; scan gaps and unseen obstacles limit this preview.`;
}

async function autoRoute(state) {
  const button = state.panel.querySelector('[data-action="auto-route"]');
  const status = state.panel.querySelector('[data-route-status]');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Planning...';
  status.hidden = false;
  status.textContent = 'Checking the floor, obstacles and marked exits...';
  status.scrollIntoView({ block: 'nearest' });
  // Allow the browser to show progress before scanning mesh triangles.
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    if (state.disposed) return;
    calculateRoute(state);
    status.textContent = state.panel.querySelector('[data-edit]').textContent;
  } catch (error) {
    status.textContent = `Route planning failed: ${error.message}. Your marks have been kept.`;
    console.error('Route planning failed', error);
  } finally {
    button.disabled = false;
    button.textContent = 'Auto route';
  }
}

/** Snapshot for review/export; deliberately separate from main.js scenario data. */
export function getRoomAnnotations() {
  if (!active) return null;
  const s = active;
  const room = s.scan?.model.visible ? 'scan' : 'sample';
  return {
    version: 1,
    roomId: room === 'scan' ? '10_17_2026' : 'sample-room',
    coordinateFrame: room === 'scan' ? 'original-obj' : 'sample-room',
    units: room === 'scan' ? 'unverified-model-units' : 'meters',
    floorY: s.floorY,
    spawn: s.spawn.toArray(),
    source: 'demo-room-annotations',
    items: s.layouts[room].map((item) => ({ type: item.type, position: [...item.position], source: item.source || 'manual' })),
  };
}

async function loadScan(state) {
  const manager = new THREE.LoadingManager();
  const textureUrls = {
    'dd3d245ca8809c56baa2936ab44c0a87.jpg': scanTextureOne,
    'ea6461fa5f57fcf8e26ee4fe903ea979.jpg': scanTextureTwo,
  };
  manager.setURLModifier((url) => textureUrls[url.split('/').pop()] || url);
  let textureFailed = false;
  manager.onError = () => { textureFailed = true; };
  let materials;
  try {
    materials = await new MTLLoader(manager).loadAsync(scanMtlUrl);
    // Wait for both textures, including failures, before reporting readiness.
    const texturesReady = new Promise((resolve) => { manager.onLoad = resolve; });
    materials.preload();
    const model = await new OBJLoader().setMaterials(materials).loadAsync(scanObjUrl);
    await texturesReady;
    if (state.disposed) { releaseObjects(model); return; }
    const heights = [];
    model.traverse((object) => {
      if (!object.isMesh) return;
      const values = object.geometry.attributes.position;
      for (let i = 0; i < values.count; i++) heights.push(values.getY(i));
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        material.side = THREE.DoubleSide;
      }
    });
    heights.sort((a, b) => a - b);
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    state.scan = {
      model, bounds, floorY: heights[Math.floor(heights.length * 0.1)],
      spawn: new THREE.Vector3(center.x, 0, center.z),
    };
    state.root.add(model);
    model.visible = false;
    state.panel.querySelector('[data-action="scan"]').disabled = false;
    state.panel.querySelector('[data-load]').textContent = textureFailed
      ? 'Scan loaded with missing textures. Use Sample room if needed.'
      : 'Scan loaded. Scale is unverified; floor height is estimated. Use Set start on floor to choose a clear floor point.';
    if (state.roomChoice === 'scan') state.selectRoom('scan');
  } catch (error) {
    if (materials) {
      for (const material of Object.values(materials.materials)) {
        material.map?.dispose(); material.dispose();
      }
    }
    if (state.disposed) return;
    state.panel.querySelector('[data-load]').textContent = 'Scan could not load. Showing sample room; reload the page to retry.';
    state.selectRoom('sample');
    console.error('Room scan load failed:', error);
  }
}

export function start(options = {}) {
  if (active) return active.api;
  const shared = Boolean(options.scene && options.camera && options.renderer);
  if (!shared && (options.scene || options.camera || options.renderer)) {
    throw new Error('Pass scene, camera and renderer together.');
  }
  const host = options.container || document.getElementById('app') || document.body;
  const panel = document.createElement('section');
  panel.style.cssText = 'position:relative;background:#101b29;color:#e4eef8;font:14px system-ui,sans-serif;';
  panel.innerHTML = `
    <header style="padding:18px 22px;border-bottom:1px solid #334456">
      <strong style="font-size:22px">Room observer</strong>
      <span data-room style="margin-left:14px;color:#a9bdcd">Sample room · 6 × 4 m · 1 m grid</span>
      <p>Blue marker = floor position · Arrow = head direction · Sphere = head height</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-action="angle">Angled view</button>
        <button type="button" data-action="top">Top view</button>
        <button type="button" data-action="dual" aria-pressed="true">Both views: on</button>
        <button type="button" data-action="reset">Reset simulation</button>
        <button type="button" data-action="live">Connect headset</button>
        <button type="button" data-action="scan" disabled>Scanned room</button>
        <button type="button" data-action="sample">Sample room</button>
        <button type="button" data-action="spawn" disabled>Set start on floor</button>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:12px">
        <label>Pairing code <input data-pair value="firedrill" maxlength="32" style="width:110px"></label>
        <label>Facing ° (0 = -Z, 90 = +X) <input data-heading type="number" value="0" step="5" style="width:65px"></label>
        <label>Model units / meter <input data-scale type="number" value="1" min="0.01" max="100" step="0.01" style="width:65px"></label>
        <button type="button" data-action="align">Align headset at start</button>
        <a data-headset-link href="/eileen-xr.html" target="_blank" rel="noopener" style="color:#74d7ff">Headset page</a>
      </div>
      <p data-connection role="status">Choose a start on the floor. Open the headset page using this computer's Wi-Fi IP and the same pairing code.</p>
      <p data-alignment role="status">Alignment not set. Stand at the chosen start, face the specified direction, then align on this computer.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" data-mark="exit" aria-pressed="false">Mark exit</button>
        <button type="button" data-mark="blocked" aria-pressed="false">Mark blocked</button>
        <button type="button" data-mark="waypoint" aria-pressed="false">Draw route</button>
        <button type="button" data-action="auto-route">Auto route</button>
        <button type="button" data-action="finish">Finish route</button>
        <button type="button" data-action="undo">Undo mark</button>
        <button type="button" data-action="clear-marks">Clear marks</button>
        <button type="button" data-action="export">Export annotations</button>
      </div>
      <p data-edit role="status"></p>
      <p data-route-status role="status" hidden style="padding:12px;border:1px solid #edbe65;background:#302b20;color:#ffe0a3"></p>
      <p data-layout></p>
      <p data-load role="status">Loading 10_17_2026 scan… You can use the sample room while it loads.</p>
      <p data-status role="status" aria-live="polite"></p>
      <output data-pose style="font-family:monospace"></output>
      <p style="color:#a9bdcd;margin-bottom:0">Simulation: WASD move · Q/E turn · Hold C to crouch.<br>
        Drag to orbit · Scroll to zoom. Observer preview only; no collision or escape checks.</p>
    </header>`;
  for (const button of panel.querySelectorAll('button')) {
    button.style.cssText = 'background:#263b4e;border:1px solid #60788e;color:#eef7ff;border-radius:6px;padding:9px 12px;cursor:pointer';
  }
  host.append(panel);
  const viewport = document.createElement('div');
  viewport.style.cssText = 'height:65vh;min-height:320px;position:relative;';
  const viewLabels = document.createElement('div');
  viewLabels.style.cssText = 'position:absolute;inset:8px 0 auto;display:flex;pointer-events:none;z-index:1;font:14px system-ui;color:white';
  viewLabels.innerHTML = '<span style="width:50%;padding-left:12px;box-sizing:border-box">Room overview</span><span data-follow-status style="width:50%;padding-left:12px;box-sizing:border-box">Headset view: connect and align</span>';
  viewport.append(viewLabels);
  if (!shared) panel.append(viewport);
  let renderer;
  try {
    renderer = options.renderer || new THREE.WebGLRenderer({ antialias: true });
  } catch (error) {
    panel.querySelector('[data-status]').textContent = '3D view unavailable. Enable browser hardware acceleration and reload.';
    throw error;
  }
  const scene = options.scene || new THREE.Scene();
  const camera = options.camera || new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  const followCamera = new THREE.PerspectiveCamera(75, 1, 0.03, 1000);
  const root = new THREE.Group();
  root.name = 'eileen-room-observer';
  scene.add(root);
  if (!shared) {
    scene.background = new THREE.Color(0x101b29);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    viewport.append(renderer.domElement);
    renderer.domElement.style.display = 'block';
  }
  root.add(new THREE.HemisphereLight(0xe5f4ff, 0x354255, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(3, 7, 4);
  root.add(light);
  const sample = new THREE.Group();
  root.add(sample);
  createRoom(sample);
  const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.045, 24),
    new THREE.MeshBasicMaterial({ color: 0x54baff, depthTest: false }));
  marker.renderOrder = 5;
  root.add(marker);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x54baff }));
  root.add(head);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.65, 0x54baff, 0.2, 0.14);
  root.add(arrow);
  for (const part of [arrow.line, arrow.cone]) {
    part.material.depthTest = false;
    part.renderOrder = 6;
  }
  const controls = shared ? null : new OrbitControls(camera, renderer.domElement);
  if (controls) {
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.minDistance = 3;
    controls.maxDistance = 22;
  }
  const state = {
    root, panel, renderer, scene, camera, controls, shared, marker, head, arrow, sample,
    floorY: 0, spawn: new THREE.Vector3(0, 0, 1), scan: null, disposed: false,
    bounds: new THREE.Box3(new THREE.Vector3(-3, 0, -2), new THREE.Vector3(3, 2.6, 2)),
    roomChoice: 'scan', pickingSpawn: false, viewTop: false, dualView: !shared,
    position: new THREE.Vector3(0, 1.6, 1), quaternion: new THREE.Quaternion(),
    forward: new THREE.Vector3(0, 0, -1), keys: new Set(), mode: 'simulation',
    lastPose: null, yaw: 0, lastFrame: performance.now(), raf: 0, lastText: '',
    annotationTool: null, layouts: { sample: [], scan: [] }, annotations: new THREE.Group(),
    poseChannel: null, rawPose: null, rawPoseAt: 0, alignment: null, headsetEnabled: false,
  };
  const invalidateAlignment = (message) => {
    state.alignment = null; state.rawPose = null; state.lastPose = null;
    panel.querySelector('[data-alignment]').textContent = message;
  };
  const stopHeadset = () => {
    state.headsetEnabled = false; state.poseChannel?.close(); state.poseChannel = null;
    panel.querySelector('[data-pair]').disabled = false;
    panel.querySelector('[data-connection]').textContent = 'Headset connection stopped. Simulation controls are active.';
    invalidateAlignment('Alignment not set. Connect the headset and align again.');
  };
  const connectHeadset = () => {
    const room = panel.querySelector('[data-pair]').value;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
      panel.querySelector('[data-connection]').textContent = 'Pairing code: use 1–32 letters, numbers, underscores or hyphens.'; return;
    }
    state.poseChannel?.close();
    state.headsetEnabled = true; state.mode = 'live'; state.keys.clear();
    invalidateAlignment('Waiting for fresh head poses. Then stand at the selected start and align.');
    panel.querySelector('[data-pair]').disabled = true;
    panel.querySelector('[data-headset-link]').href = `/eileen-xr.html?room=${encodeURIComponent(room)}`;
    state.poseChannel = connectPoseChannel({ role: 'observer', room,
      onStatus(message, ready) {
        if (ready) syncAnnotations(state);
        panel.querySelector('[data-connection]').textContent = `${message} · Pairing code: ${room}`;
        if (!ready) {
          state.rawPose = null;
          panel.querySelector('[data-alignment]').textContent = 'Connection interrupted. Waiting for fresh poses; alignment resumes only for the same headset session.';
        }
      },
      onTracking(data) {
        if (data.state === 'disconnected') {
          state.rawPose = null;
          panel.querySelector('[data-alignment]').textContent = 'Headset disconnected. Waiting to reconnect; a new VR session requires alignment.';
          return;
        }
        invalidateAlignment(`Headset ${data.state}. Wait for fresh tracking, then align again.`);
      },
      onPose(pose) {
        if (!state.headsetEnabled || !validArray(pose?.position, 3) || !validArray(pose?.quaternion, 4)) return;
        if (state.alignment && pose.sessionId !== state.alignment.sessionId) {
          invalidateAlignment('New headset reference space. Align again.');
        }
        state.rawPose = pose; state.rawPoseAt = performance.now();
        const transformed = alignPose(pose, state.alignment);
        if (transformed) {
          updateHeadPose(transformed);
          panel.querySelector('[data-alignment]').textContent = 'Aligned. Receiving live headset position and direction.';
        }
        else panel.querySelector('[data-alignment]').textContent = 'Head poses received. Stand at the selected start, face the specified direction, then click Align headset at start.';
      },
    });
  };
  const calibrationChanged = () => {
    state.alignment = null; state.lastPose = null;
    panel.querySelector('[data-alignment]').textContent = 'Calibration settings changed. Align again.';
  };
  panel.querySelector('[data-heading]').addEventListener('change', calibrationChanged);
  panel.querySelector('[data-scale]').addEventListener('change', calibrationChanged);
  state.annotations.name = 'manual-escape-annotations';
  root.add(state.annotations);
  const setView = (top) => {
    if (shared) return;
    state.viewTop = top;
    const center = state.bounds.getCenter(new THREE.Vector3());
    center.y = state.floorY;
    const direction = new THREE.Vector3(...(top ? [0, 1, 0.0001] : [0.8, 1, 0.9])).normalize();
    const right = new THREE.Vector3().crossVectors(UP, direction).normalize();
    const vertical = new THREE.Vector3().crossVectors(direction, right);
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    let distance = 3;
    for (const x of [state.bounds.min.x, state.bounds.max.x]) {
      for (const y of [state.bounds.min.y, state.bounds.max.y]) {
        for (const z of [state.bounds.min.z, state.bounds.max.z]) {
          const offset = new THREE.Vector3(x, y, z).sub(center);
          distance = Math.max(distance, offset.dot(direction) + Math.max(
            Math.abs(offset.dot(right)) / (tanVertical * camera.aspect),
            Math.abs(offset.dot(vertical)) / tanVertical));
        }
      }
    }
    distance *= 1.12;
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.target.copy(center);
    controls.maxDistance = distance * 3;
    camera.far = Math.max(100, distance * 5);
    camera.updateProjectionMatrix();
    controls.update();
  };
  const resetSimulation = () => {
    stopHeadset();
    state.mode = 'simulation';
    state.position.copy(state.spawn);
    state.position.y = state.floorY + 1.6;
    state.quaternion.identity();
    state.yaw = 0;
    state.lastPose = null;
    state.keys.clear();
  };
  state.selectRoom = (choice) => {
    state.roomChoice = choice;
    const scanned = choice === 'scan' && state.scan;
    sample.visible = !scanned;
    if (state.scan) state.scan.model.visible = Boolean(scanned);
    state.bounds = scanned ? state.scan.bounds.clone()
      : new THREE.Box3(new THREE.Vector3(-3, 0, -2), new THREE.Vector3(3, 2.6, 2));
    state.floorY = scanned ? state.scan.floorY : 0;
    state.spawn.copy(scanned ? state.scan.spawn : new THREE.Vector3(0, 0, 1));
    invalidateAlignment('Room changed. Choose a start, then align the headset again.');
    setAnnotationTool(state);
    panel.querySelector('[data-action="spawn"]').textContent = 'Set start on floor';
    panel.querySelector('[data-action="spawn"]').disabled = !scanned || shared;
    panel.querySelector('[data-room]').textContent = scanned
      ? '10_17_2026 · Textured scan · Original coordinates'
      : 'Sample room · 6 × 4 m · 1 m grid';
    if (state.mode === 'simulation') resetSimulation();
    redrawAnnotations(state);
    setView(state.viewTop);
  };
  const onClick = (event) => {
    const action = event.target.dataset.action;
    if (action === 'dual' && !shared) {
      state.dualView = !state.dualView;
      event.target.textContent = `Both views: ${state.dualView ? 'on' : 'off'}`;
      event.target.setAttribute('aria-pressed', String(state.dualView));
      viewLabels.querySelector('[data-follow-status]').hidden = !state.dualView;
      resize();
    }
    const mark = event.target.dataset.mark;
    if (mark && !shared) setAnnotationTool(state, state.annotationTool === mark ? null : mark);
    const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
    if (action === 'finish') setAnnotationTool(state);
    if (action === 'auto-route') autoRoute(state);
    if (action === 'undo') { items.pop(); redrawAnnotations(state); }
    if (action === 'clear-marks') { items.length = 0; setAnnotationTool(state); redrawAnnotations(state); }
    if (action === 'export') {
      const data = getRoomAnnotations();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${data.roomId}-annotations.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (action === 'top' || action === 'angle') setView(action === 'top');
    if (action === 'reset') {
      resetSimulation();
    }
    if (action === 'scan' || action === 'sample') state.selectRoom(action);
    if (action === 'spawn') {
      const next = !state.pickingSpawn;
      setAnnotationTool(state);
      state.pickingSpawn = next;
      event.target.textContent = state.pickingSpawn ? 'Click a clear floor point (cancel)' : 'Set start on floor';
    }
    if (action === 'live') {
      connectHeadset();
    }
    if (action === 'align') {
      const output = panel.querySelector('[data-alignment]');
      if (!state.headsetEnabled || !state.rawPose || performance.now() - state.rawPoseAt > 2000) {
        output.textContent = 'No fresh head pose. Connect the headset and enter VR first.'; return;
      }
      try {
        state.alignment = createAlignment(state.rawPose, state.spawn, state.floorY,
          Number(panel.querySelector('[data-heading]').value), Number(panel.querySelector('[data-scale]').value));
        if (state.scan?.model.visible) state.poseChannel?.sendAlignment?.({
          sessionId: state.alignment.sessionId, origin: state.alignment.origin.toArray(),
          target: state.alignment.target.toArray(), rotation: state.alignment.rotation.toArray(),
          scale: state.alignment.scale,
        });
        updateHeadPose(alignPose(state.rawPose, state.alignment));
        output.textContent = 'Aligned. The blue marker now follows the headset. Verify scale and facing with a small movement.';
      } catch (error) { output.textContent = error.message; }
    }
  };
  panel.addEventListener('click', onClick);
  let pointerDown = null;
  const rememberPointer = (event) => { pointerDown = { x: event.clientX, y: event.clientY, button: event.button }; };
  const pickStart = (event) => {
    if (shared || (!state.pickingSpawn && !state.annotationTool)) return;
    if (!pointerDown || pointerDown.button !== 0
      || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const overviewWidth = state.dualView ? Math.floor(rect.width / 2) : rect.width;
    if (event.clientX - rect.left >= overviewWidth) return;
    const mouse = new THREE.Vector2((event.clientX - rect.left) / overviewWidth * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const surface = state.scan?.model.visible ? state.scan.model : sample;
    const hit = ray.intersectObject(surface, true).find((item) => item.object.isMesh);
    if (!hit) {
      panel.querySelector('[data-edit]').textContent = 'No surface at that point. Click visible floor, not a scan hole.';
      return;
    }
    if (state.annotationTool) {
      // A changed exit, obstacle or manually drawn path invalidates the draft.
      invalidateAutoRoute(state);
      const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
      if (items.length >= 500) {
        panel.querySelector('[data-edit]').textContent = 'Annotation limit reached. Undo or clear marks to continue.';
        return;
      }
      if (state.annotationTool === 'waypoint') {
        const previous = items.filter((item) => item.type === 'waypoint').at(-1);
        if (previous && new THREE.Vector3().fromArray(previous.position).distanceTo(hit.point) < 0.05) return;
      }
      items.push({ type: state.annotationTool, position: hit.point.toArray() });
      redrawAnnotations(state);
      return;
    }
    state.scan.floorY = hit.point.y;
    state.scan.spawn.copy(hit.point);
    state.floorY = hit.point.y;
    state.spawn.copy(hit.point);
    invalidateAutoRoute(state);
    // Explicit picking returns to simulation, never moves a live headset pose.
    resetSimulation();
    state.pickingSpawn = false;
    panel.querySelector('[data-action="spawn"]').textContent = 'Set start on floor';
    panel.querySelector('[data-load]').textContent = 'Simulation start and floor height set. Connect and align the headset to resume live tracking.';
  };
  renderer.domElement.addEventListener('pointerdown', rememberPointer);
  const blockFollowInteraction = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (state.dualView && event.clientX - rect.left >= rect.width / 2) {
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
    }
  };
  renderer.domElement.addEventListener('pointerdown', blockFollowInteraction, true);
  renderer.domElement.addEventListener('wheel', blockFollowInteraction, { capture: true, passive: false });
  renderer.domElement.addEventListener('click', pickStart);
  const onKey = (event) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Escape') setAnnotationTool(state);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC'].includes(event.code)) {
      if (state.mode === 'simulation') {
        event.preventDefault();
        state.keys.add(event.code);
      }
    }
  };
  const onKeyUp = (event) => state.keys.delete(event.code);
  const clearKeys = () => { state.keys.clear(); state.lastFrame = performance.now(); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', clearKeys);
  const resize = () => {
    if (shared) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    camera.aspect = (state.dualView ? Math.floor(width / 2) : width) / height;
    camera.updateProjectionMatrix();
    followCamera.aspect = (width - Math.floor(width / 2)) / height;
    followCamera.updateProjectionMatrix();
    renderer.setSize(width, height);
    setView(state.viewTop);
  };
  const observer = new ResizeObserver(resize);
  if (!shared) observer.observe(viewport);
  state.api = { updateHeadPose, getRoomAnnotations, dispose, root };
  state.cleanup = () => {
    state.disposed = true;
    state.poseChannel?.close();
    cancelAnimationFrame(state.raf);
    observer.disconnect();
    panel.removeEventListener('click', onClick);
    panel.querySelector('[data-heading]').removeEventListener('change', calibrationChanged);
    panel.querySelector('[data-scale]').removeEventListener('change', calibrationChanged);
    renderer.domElement.removeEventListener('click', pickStart);
    renderer.domElement.removeEventListener('pointerdown', rememberPointer);
    renderer.domElement.removeEventListener('pointerdown', blockFollowInteraction, true);
    renderer.domElement.removeEventListener('wheel', blockFollowInteraction, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', clearKeys);
    document.removeEventListener('visibilitychange', clearKeys);
    controls?.dispose();
    releaseObjects(root);
    root.removeFromParent();
    if (!shared) renderer.dispose();
    panel.remove();
  };
  active = state;
  setAnnotationTool(state);
  redrawAnnotations(state);
  setView(false);
  resize();
  update(0);
  void loadScan(state);
  if (!shared) {
    const frame = (now) => {
      update(Math.min((now - state.lastFrame) / 1000, 0.05));
      state.lastFrame = now;
      const width = viewport.clientWidth, height = viewport.clientHeight;
      const leftWidth = state.dualView ? Math.floor(width / 2) : width;
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, leftWidth, height);
      renderer.setScissor(0, 0, leftWidth, height);
      renderer.render(scene, camera);
      if (state.dualView) {
        renderer.setViewport(leftWidth, 0, width - leftWidth, height);
        renderer.setScissor(leftWidth, 0, width - leftWidth, height);
        const ready = state.mode === 'live' && state.lastPose !== null;
        const stale = ready && performance.now() - state.lastPose > 2000;
        viewLabels.querySelector('[data-follow-status]').textContent = !ready
          ? 'Headset view: connect and align' : stale ? 'Headset view: paused (no fresh pose)' : 'Headset view: live';
        if (ready) {
          followCamera.position.copy(state.position);
          followCamera.quaternion.copy(state.quaternion);
          const scale = state.alignment?.scale || 1;
          followCamera.near = 0.03 * scale;
          followCamera.far = Math.max(camera.far, 100 * scale);
          followCamera.updateProjectionMatrix();
          const visibility = [marker.visible, head.visible, arrow.visible];
          marker.visible = head.visible = arrow.visible = false;
          renderer.render(scene, followCamera);
          [marker.visible, head.visible, arrow.visible] = visibility;
        } else renderer.clear();
      }
      renderer.setScissorTest(false);
      state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
  } else {
    panel.querySelector('[data-action="top"]').disabled = true;
    panel.querySelector('[data-action="angle"]').disabled = true;
    panel.querySelector('[data-action="dual"]').disabled = true;
    for (const button of panel.querySelectorAll('[data-mark]')) button.disabled = true;
    panel.querySelector('[data-action="auto-route"]').disabled = true;
  }
  return state.api;
}

/** Feed validated room-space poses here from the team's transport receiver. */
export function updateHeadPose(pose) {
  if (!active || !validArray(pose?.position, 3) || !validArray(pose?.quaternion, 4)) return false;
  const norm = Math.hypot(...pose.quaternion);
  if (!Number.isFinite(norm) || norm < 1e-8) return false;
  active.position.fromArray(pose.position);
  active.quaternion.fromArray(pose.quaternion.map((value) => value / norm));
  active.mode = 'live';
  active.lastPose = performance.now();
  active.keys.clear();
  return true;
}

export function update(dt = 0) {
  if (!active) return;
  const s = active;
  const step = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.05) : 0;
  if (s.mode === 'simulation') {
    const key = (code) => Number(s.keys.has(code));
    s.yaw += (key('KeyQ') - key('KeyE')) * step * 1.8;
    s.quaternion.setFromAxisAngle(UP, s.yaw);
    const movement = new THREE.Vector3(key('KeyD') - key('KeyA'), 0, key('KeyS') - key('KeyW'));
    if (movement.lengthSq()) s.position.add(movement.normalize().applyQuaternion(s.quaternion).multiplyScalar(step * 1.4));
    s.position.x = THREE.MathUtils.clamp(s.position.x, s.bounds.min.x + 0.2, s.bounds.max.x - 0.2);
    s.position.z = THREE.MathUtils.clamp(s.position.z, s.bounds.min.z + 0.2, s.bounds.max.z - 0.2);
    s.position.y = s.floorY + (s.keys.has('KeyC') ? 0.9 : 1.6);
  }
  const waiting = s.mode === 'live' && s.lastPose === null;
  const stale = s.mode === 'live' && !waiting && performance.now() - s.lastPose > 2000;
  s.marker.visible = s.head.visible = s.arrow.visible = !waiting;
  s.marker.position.set(s.position.x, s.floorY + 0.04, s.position.z);
  s.head.position.copy(s.position);
  s.forward.set(0, 0, -1).applyQuaternion(s.quaternion);
  s.forward.y = 0;
  s.arrow.visible = !waiting && s.forward.lengthSq() > 1e-6;
  if (s.arrow.visible) s.arrow.setDirection(s.forward.normalize());
  s.arrow.position.set(s.position.x, s.floorY + 0.1, s.position.z);
  const color = stale ? 0xe8ae59 : 0x54baff;
  s.marker.material.color.setHex(color);
  s.head.material.color.setHex(color);
  s.arrow.setColor(color);
  const outside = s.position.x < s.bounds.min.x || s.position.x > s.bounds.max.x
    || s.position.z < s.bounds.min.z || s.position.z > s.bounds.max.z;
  const text = s.mode === 'simulation' ? 'Simulated tracking — no headset connected'
    : waiting ? 'Waiting for headset data and alignment'
      : stale ? 'Tracking disconnected — showing last received position'
        : `Live pose input${outside ? ' — outside room bounds; check alignment' : ''}`;
  if (text !== s.lastText) {
    s.panel.querySelector('[data-status]').textContent = text;
    s.lastText = text;
  }
  s.panel.querySelector('[data-pose]').textContent = waiting ? 'No pose received'
    : `X ${s.position.x.toFixed(2)} | Z ${s.position.z.toFixed(2)} | Height above floor ${(s.position.y - s.floorY).toFixed(2)} | ${s.scan?.model.visible ? 'Model units (scale unverified)' : 'Meters'}`;
  s.controls?.update();
}

export function dispose() {
  if (!active) return;
  active.cleanup();
  active = undefined;
}
