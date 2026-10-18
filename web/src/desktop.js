import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { connectPoseChannel } from './eileen-pose-channel.js';
import { createAlignment, alignPose } from './eileen-pose-alignment.js';
import { createRoomEffects } from './eileen-effects.js';
import { planRoomRoute } from './eileen-route-planner.js';
export { planRoomRoute } from './eileen-route-planner.js';
import { chooseFirePositions } from './eileen-auto-fire.js';
import { exitDefaults, readDefaultExits, saveDefaultExits } from './eileen-exit-defaults.js';
import { fireKey, placeDrillFire, undoAnnotation, hasGuidancePose } from './eileen-fire-lifecycle.js';
import { addRouteChevrons } from './eileen-route-visuals.js';
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
  const room = state.scan?.model.visible ? 'scan' : 'sample';
  const nextFire = fireKey(state.layouts[room]);
  for (const selector of ['[data-mark="fire"]', '[data-action="auto-effects"]', '[data-action="start-effects"]', '[data-action="stop-effects"]']) {
    state.panel.querySelector(selector).disabled = !!nextFire;
  }
  if (nextFire !== state.drillFireKey) {
    state.drillFireKey = nextFire;
    state.routeRevision++;
    state.nextGuidanceAt = 0;
    state.layouts[room] = state.layouts[room].filter((item) => item.source !== 'geometry-draft');
    state.effectsRunning = !!nextFire;
    if (nextFire) state.effectsStartedAt = performance.now();
    refreshEffects(state);
  }
  const group = state.annotations;
  releaseObjects(group);
  group.clear();
  const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
  const waypoints = [];
  for (const item of items) {
    if (item.type === 'fire') continue;
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
      label(group, blocked ? 'X  BLOCKED' : 'EXIT',
        [position.x, state.floorY + (nextFire ? 2.1 : 0.8) * (state.alignment?.scale || 1), position.z], blocked ? '#ff9090' : '#74f3c6');
    }
  }
  if (waypoints.length > 1) {
    addRouteChevrons(group, waypoints);
  }
  // Overlay markers stay readable on noisy scan geometry. Segments are manually
  // drawn and have no obstacle validation; visibility is not proof of clearance.
  group.traverse((object) => {
    if (object.material) {
      object.material.depthTest = false; object.renderOrder = 4;
      object.material.transparent = true; object.material.opacity = nextFire ? 1 : 0.4;
      if (object.isSprite && nextFire) object.scale.multiplyScalar(1.35);
    }
  });
  const exits = items.filter((item) => item.type === 'exit').length;
  try {
    saveDefaultExits(window.localStorage, state.scan?.model.visible ? '10_17_2026' : 'sample-room', items);
    state.panel.querySelector('[data-exit-defaults]').textContent =
      `${exits} default exits saved in this browser. Refresh restores exits; Clear marks removes saved exits.`;
  } catch {
    state.panel.querySelector('[data-exit-defaults]').textContent =
      'Could not save default exits. Export annotations before refreshing.';
  }
  syncAnnotations(state);
  const blocked = items.filter((item) => item.type === 'blocked').length;
  state.panel.querySelector('[data-layout]').textContent =
    `Marked exits: ${exits} · Blocked: ${blocked} · Route points: ${waypoints.length}${items.some((item) => item.source === 'geometry-draft') ? ' · Automatically generated draft' : ''}`;
}

function syncAnnotations(state) {
  state.poseChannel?.sendAnnotations?.({ roomId: '10_17_2026',
    items: state.scan?.model.visible ? state.layouts.scan : [] });
}

function refreshEffects(state) {
  const scanned = Boolean(state.scan?.model.visible);
  const center = state.bounds.getCenter(new THREE.Vector3());
  const size = state.bounds.getSize(new THREE.Vector3());
  const snapshot = { version: 1, roomId: scanned ? '10_17_2026' : 'sample-room',
    running: state.effectsRunning, elapsed: state.effectsRunning
      ? Math.min(86400, (performance.now() - state.effectsStartedAt) / 1000) : 0,
    floorY: state.floorY, ceilingY: Math.max(state.floorY + 2, state.bounds.max.y),
    center: [center.x, center.z], size: Math.min(100, Math.max(1, size.x, size.z)),
    fires: state.drillFireKey
      ? state.layouts[scanned ? 'scan' : 'sample'].filter((item) => item.type === 'fire').map((item) => item.position)
      : state.firePositions[scanned ? 'scan' : 'sample'] };
  state.effects.apply(snapshot);
  state.poseChannel?.sendEffects?.(snapshot);
  state.panel.querySelector('[data-effects-status]').textContent =
    state.drillFireKey ? 'Observer shows the ignition point. The headset runs the spreading fire and drill.'
      : `${snapshot.fires.length} fire sources · ${snapshot.running ? 'Smoke running' : 'Smoke stopped'} · Fixed demo fire patches`;
}

function autoFireAndSmoke(state) {
  const scanned = Boolean(state.scan?.model.visible);
  const room = scanned ? 'scan' : 'sample';
  if (!state.firePositions[room].length) {
    state.firePositions[room] = chooseFirePositions({ surface: scanned ? state.scan.model : state.sample,
      bounds: state.bounds, floorY: state.floorY, start: state.spawn.toArray(),
      exits: state.layouts[room].filter((item) => item.type === 'exit').map((item) => item.position),
      scale: state.alignment?.scale || 1 });
  }
  if (!state.firePositions[room].length) {
    state.panel.querySelector('[data-effects-status]').textContent = 'No suitable floor found for automatic fire. Set start on a clear floor to correct floor height, then retry or use Place fire.';
    return;
  }
  if (!state.effectsRunning) state.effectsStartedAt = performance.now();
  state.effectsRunning = true;
  invalidateAutoRoute(state);
  refreshEffects(state);
}

function invalidateAutoRoute(state) {
  state.routeRevision++;
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
  state.panel.querySelector('[data-edit]').textContent = tool === 'drill-fire'
    ? 'Click to ignite one drill fire. Another placement replaces it; Undo mark restores the previous placement.' : tool === 'fire'
    ? 'Click a surface to place a fire. Routes near fire sources are invalidated. Press Esc when done.' : tool === 'exit'
    ? 'Click the floor at a known exit. Choose another tool or press Esc when done.'
    : tool === 'blocked' ? 'Click the floor at a blocked passage. Press Esc when done.'
      : tool === 'waypoint' ? 'Click floor points in travel order, including turns around obstacles and the exit. Finish route or Esc ends drawing.'
        : 'Mark known exits on the floor. Fire starts headset guidance; Auto route also works in simulation. Draw route is manual.';
}


function calculateRoute(state, automatic = false) {
  if (!automatic) setAnnotationTool(state);
  // Never leave an old route visible after a failed replan.
  invalidateAutoRoute(state);
  const live = state.mode === 'live';
  if ((automatic || live) && !hasGuidancePose(state, performance.now())) {
    state.panel.querySelector('[data-edit]').textContent = 'Current headset position unavailable. Restore tracking and align before planning a route.';
    return;
  }
  const routeStart = state.position.clone();
  routeStart.y = state.floorY;
  const scanned = Boolean(state.scan?.model.visible);
  const room = scanned ? 'scan' : 'sample';
  const items = state.layouts[room];
  const blocked = items.filter((item) => item.type === 'blocked').map((item) => item.position);
  const exits = items.filter((item) => item.type === 'exit').map((item) => item.position)
    .filter((exit) => !blocked.some((point) => Math.hypot(exit[0] - point[0], exit[2] - point[2]) < 1.5 * (state.alignment?.scale || 1)));
  if (!exits.length && items.some((item) => item.type === 'exit')) {
    state.panel.querySelector('[data-edit]').textContent = 'All marked exits are blocked. Mark an available EXIT before planning.';
    return;
  }
  const result = planRoomRoute({
    surface: scanned ? state.scan.model : state.sample,
    bounds: state.bounds, floorY: state.floorY, start: routeStart.toArray(),
    exits, blocked,
    hazards: state.drillFireKey ? items.filter((item) => item.type === 'fire').map((item) => item.position)
      : state.firePositions[room], hazardRadius: 0.8 * (state.alignment?.scale || 1), relaxed: true,
  });
  if (result.error) { state.panel.querySelector('[data-edit]').textContent = result.error; return; }
  state.layouts[room] = items.filter((item) => item.type !== 'waypoint').concat(
    result.points.map((position) => ({ type: 'waypoint', position, source: 'geometry-draft' })));
  redrawAnnotations(state);
  state.panel.querySelector('[data-edit]').textContent =
    `Relaxed demo route from ${live ? 'current headset position' : 'current blue dot'} to EXIT (${((result.cells - 1) * result.step).toFixed(1)} model units). Avoids ignition points and scanned obstacles; not live fire spread. ${automatic ? 'Updates every 3 seconds.' : 'Click Auto route after moving.'} Preview only; verify the real path.`;
}

async function autoRoute(state, automatic = false) {
  const button = state.panel.querySelector('[data-action="auto-route"]');
  const status = state.panel.querySelector('[data-route-status]');
  if (button.disabled) return;
  const revision = state.routeRevision;
  const room = state.roomChoice;
  button.disabled = true;
  button.textContent = 'Planning...';
  status.hidden = false;
  status.textContent = 'Finding a route to EXIT around fire exclusion zones, obstacles and scan gaps...';
  if (!automatic) status.scrollIntoView({ block: 'nearest' });
  // Allow the browser to show progress before scanning mesh triangles.
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    if (state.disposed || revision !== state.routeRevision || room !== state.roomChoice
      || (automatic && !state.drillFireKey)) {
      status.textContent = 'Route cancelled because the room, fire or tracking changed.';
      return;
    }
    calculateRoute(state, automatic);
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
  panel.className = 'eileen-observer';
  panel.style.cssText = 'position:relative;background:#101b29;color:#e4eef8;font:16px/1.5 system-ui,sans-serif;';
  panel.innerHTML = `
    <style>
      .eileen-observer button { font:600 16px/1.3 system-ui; min-height:46px; }
      .eileen-observer button:disabled { opacity:.45; cursor:not-allowed !important; }
      .eileen-observer button:focus-visible { outline:3px solid #90dbff; outline-offset:3px; }
      .eileen-observer button[aria-pressed="true"] { box-shadow:0 0 0 2px #90dbff; }
      .eileen-observer [data-mark="drill-fire"] { background:#913c22 !important; border-color:#ffb283 !important; }
      .eileen-observer [data-mark="exit"], .eileen-observer [data-action="auto-route"] { background:#16563f !important; }
      .eileen-observer [data-mark="blocked"] { background:#74303a !important; }
      .eileen-observer input { background:#1b3044; color:#fff; border:1px solid #7293ad; padding:8px; font:inherit; border-radius:6px; }
      .eileen-observer [data-drill-status] { padding:12px 16px; background:#182e42; border-left:5px solid #58bfff; font-size:19px; font-weight:650; }
      .eileen-observer header > p { margin:9px 0; }
    </style>
    <header style="padding:18px 22px;border-bottom:1px solid #334456">
      <strong style="font-size:28px">FireDrill · Room observer</strong>
      <span data-room style="margin-left:14px;color:#a9bdcd">Sample room · 6 × 4 m · 1 m grid</span>
      <p>Blue marker = floor position · Arrow = head direction · Sphere = head height</p>
      <p data-drill-status role="status">Ready · mark exits, align the headset, then place Fire.</p>
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
        <button type="button" data-mark="drill-fire" aria-pressed="false">Fire (start drill)</button>
        <button type="button" data-action="remove-drill-fire">Remove drill fire</button>
        <button type="button" data-mark="blocked" aria-pressed="false">Mark blocked</button>
        <button type="button" data-mark="waypoint" aria-pressed="false">Draw route</button>
        <button type="button" data-action="auto-route">Auto route</button>
        <button type="button" data-action="finish">Finish route</button>
        <button type="button" data-action="undo">Undo mark</button>
        <button type="button" data-action="clear-marks">Clear marks</button>
        <button type="button" data-action="export">Export annotations</button>
        <button type="button" data-action="import-exits">Import default exits</button>
        <input data-import-exits type="file" accept=".json,application/json" hidden>
      </div>
      <p data-exit-defaults role="status"></p>
      <p data-edit role="status"></p>
      <p data-route-status role="status" hidden style="padding:12px;border:1px solid #edbe65;background:#302b20;color:#ffe0a3"></p>
      <p data-layout></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-mark="fire" aria-pressed="false">Place demo fire</button>
        <button type="button" data-action="auto-effects">Auto fire &amp; smoke</button>
        <button type="button" data-action="start-effects">Start smoke</button>
        <button type="button" data-action="stop-effects">Stop smoke</button>
        <button type="button" data-action="clear-fires">Clear fires</button>
        <button type="button" data-action="effects-sound" aria-pressed="false">Enable sound</button>
      </div>
      <p data-effects-status role="status"></p>
      <p data-load role="status">Loading 10_17_2026 scan… You can use the sample room while it loads.</p>
      <p data-status role="status" aria-live="polite"></p>
      <output data-pose style="font-family:monospace"></output>
      <p style="color:#a9bdcd;margin-bottom:0">Simulation: WASD move · Q/E turn · Hold C to crouch.<br>
        Drag to orbit · Scroll to zoom. Observer preview only; no collision or escape checks.</p>
    </header>`;
  for (const button of panel.querySelectorAll('button')) {
    button.style.cssText = 'background:#263b4e;border:1px solid #60788e;color:#eef7ff;border-radius:8px;padding:11px 16px;cursor:pointer';
  }
  host.append(panel);
  const viewport = document.createElement('div');
  viewport.dataset.viewport = '';
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
  if (!shared) scene.add(followCamera);
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
    firePositions: { sample: [], scan: [] }, effectsRunning: false, effectsStartedAt: 0,
    effects: createRoomEffects(root), soundEnabled: false,
    autoEffectsApplied: false,
    drillFireKey: '', routeRevision: 0, nextGuidanceAt: 0,
  };
  for (const [room, roomId] of [['sample', 'sample-room'], ['scan', '10_17_2026']]) {
    try { state.layouts[room] = readDefaultExits(window.localStorage, roomId); }
    catch { /* Missing or invalid defaults never prevent the room from loading. */ }
  }
  panel.querySelector('[data-import-exits]').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const scanned = Boolean(state.scan?.model.visible);
    const room = scanned ? 'scan' : 'sample';
    try {
      if (file.size > 1024 * 1024) throw new Error('Annotation file is too large.');
      const exits = exitDefaults(JSON.parse(await file.text()), scanned ? '10_17_2026' : 'sample-room');
      if (!exits.length) throw new Error('This file has no marked exits.');
      if (scanned !== Boolean(state.scan?.model.visible)) throw new Error('Room changed. Import again.');
      const other = state.layouts[room].filter((item) => item.type !== 'exit' && item.source !== 'geometry-draft');
      if (other.length + exits.length > 500) throw new Error('Too many marks. Clear marks before importing.');
      state.layouts[room] = [...other, ...exits];
      // Re-place demo hazards around restored exits, using the existing smoke state.
      if (state.firePositions[room].length) state.firePositions[room] = chooseFirePositions({ surface: scanned ? state.scan.model : state.sample,
        bounds: state.bounds, floorY: state.floorY, start: state.spawn.toArray(),
        exits: exits.map((item) => item.position), scale: state.alignment?.scale || 1 });
      redrawAnnotations(state);
      refreshEffects(state);
      if (!state.drillFireKey) void autoRoute(state);
    } catch (error) {
      panel.querySelector('[data-exit-defaults]').textContent = `Import failed: ${error.message}`;
    }
  });
  const invalidateAlignment = (message) => {
    state.alignment = null; state.rawPose = null; state.lastPose = null;
    panel.querySelector('[data-alignment]').textContent = message;
    invalidateAutoRoute(state);
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
        if (ready) { syncAnnotations(state); refreshEffects(state); }
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
    for (const key of ['sample', 'scan']) state.layouts[key] = state.layouts[key].filter((item) => item.type !== 'fire');
    invalidateAutoRoute(state);
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
    state.effectsRunning = false;
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
    refreshEffects(state);
    setView(state.viewTop);
    // Keep the multi-fire demo available explicitly; drill ignition is observer-controlled.
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
    if (action === 'import-exits') panel.querySelector('[data-import-exits]').click();
    if (action === 'auto-effects') autoFireAndSmoke(state);
    if (action === 'start-effects') {
      if (!state.firePositions[state.scan?.model.visible ? 'scan' : 'sample'].length) {
        panel.querySelector('[data-effects-status]').textContent = 'Place at least one fire first.';
      } else {
        if (!state.effectsRunning) state.effectsStartedAt = performance.now();
        state.effectsRunning = true; refreshEffects(state);
      }
    }
    if (action === 'stop-effects') { state.effectsRunning = false; refreshEffects(state); }
    if (action === 'clear-fires') {
      state.firePositions[state.scan?.model.visible ? 'scan' : 'sample'] = [];
      const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
      for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'fire') items.splice(i, 1);
      state.effectsRunning = false; invalidateAutoRoute(state); refreshEffects(state);
    }
    if (action === 'effects-sound') {
      state.soundEnabled = !state.soundEnabled;
      state.effects.enableSound(state.mode === 'live' && state.dualView ? followCamera : camera, state.soundEnabled);
      event.target.textContent = state.soundEnabled ? 'Mute sound' : 'Enable sound';
      event.target.setAttribute('aria-pressed', String(state.soundEnabled));
    }
    if (mark && !shared) setAnnotationTool(state, state.annotationTool === mark ? null : mark);
    const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
    if (action === 'finish') setAnnotationTool(state);
    if (action === 'auto-route') autoRoute(state);
    if (action === 'undo') {
      if (state.drillFireKey) for (let i = items.length - 1; i >= 0; i--)
        if (items[i].source === 'geometry-draft') items.splice(i, 1);
      undoAnnotation(items); invalidateAutoRoute(state);
    }
    if (action === 'clear-marks') { items.length = 0; setAnnotationTool(state); invalidateAutoRoute(state); }
    if (action === 'remove-drill-fire') {
      const index = items.findIndex((item) => item.type === 'fire');
      if (index >= 0) items.splice(index, 1);
      invalidateAutoRoute(state);
    }
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
      if (state.annotationTool === 'drill-fire') {
        const items = state.layouts[state.scan?.model.visible ? 'scan' : 'sample'];
        if (items.length >= 500 && !fireKey(items)) return;
        if (placeDrillFire(items, hit.point.toArray())) {
          state.firePositions[state.scan?.model.visible ? 'scan' : 'sample'] = [];
          invalidateAutoRoute(state);
        }
        return;
      }
      if (state.annotationTool === 'fire') {
        const fires = state.firePositions[state.scan?.model.visible ? 'scan' : 'sample'];
        if (fires.length >= 20) { panel.querySelector('[data-effects-status]').textContent = 'Maximum 20 fires. Clear fires to start again.'; return; }
        fires.push(hit.point.toArray()); invalidateAutoRoute(state); refreshEffects(state); return;
      }
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
    refreshEffects(state);
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
    state.effects.dispose();
    if (!shared) followCamera.removeFromParent();
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
  refreshEffects(state);
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
      state.effects.beforeView(camera, false);
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
          state.effects.beforeView(followCamera, true);
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
  const now = performance.now();
  s.panel.querySelector('[data-drill-status]').textContent = !s.drillFireKey
    ? 'Ready · mark exits, align the headset, then place Fire.'
    : hasGuidancePose(s, now) ? 'Fire active · live headset guidance updates every 3 seconds.'
      : 'Fire active · guidance paused: connect the headset and align fresh tracking.';
  if (s.drillFireKey && now >= s.nextGuidanceAt && !s.shared) {
    s.nextGuidanceAt = now + 3000;
    void autoRoute(s, true);
  }
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
  s.effects.update(step, waiting ? s.floorY + 1.6 : s.position.y);
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
