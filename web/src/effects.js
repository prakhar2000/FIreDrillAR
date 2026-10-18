import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* =====================================================================
   FireDrill AR — effects.js   (owner: Varnika)

   README section 7 contract (unchanged, still works):
     new Fire(position)       → .group (add to scene), .update(dt, growing), .intensity,
                                .startSound(), .stopSound()
     new Smoke(scene, camera) → .start(ceilingY), .update(dt, headY, fires) returns depth 0–1, .stop()
     new ExitSign(position, blocked) → .sprite, .position, .setBlocked(bool)

   The fire itself is one simulation for the whole room (recommended API):
     const fire = new FireSystem(scene, { surfaces })   surfaces = room.json surfaces
     fire.ignite(pos)                 start a fire at a point (snaps to the nearest fuel)
     fire.update(dt, { running })     running = drill on: heat spreads, fires grow and burn out
     fire.setExits(exitSigns)         open exits keep a fire-free zone around them
     fire.hotspots                    ≤ 8 × { position, intensity 0–1 } for heat / sound / smoke
     fire.totalIntensity              summed fire size (≈1 per fully burning table)
     fire.reset() · fire.startSound() · fire.stopSound() · fire.setSurfaces(surfaces)
     fire.setFuelMesh(scanMesh)       an unlabeled scan mesh as fuel (floor, flat furniture, walls)
     smoke.update(dt, headY, fire)    Smoke also takes the FireSystem directly

   `new Fire(pos)` ignites the shared default FireSystem (fireSystem()), which loads
   /api/room for its fuel if nobody calls setSurfaces(); without a room.json it burns the biggest
   mesh in the scene (the room scan). All Fire objects share it. Every ExitSign in a scene keeps
   fire away unless setExits() names the exits.

   How it burns: every fuel surface (tables, couches, … plus the floor as carpet and the walls)
   is split into ~0.2–0.5 m cells holding heat, fuel and flame. A cell heats up from burning
   neighbours (much faster upward), from radiant heat of nearby fires and from the hot plume
   above flames; it ignites at heat 1, grows, uses up its fuel, then chars and glows as embers.
   Burning bits drop from tabletops and can light the floor below.

   Rendering (built for Quest passthrough, premultiplied alpha):
     flames   one instanced draw: a flame tongue per burning cell (≤ maxFlames), playing the
              Unity Labs flipbook (textures/flames.png, CC0) or, without it, a noise-shader flame
     surfaces per-face overlay: char spreading over the real surface, glowing ember cracks,
              a hot front ahead of the flames
     embers, falling burning bits, thick black smoke rising off the flames (≤ 500 particles, + Smoke's 240)
     4 flickering PointLights on the biggest fires (range 9 m, brightness grows with fire size), and
              the same firelight drawn on the surface overlays so the real room glows orange in AR
     a glow drawn through the head fog
   createFireBloom(renderer, scene, camera) → .render(): desktop bloom (skipped in XR)
   ===================================================================== */

const FIRE_SOUND_URL = '/sounds/fire.mp3';
const SIGN_HEIGHT = 1.9;

// ---------------------------------------------------------------------
// Textures (generated, no image files needed)
// ---------------------------------------------------------------------
let _glowTex = null;
let _puffTex = null;
const _signTex = {};

function canvasTexture(w, h, draw, srgb = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  return (_glowTex ??= canvasTexture(64, 64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }));
}

// Wide gaussian-like falloff (no visible disc edge) for halos and the through-smoke glow
let _softGlowTex = null;
function softGlowTexture() {
  return (_softGlowTex ??= canvasTexture(128, 128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.2, 'rgba(255,255,255,0.6)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.06)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }));
}

function puffTexture() {
  return (_puffTex ??= canvasTexture(128, 128, (g, s) => {
    for (let i = 0; i < 16; i++) {
      const x = s / 2 + (Math.random() - 0.5) * s * 0.4;
      const y = s / 2 + (Math.random() - 0.5) * s * 0.4;
      const r = s * (0.14 + Math.random() * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    }
  }));
}

// Smooth tiling value noise for the flame and surface shaders. Sampling a texture (instead of
// hashing in the shader) stays clean at mediump on the Quest and costs one fetch per octave.
let _noiseTex = null;
function noiseTexture() {
  if (_noiseTex) return _noiseTex;
  const N = 64;
  let a = new Float32Array(N * N).map(() => Math.random());
  for (let pass = 0; pass < 2; pass++) { // wrap-around 3x3 blur, twice: soft, blob-like noise
    const b = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += a[((y + dy + N) % N) * N + ((x + dx + N) % N)];
        b[y * N + x] = s / 9;
      }
    }
    a = b;
  }
  let lo = 1, hi = 0;
  for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const v = Math.round(((a[i] - lo) / (hi - lo)) * 255); // stretch back to the full 0–1 range
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  _noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
  _noiseTex.magFilter = _noiseTex.minFilter = THREE.LinearFilter;
  _noiseTex.generateMipmaps = false;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

// Seamless, dense cloud tile for the smoke layers (blobs wrap around the edges)
let _layerTex = null;
function smokeLayerTexture() {
  return (_layerTex ??= canvasTexture(256, 256, (g, s) => {
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      const r = s * (0.12 + Math.random() * 0.16);
      const a = 0.25 + Math.random() * 0.25;
      for (let ox = -s; ox <= s; ox += s) {
        for (let oy = -s; oy <= s; oy += s) {
          const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          gr.addColorStop(0, `rgba(255,255,255,${a})`);
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = gr;
          g.fillRect(0, 0, s, s);
        }
      }
    }
  }));
}

// Largest bold Arial size (≤ px) at which text fits in maxW
function fitFont(g, text, px, maxW) {
  g.font = `bold ${px}px Arial, Helvetica, sans-serif`;
  const w = g.measureText(text).width;
  if (w > maxW) g.font = `bold ${Math.floor((px * maxW) / w)}px Arial, Helvetica, sans-serif`;
}

function signTexture(blocked) {
  const key = blocked ? 'blocked' : 'exit';
  return (_signTex[key] ??= canvasTexture(512, 256, (g, w, h) => {
    g.shadowColor = blocked ? 'rgba(255,40,40,0.9)' : 'rgba(40,255,120,0.9)';
    g.shadowBlur = 24;
    g.fillStyle = blocked ? '#c81e1e' : '#0f9d4a';
    roundRect(g, 24, 24, w - 48, h - 48, 26);
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    roundRect(g, 38, 38, w - 76, h - 76, 18);
    g.stroke();
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const maxW = w - 110;
    if (blocked) {
      fitFont(g, 'BLOCKED', 100, maxW);
      g.fillText('BLOCKED', w / 2, h / 2 - 20);
      fitFont(g, 'DO NOT USE', 46, maxW);
      g.fillText('DO NOT USE', w / 2, h / 2 + 54);
    } else {
      fitFont(g, 'EXIT', 140, maxW);
      g.fillText('EXIT', w / 2, h / 2 + 6);
    }
  }, true));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------------
// Passthrough-safe blending. Shaders output premultiplied color (rgb * a).
// ---------------------------------------------------------------------
function setBlend(mat, mode) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  if (mode === 'additive') {
    mat.blendDst = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneFactor;
  } else {
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  }
  return mat;
}

// Our shaders write display (sRGB) colours straight to the screen. The desktop bloom renders into a
// linear buffer first, so while it runs they convert to linear (rgb² ≈ sRGB → linear, cheap).
const LINEAR_OUT = { value: 0 };
// Strength of the firelight drawn on the surface overlays (set per frame from renderer.xr)
const LIGHT_GAIN = { value: 1 };
// (×0.85: overlapping flames blend in linear light there and would otherwise blow out to white under the bloom)
const LINEAR_GLSL = 'gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * gl_FragColor.rgb * 0.85, uLinear);';

// Point sprites sized in meters, correct on desktop and in each Quest eye.
const _viewport = new THREE.Vector4();

function particleMaterial(map, mode) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uHalfH: { value: 500 }, uLinear: LINEAR_OUT },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec4 aColor;
      uniform float uHalfH;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * length(modelMatrix[0].xyz) * uHalfH * projectionMatrix[1][1] / max(-mv.z, 0.05);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uLinear;
      varying vec4 vColor;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vColor.a;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor.rgb * a, a);
        ${LINEAR_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
  });
  return setBlend(mat, mode);
}

function makePoints(count, map, mode) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  const size = new Float32Array(count);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = particleMaterial(map, mode);
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; // positions move every frame
  pts.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(_viewport);
    mat.uniforms.uHalfH.value = (_viewport.w || renderer.domElement.height) * 0.5;
  };
  return { pts, geo, mat, pos, col, size };
}

function markDirty(geo) {
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aColor.needsUpdate = true;
  geo.attributes.aSize.needsUpdate = true;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Smooth "breathing" flicker around 1 (about 0.6–1.4): several sines, no Math.random
function flicker(t, seed) {
  return 1
    + 0.14 * Math.sin(t * 7.3 + seed)
    + 0.09 * Math.sin(t * 12.9 + seed * 2.1)
    + 0.05 * Math.sin(t * 23.7 + seed * 3.7)
    + 0.1 * Math.sin(t * 1.9 + seed * 0.7);
}

// ---------------------------------------------------------------------
// Audio: one AudioListener on the camera, one decoded fire buffer shared by all fires
// ---------------------------------------------------------------------
let _listener = null;
let _fireBuffer = null;
let _fireBufferPromise = null;

/** Attach (or find) the AudioListener on the camera. Smoke calls this for you. */
export function setAudioListener(camera) {
  if (!camera) return _listener;
  _listener = camera.children.find((c) => c.type === 'AudioListener') || _listener;
  if (!_listener) {
    try {
      _listener = new THREE.AudioListener();
      camera.add(_listener);
    } catch {
      return null; // no Web Audio available: effects still work, just silent
    }
  } else if (_listener.parent !== camera) {
    camera.add(_listener);
  }
  return _listener;
}

function loadFireBuffer() {
  if (_fireBuffer) return Promise.resolve(_fireBuffer);
  _fireBufferPromise ??= new THREE.AudioLoader()
    .loadAsync(FIRE_SOUND_URL)
    .then((b) => (_fireBuffer = b))
    .catch(() => {
      _fireBufferPromise = null; // missing file: stay silent, retry next startSound()
      return null;
    });
  return _fireBufferPromise;
}

// How far the viewer's head is in smoke (0–1). Smoke.update() writes it; fires use it to glow through the fog.
let _headFog = 0;

// =====================================================================
// Fuel: room.json surfaces → faces → burnable cells
// =====================================================================

// ign: how readily it heats up · spread: m/s a flame front crawls across it next to full flames
// burnTime: s of full flames before a cell's fuel is gone · flameH: m of flame at full burn
const MATS = [
  { name: 'fabric', ign: 1.5, spread: 0.075, burnTime: 70, flameH: 0.9 },
  { name: 'wood', ign: 1.0, spread: 0.05, burnTime: 100, flameH: 0.7 },
  // carpet can't carry a flame front on its own: it only keeps spreading near other fires' heat
  { name: 'carpet', ign: 0.28, spread: 0.007, burnTime: 35, flameH: 0.42 },
  { name: 'wall', ign: 0.3, spread: 0.022, burnTime: 45, flameH: 0.9 },
  { name: 'pile', ign: 1.0, spread: 0.05, burnTime: 110, flameH: 0.75 },
];
const M_FABRIC = 0, M_WOOD = 1, M_CARPET = 2, M_WALL = 3, M_PILE = 4;
const K_TOP = 0, K_SIDE = 1, K_FLOOR = 2, K_WALL = 3;

const CELL_FURNITURE = 0.2;
const CELL_ROOM = 0.45;      // floor and walls (grown for big rooms, see MAX_ROOM_CELLS)
const MAX_ROOM_CELLS = 2400;
const APRON = 0.1;           // tables/desks (flat planes) burn on top and a thin edge, not down to the floor
const PILE_SIZE = 0.9;       // fuel patch made when a fire is placed where there's no fuel

/** Which fuel a room.json label is: 'floor', 'wall', a furniture material index, or null (not fuel) */
function fuelKind(label) {
  const l = String(label || '').toLowerCase();
  if (/global|invisible|art|door|window|ceiling|opening|frame/.test(l)) return null;
  if (/floor/.test(l)) return 'floor';
  if (/wall/.test(l)) return 'wall';
  if (/couch|sofa|bed|chair|curtain|cushion|seat/.test(l)) return M_FABRIC;
  if (/table|desk|shelf|storage|cabinet|screen|lamp|plant|dresser|wardrobe|other/.test(l)) return M_WOOD;
  return null;
}

function readPoints(s) {
  const src = s.polygon ?? s.vertices;
  if (!src || !src.length) return [];
  const out = [];
  if (typeof src[0] === 'number') {
    for (let i = 0; i + 2 < src.length; i += 3) out.push(new THREE.Vector3(src[i], src[i + 1], src[i + 2]));
  } else {
    for (const q of src) {
      if (Array.isArray(q)) out.push(new THREE.Vector3(q[0], q[1], q[2]));
      else out.push(new THREE.Vector3(q.x, q.y, q.z));
    }
  }
  return out;
}

/**
 * Yaw-aligned box around a surface in world space. The yaw comes from the surface's pose
 * (any local axis that lies flat), so rotated furniture gets a tight box, not a world AABB.
 * Works for WebXR planes (polygon in plane-local x/z, y = normal), meshes, and plain world points.
 */
function orientedBox(s) {
  const m = new THREE.Matrix4();
  if (Array.isArray(s.matrix) && s.matrix.length === 16) m.fromArray(s.matrix);
  const pts = readPoints(s).map((p) => p.applyMatrix4(m));
  if (pts.length < 2) return null;
  const e = m.elements;
  let ux = 1, uz = 0;
  for (const [x, z] of [[e[0], e[2]], [e[4], e[6]], [e[8], e[10]]]) {
    const h = Math.hypot(x, z);
    const len = Math.hypot(x, z, e[1]);
    if (h > 0.7 * len && h > 1e-6) { ux = x / h; uz = z / h; break; }
  }
  const wx = -uz, wz = ux;
  const b = { ux, uz, wx, wz, a0: Infinity, a1: -Infinity, b0: Infinity, b1: -Infinity, y0: Infinity, y1: -Infinity, pts };
  for (const p of pts) {
    const a = p.x * ux + p.z * uz, c = p.x * wx + p.z * wz;
    b.a0 = Math.min(b.a0, a); b.a1 = Math.max(b.a1, a);
    b.b0 = Math.min(b.b0, c); b.b1 = Math.max(b.b1, c);
    b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y);
  }
  return b;
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Split the room into burnable faces and cells.
 * @returns {{faces, objects, n, ceilingY, floorY, center}} plus per-cell typed arrays
 */
function buildFuel(surfaces, piles) {
  const faces = [];
  const objects = [];
  let floorY = null, ceilingY = null;
  const boxes = [];
  for (const s of surfaces || []) {
    const label = String(s.label || '').toLowerCase();
    const box = orientedBox(s);
    if (/ceiling/.test(label)) {
      const m = new THREE.Matrix4();
      if (Array.isArray(s.matrix) && s.matrix.length === 16) m.fromArray(s.matrix);
      ceilingY = box ? box.y1 : new THREE.Vector3().setFromMatrixPosition(m).y;
      continue;
    }
    const kind = fuelKind(label);
    if (kind === null || !box) continue;
    if (kind === 'floor') floorY = floorY === null ? box.y1 : Math.min(floorY, box.y1);
    boxes.push({ s, label, kind, box });
  }
  floorY ??= 0;
  ceilingY ??= 2.6;

  // room center: wall normals point toward it
  const center = new THREE.Vector3();
  {
    const floor = boxes.find((b) => b.kind === 'floor');
    const list = floor ? [floor] : boxes;
    for (const { box } of list) {
      const a = (box.a0 + box.a1) / 2, c = (box.b0 + box.b1) / 2;
      center.x += a * box.ux + c * box.wx;
      center.z += a * box.uz + c * box.wz;
    }
    if (list.length) center.multiplyScalar(1 / list.length);
  }

  // floor + walls share a cell budget: bigger cells in big rooms
  let roomArea = 0;
  for (const { kind, box } of boxes) {
    if (kind === 'floor') roomArea += (box.a1 - box.a0) * (box.b1 - box.b0);
    if (kind === 'wall') roomArea += Math.max(box.a1 - box.a0, box.b1 - box.b0) * (box.y1 - box.y0);
  }
  const roomCell = Math.max(CELL_ROOM, Math.sqrt(roomArea / MAX_ROOM_CELLS));

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const UP = V(0, 1, 0);
  const addFace = (obj, key, kind, mat, o, U, lu, Vd, lv, N, cs, extra = {}) => {
    if (lu < 0.04 || lv < 0.02) return;
    const nu = Math.max(1, Math.round(lu / cs)), nv = Math.max(1, Math.round(lv / cs));
    const f = { key, kind, mat, o, U, V: Vd, N, lu, lv, nu, nv, obj, drop: false, poly: null, ...extra };
    faces.push(f);
    obj.faces.push(f);
  };

  boxes.forEach(({ s, label, kind, box }, si) => {
    const { ux, uz, wx, wz, a0, a1, b0, b1, y0, y1 } = box;
    const P = (a, y, c) => V(a * ux + c * wx, y, a * uz + c * wz);
    const U = V(ux, 0, uz), W = V(wx, 0, wz);
    const obj = { label, faces: [] };
    objects.push(obj);
    const flat = y1 - y0 < 0.06;
    const poly = flat && s.kind !== 'mesh' && box.pts.length >= 3 ? box.pts : null;

    if (kind === 'floor') {
      addFace(obj, `s${si}`, K_FLOOR, M_CARPET, P(a0, y1, b0), U, a1 - a0, W, b1 - b0, UP, roomCell, { poly });
      return;
    }
    if (kind === 'wall') {
      if (y1 - y0 < 0.5) return;
      const alongU = a1 - a0 >= b1 - b0;
      const mid = alongU ? (b0 + b1) / 2 : (a0 + a1) / 2;
      const o = alongU ? P(a0, y0, mid) : P(mid, y0, b0);
      const dir = alongU ? U : W;
      const n = (alongU ? W : U).clone();
      if (n.dot(V(center.x - o.x, 0, center.z - o.z)) < 0) n.negate();
      addFace(obj, `s${si}`, K_WALL, M_WALL, o, dir, alongU ? a1 - a0 : b1 - b0, UP, y1 - y0, n, roomCell);
      return;
    }
    // furniture: top + sides (flat planes like tables get a thin apron; boxes burn down to their base)
    const top = y1;
    const bottom = flat ? Math.max(floorY, top - APRON) : y0;
    const cs = (a1 - a0) * (b1 - b0) > 4 ? 0.3 : CELL_FURNITURE;
    addFace(obj, `s${si}t`, K_TOP, kind, P(a0, top, b0), U, a1 - a0, W, b1 - b0, UP, cs, { poly, drop: flat });
    const h = top - bottom;
    if (h > 0.03) {
      addFace(obj, `s${si}a`, K_SIDE, kind, P(a1, bottom, b0), W, b1 - b0, UP, h, U.clone(), cs);
      addFace(obj, `s${si}b`, K_SIDE, kind, P(a0, bottom, b0), W, b1 - b0, UP, h, U.clone().negate(), cs);
      addFace(obj, `s${si}c`, K_SIDE, kind, P(a0, bottom, b1), U, a1 - a0, UP, h, W.clone(), cs);
      addFace(obj, `s${si}d`, K_SIDE, kind, P(a0, bottom, b0), U, a1 - a0, UP, h, W.clone().negate(), cs);
    }
  });

  // fuel patches where a fire was placed with nothing burnable around (AR with no room scan yet)
  piles.forEach((p, pi) => {
    const obj = { label: 'fire', faces: [] };
    objects.push(obj);
    const h = PILE_SIZE / 2;
    addFace(obj, `p${pi}`, K_TOP, M_PILE, V(p.x - h, p.y, p.z - h), V(1, 0, 0), PILE_SIZE, V(0, 0, 1), PILE_SIZE, UP, CELL_FURNITURE);
  });

  // cells
  let n = 0;
  for (const f of faces) { f.start = n; f.count = f.nu * f.nv; n += f.count; }
  const c = {
    n, faces, objects, floorY, ceilingY, center,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    face: new Uint16Array(n), mat: new Uint8Array(n), size: new Float32Array(n), area: new Float32Array(n),
    dead: new Uint8Array(n),  // 1 = outside the surface polygon: never burns
    edge: new Uint8Array(n),  // on the border of its face (tabletop edges drop burning bits)
    seed: new Float32Array(n),
  };
  faces.forEach((f, fi) => {
    const du = f.lu / f.nu, dv = f.lv / f.nv;
    f.du = du; f.dv = dv;
    for (let j = 0; j < f.nv; j++) {
      for (let i = 0; i < f.nu; i++) {
        const k = f.start + j * f.nu + i;
        const px = f.o.x + f.U.x * (i + 0.5) * du + f.V.x * (j + 0.5) * dv;
        const py = f.o.y + f.U.y * (i + 0.5) * du + f.V.y * (j + 0.5) * dv;
        const pz = f.o.z + f.U.z * (i + 0.5) * du + f.V.z * (j + 0.5) * dv;
        c.x[k] = px; c.y[k] = py; c.z[k] = pz;
        c.face[k] = fi; c.mat[k] = f.mat;
        c.size[k] = Math.max(du, dv); c.area[k] = du * dv;
        c.dead[k] = f.poly && !pointInPoly(px, pz, f.poly) ? 1 : 0;
        c.edge[k] = i === 0 || j === 0 || i === f.nu - 1 || j === f.nv - 1 ? 1 : 0;
        c.seed[k] = Math.random();
      }
    }
  });

  // neighbours, as a compact list per cell. Weight = how strongly j heats i:
  // upward (j below i) up to 3x, downward as low as 0.3x.
  const lists = Array.from({ length: n }, () => []);
  const dirW = (i, j, base) => {
    const dx = c.x[i] - c.x[j], dy = c.y[i] - c.y[j], dz = c.z[i] - c.z[j];
    const s = dy / (Math.hypot(dx, dy, dz) || 1);
    return base * (s > 0 ? 1 + 2 * s : 1 + 0.7 * s);
  };
  for (const f of faces) {
    for (let j = 0; j < f.nv; j++) {
      for (let i = 0; i < f.nu; i++) {
        const k = f.start + j * f.nu + i;
        if (c.dead[k]) continue;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= f.nu || jj >= f.nv) continue;
            const q = f.start + jj * f.nu + ii;
            if (!c.dead[q]) lists[k].push(q, dirW(k, q, di && dj ? 0.6 : 1));
          }
        }
      }
    }
  }
  // across faces: table edge ↔ its apron, couch side ↔ floor, wall ↔ floor, furniture ↔ wall behind it
  const HB = 0.6;
  const hash = new Map();
  const hk = (x, y, z) => `${Math.floor(x / HB)},${Math.floor(y / HB)},${Math.floor(z / HB)}`;
  for (let k = 0; k < n; k++) {
    if (c.dead[k]) continue;
    const key = hk(c.x[k], c.y[k], c.z[k]);
    let b = hash.get(key);
    if (!b) hash.set(key, (b = []));
    b.push(k);
  }
  for (let k = 0; k < n; k++) {
    if (c.dead[k]) continue;
    const bx = Math.floor(c.x[k] / HB), by = Math.floor(c.y[k] / HB), bz = Math.floor(c.z[k] / HB);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = hash.get(`${bx + dx},${by + dy},${bz + dz}`);
      if (!b) continue;
      for (const q of b) {
        if (c.face[q] === c.face[k]) continue;
        const d = Math.hypot(c.x[k] - c.x[q], c.y[k] - c.y[q], c.z[k] - c.z[q]);
        if (d < 0.55 * (c.size[k] + c.size[q])) lists[k].push(q, dirW(k, q, 0.8));
      }
    }
  }
  c.nStart = new Int32Array(n + 1);
  let total = 0;
  for (let k = 0; k < n; k++) { c.nStart[k] = total; total += lists[k].length / 2; }
  c.nStart[n] = total;
  c.nIdx = new Int32Array(total);
  c.nW = new Float32Array(total);
  for (let k = 0, p = 0; k < n; k++) {
    const l = lists[k];
    for (let m = 0; m < l.length; m += 2, p++) { c.nIdx[p] = l[m]; c.nW[p] = l[m + 1]; }
  }
  // world bounds per face, to skip far-away fires quickly
  for (const f of faces) {
    const bb = new THREE.Box3();
    for (let k = f.start; k < f.start + f.count; k++) bb.expandByPoint(V(c.x[k], c.y[k], c.z[k]));
    f.bb = bb;
  }
  return c;
}

// ---------------------------------------------------------------------
// Fuel from an unlabeled scan mesh (the room OBJ): reads its triangles, no labels needed.
//   floor     = the most common lowest flat height
//   furniture = flat patches 0.25–1.4 m above the floor (under 0.6 m: a couch-like box down to the
//               floor; higher: a table top with an apron)
//   walls     = sides of the floor's footprint where the scan has vertical surfaces
//   ceiling   = the scan's top, at least 2.4 m above the floor (scans often stop short of it)
// Returns room.json-style surfaces (identity matrices) in world space, or in `relativeTo`'s local
// space when given (e.g. the scan's own coordinates under a scaled, rotated room group).
// ---------------------------------------------------------------------
export function surfacesFromMesh(root, { cell = 0.2, relativeTo = null } = {}) {
  (relativeTo || root).updateMatrixWorld(true);
  const inv = relativeTo ? new THREE.Matrix4().copy(relativeTo.matrixWorld).invert() : null;
  const meshMatrix = (o) => (inv ? new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) : o.matrixWorld);
  const box = new THREE.Box3(), pv = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position, m = meshMatrix(o);
    for (let k = 0; k < pos.count; k++) box.expandByPoint(pv.fromBufferAttribute(pos, k).applyMatrix4(m));
  });
  if (box.isEmpty()) return [];
  const x0 = box.min.x, z0 = box.min.z;
  const nx = Math.max(1, Math.ceil((box.max.x - x0) / cell)), nz = Math.max(1, Math.ceil((box.max.z - z0) / cell));
  const low = new Float32Array(nx * nz).fill(Infinity);
  const flat = [];  // horizontal triangles: [minI, maxI, minJ, maxJ, y]
  const vert = [];  // vertical triangles: [x, z, area]
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  const ci = (x) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cell)));
  const cj = (z) => Math.min(nz - 1, Math.max(0, Math.floor((z - z0) / cell)));
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, m = meshMatrix(o);
    const count = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m);
      b.fromBufferAttribute(pos, ib).applyMatrix4(m);
      c.fromBufferAttribute(pos, ic).applyMatrix4(m);
      n.subVectors(b, a).cross(e.subVectors(c, a));
      const len = n.length();
      if (len < 1e-9) continue;
      const ny = Math.abs(n.y) / len;
      if (ny > 0.85) {
        const y = (a.y + b.y + c.y) / 3;
        const i0 = ci(Math.min(a.x, b.x, c.x)), i1 = ci(Math.max(a.x, b.x, c.x));
        const j0 = cj(Math.min(a.z, b.z, c.z)), j1 = cj(Math.max(a.z, b.z, c.z));
        flat.push(i0, i1, j0, j1, y);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (y < low[j * nx + i]) low[j * nx + i] = y;
      } else if (ny < 0.25) {
        vert.push((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, len / 2);
      }
    }
  });
  // floor = the most common lowest height (2 cm bins)
  const hist = new Map();
  for (const v of low) if (v !== Infinity) { const k = Math.round(v / 0.02); hist.set(k, (hist.get(k) || 0) + 1); }
  if (!hist.size) return [];
  let floorK = 0, best = -1;
  for (const [k, v] of hist) if (v > best) { best = v; floorK = k; }
  const floorY = floorK * 0.02;
  const isFloor = new Uint8Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) isFloor[k] = Math.abs(low[k] - floorY) < 0.1 ? 1 : 0;
  // furniture tops: highest flat surface per cell between 0.25 and 1.4 m above the floor
  const topY = new Float32Array(nx * nz).fill(-Infinity);
  for (let t = 0; t < flat.length; t += 5) {
    const y = flat[t + 4];
    if (y < floorY + 0.25 || y > floorY + 1.4) continue;
    for (let j = flat[t + 2]; j <= flat[t + 3]; j++) for (let i = flat[t]; i <= flat[t + 1]; i++) {
      if (y > topY[j * nx + i]) topY[j * nx + i] = y;
    }
  }
  const surfaces = [];
  const seen = new Uint8Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) {
    if (seen[k] || topY[k] === -Infinity) continue;
    // flood fill a patch of similar height
    const stack = [k], cells = [];
    seen[k] = 1;
    while (stack.length) {
      const q = stack.pop(); cells.push(q);
      const i = q % nx, j = (q / nx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const r = jj * nx + ii;
        if (!seen[r] && topY[r] !== -Infinity && Math.abs(topY[r] - topY[q]) < 0.12) { seen[r] = 1; stack.push(r); }
      }
    }
    if (cells.length < 4 || cells.length * cell * cell > 8) continue; // specks, or not furniture
    let i0 = nx, i1 = 0, j0 = nz, j1 = 0, ySum = 0;
    for (const q of cells) {
      const i = q % nx, j = (q / nx) | 0;
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); ySum += topY[q];
    }
    const y = ySum / cells.length;
    const ax = x0 + i0 * cell, bx = x0 + (i1 + 1) * cell, az = z0 + j0 * cell, bz = z0 + (j1 + 1) * cell;
    if (y - floorY < 0.6) {
      const v = [];
      for (const px of [ax, bx]) for (const py of [floorY, y]) for (const pz of [az, bz]) v.push(px, py, pz);
      surfaces.push({ kind: 'mesh', label: 'couch', vertices: v, indices: [] });
    } else {
      surfaces.push({ kind: 'plane', label: 'table', polygon: [[ax, y, az], [bx, y, az], [bx, y, bz], [ax, y, bz]] });
    }
  }
  // floor outline = convex hull of the floor cells
  const pts = [];
  for (let k = 0; k < nx * nz; k++) if (isFloor[k]) pts.push([x0 + ((k % nx) + 0.5) * cell, z0 + (((k / nx) | 0) + 0.5) * cell]);
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hull = [];
  for (const pass of [pts, pts.slice().reverse()]) {
    const h = [];
    for (const p of pass) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); }
    h.pop(); hull.push(...h);
  }
  if (hull.length >= 3) surfaces.push({ kind: 'plane', label: 'floor', polygon: hull.map(([px, pz]) => [px, floorY, pz]) });
  // walls on the sides of the floor's footprint that the scan actually has
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  for (const [px, pz] of pts) { fx0 = Math.min(fx0, px); fx1 = Math.max(fx1, px); fz0 = Math.min(fz0, pz); fz1 = Math.max(fz1, pz); }
  const ceil = Math.max(box.max.y, floorY + 2.4);
  const sides = [
    [[fx0, fz0], [fx0, fz1], 'x', fx0], [[fx1, fz0], [fx1, fz1], 'x', fx1],
    [[fx0, fz0], [fx1, fz0], 'z', fz0], [[fx0, fz1], [fx1, fz1], 'z', fz1],
  ];
  for (const [p, q, axis, at] of sides) {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1) continue;
    let area = 0;
    for (let t = 0; t < vert.length; t += 3) if (Math.abs((axis === 'x' ? vert[t] : vert[t + 1]) - at) < 0.35) area += vert[t + 2];
    if (area < 0.25 * length) continue; // open side: no wall to burn
    surfaces.push({ kind: 'plane', label: 'wall', polygon: [[p[0], floorY, p[1]], [q[0], floorY, q[1]], [q[0], ceil, q[1]], [p[0], ceil, p[1]]] });
  }
  surfaces.push({ kind: 'plane', label: 'ceiling', polygon: [[box.min.x, ceil, box.min.z], [box.max.x, ceil, box.min.z], [box.max.x, ceil, box.max.z], [box.min.x, ceil, box.max.z]] });
  return surfaces;
}

// =====================================================================
// FireSim: the heat/fuel/flame simulation (no rendering; runs in Node too)
// =====================================================================
const TICK = 0.1;            // s per simulation step (10 Hz)
const IDLE_BURN = 0.45;      // flame size a fire holds before the drill starts
const GROW = 0.35;           // 1/s: how fast a cell's flames grow toward full
const COOL = 0.04;           // 1/s: heat lost to the room (weak, distant heat never ignites)
const RAD_MAX = 0.14;        // radiant heat gain (1/s) facing a wall of flame: saturates, so a huge
const RAD_SAT = 1.2;         // fire across the room never cooks everything (see _spreadHeat)
const PLUME_K = 1.6;         // hot gases rising off flames into whatever is above
const RAD_RANGE = 3.5;       // m
const BUCKET = 0.5;          // m: burning cells are grouped into buckets for radiant heat
const DROP_RATE = 0.03;      // burning bits per second per burning tabletop edge cell
const DROP_HEAT = 0.45;      // heat a landing burning bit adds to the floor
const SPOT_MERGE = 1.2;      // m: buckets closer than this form one hotspot
const MAX_SPOTS = 8;
const E_UNIT = 0.6;          // m² of full ~0.8 m flame = intensity 1 (≈ a fully burning table)

export class FireSim {
  constructor({ speed = 1, exitClearance = 1.5, surfaces = [] } = {}) {
    this.speed = speed;
    this.exitClearance = exitClearance;
    this.surfaces = surfaces || [];
    this.piles = [];
    this.ignitions = [];
    this.exits = [];
    this.time = 0;
    this.version = 0;
    this.hotspots = [];
    this.totalIntensity = 0;
    this.burning = [];       // indices of burning cells (rebuilt every tick)
    this.drops = [];         // burning bits in the air: { x, y, z, vy, cell, t }
    this.newDrops = [];      // drops started this tick (the renderer animates them)
    this._build();
  }

  _build() {
    Object.assign(this, buildFuel(this.surfaces, this.piles));
    const n = this.n;
    this.heat = new Float32Array(n);
    this.fuel = new Float32Array(n).fill(1);
    this.burn = new Float32Array(n);
    this.ember = new Float32Array(n);
    this.state = new Uint8Array(n);   // 0 unburned · 1 burning · 2 burnt out
    this.prot = new Uint8Array(n);    // 1 = near an open exit: never ignites by spreading
    this.burning.length = 0;
    this.drops.length = 0;
    this._bx = []; this._by = []; this._bz = []; this._bE = []; this._bMap = new Map();
    this.version++;
    this._buckets(); // fresh hotspots (empty)
  }

  setSurfaces(surfaces) {
    this.surfaces = surfaces || [];
    this.piles.length = 0;
    this._build();
    const ign = this.ignitions.splice(0);
    for (const p of ign) this.ignite(p);
  }

  setExits(exits) { this.exits = exits || []; }

  reset() {
    this.piles.length = 0;
    this.ignitions.length = 0;
    this.time = 0;
    this._build();
  }

  /** Index of the closest burnable cell within maxD of (x, y, z), or -1 */
  nearestCell(x, y, z, maxD = 0.6) {
    let best = -1, bd = maxD * maxD;
    for (let i = 0; i < this.n; i++) {
      if (this.dead[i]) continue;
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2 + (this.z[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Start a fire at a point. Returns the cell index. pile = always start a burning object there
   *  (a 0.9 m fuel patch) instead of lighting whatever surface is under it */
  ignite(p, strength = 0.25, pile = false) {
    if (pile) p = { x: p.x, y: p.y + 0.03, z: p.z }; // just above the floor it stands on
    let i = pile ? -1 : this.nearestCell(p.x, p.y, p.z);
    if (i < 0) {
      // nothing burnable here: add a small fuel patch, keeping the state of everything else
      const saved = this._snapshot();
      this.piles.push({ x: p.x, y: p.y, z: p.z });
      this._build();
      this._restore(saved);
      i = this.nearestCell(p.x, p.y, p.z);
    }
    this.ignitions.push({ x: p.x, y: p.y, z: p.z });
    if (i >= 0) {
      this._ignite(i, strength);
      // a small cluster, not a lone tongue: light the closest neighbours on the same surface a little
      let lit = 0;
      for (let k = this.nStart[i]; k < this.nStart[i + 1] && lit < 2; k++) {
        const j = this.nIdx[k];
        if (this.face[j] === this.face[i] && this.nW[k] >= 1 && !this.state[j]) { this._ignite(j, strength * 0.6); lit++; }
      }
    }
    this._buckets();
    return i;
  }

  _ignite(i, strength) {
    if (this.state[i] === 1) { this.burn[i] = Math.max(this.burn[i], strength); return; }
    this.state[i] = 1;
    this.heat[i] = 1;
    this.fuel[i] = Math.max(this.fuel[i], 0.3);
    this.burn[i] = Math.max(this.burn[i], strength);
  }

  _snapshot() {
    const out = new Map();
    for (const f of this.faces) {
      const s = f.start, e = s + f.count;
      out.set(f.key, {
        count: f.count, heat: this.heat.slice(s, e), fuel: this.fuel.slice(s, e), burn: this.burn.slice(s, e),
        ember: this.ember.slice(s, e), state: this.state.slice(s, e),
      });
    }
    return out;
  }

  _restore(saved) {
    for (const f of this.faces) {
      const o = saved.get(f.key);
      if (!o || o.count !== f.count) continue;
      this.heat.set(o.heat, f.start); this.fuel.set(o.fuel, f.start); this.burn.set(o.burn, f.start);
      this.ember.set(o.ember, f.start); this.state.set(o.state, f.start);
    }
  }

  /** One fixed step. running = drill on (spread + burn-out); otherwise fires just hold. */
  tick(dt, running) {
    const { n, heat, fuel, burn, state, ember } = this;
    const sp = this.speed;
    if (running) {
      this.time += dt;
      this._protect();
      this._spreadHeat(dt * sp);
      this._dropBits(dt * sp);
    }
    // burning cells: grow toward what their fuel supports, use it up, char
    for (let i = 0; i < n; i++) {
      if (state[i] === 1) {
        let target = Math.min(1, fuel[i] * 2.5);
        if (!running) target = Math.min(target, IDLE_BURN);
        const rate = target > burn[i] ? GROW * (running ? sp : 1) : 0.8;
        burn[i] += (target - burn[i]) * Math.min(1, dt * rate);
        if (running) {
          fuel[i] -= (burn[i] * dt * sp) / MATS[this.mat[i]].burnTime;
          if (fuel[i] <= 0.01) { fuel[i] = 0; state[i] = 2; ember[i] = 1; burn[i] = 0; }
        }
      } else if (state[i] === 2 && ember[i] > 0) {
        ember[i] = Math.max(0, ember[i] - dt * 0.035);
      }
    }
    this._buckets();
  }

  _protect() {
    const r2 = this.exitClearance * this.exitClearance;
    const open = this.exits.filter((e) => e && !e.blocked && e.position);
    for (let i = 0; i < this.n; i++) {
      let p = 0;
      for (const e of open) {
        const dx = this.x[i] - e.position.x, dz = this.z[i] - e.position.z;
        if (dx * dx + dz * dz < r2) { p = 1; break; }
      }
      this.prot[i] = p;
    }
  }

  // burning cells → radiant buckets (E = m² of full flame) → hotspots
  _buckets() {
    const { _bx: bx, _by: by, _bz: bz, _bE: bE, _bMap: map } = this;
    map.clear();
    let nb = 0;
    const list = this.burning;
    list.length = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== 1) continue;
      list.push(i);
      // radiant power ~ flame surface: low carpet flames count for less than a burning couch
      const m = MATS[this.mat[i]];
      const e = this.burn[i] * this.area[i] * m.flameH * (1 / 0.8);
      const key = Math.floor(this.x[i] / BUCKET) * 1e6 + Math.floor(this.y[i] / BUCKET) * 1e3 + Math.floor(this.z[i] / BUCKET);
      let b = map.get(key);
      if (b === undefined) { b = nb++; map.set(key, b); bx[b] = by[b] = bz[b] = bE[b] = 0; }
      // flames radiate from above the surface
      const fy = this.y[i] + 0.35 * m.flameH * this.burn[i];
      bx[b] += this.x[i] * e; by[b] += fy * e; bz[b] += this.z[i] * e; bE[b] += e;
    }
    for (let b = 0; b < nb; b++) { const e = bE[b] || 1; bx[b] /= e; by[b] /= e; bz[b] /= e; }
    this._nb = nb;

    // hotspots: greedy clusters of buckets, biggest first
    const order = Array.from({ length: nb }, (_, b) => b).sort((p, q) => bE[q] - bE[p]);
    const spots = [];
    const m2 = SPOT_MERGE * SPOT_MERGE;
    let total = 0;
    for (const b of order) {
      total += bE[b];
      let best = null, bd = Infinity;
      for (const s of spots) {
        const d = (s.x - bx[b]) ** 2 + (s.z - bz[b]) ** 2 + (s.y - by[b]) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (!best || (bd > m2 && spots.length < MAX_SPOTS)) spots.push({ x: bx[b], y: by[b], z: bz[b], E: bE[b] });
      else {
        const e = best.E + bE[b];
        best.x = (best.x * best.E + bx[b] * bE[b]) / e;
        best.y = (best.y * best.E + by[b] * bE[b]) / e;
        best.z = (best.z * best.E + bz[b] * bE[b]) / e;
        best.E = e;
      }
    }
    spots.sort((p, q) => q.E - p.E);
    while (this.hotspots.length < spots.length) this.hotspots.push({ position: new THREE.Vector3(), intensity: 0, area: 0 });
    this.hotspots.length = spots.length;
    spots.forEach((s, k) => {
      const h = this.hotspots[k];
      h.position.set(s.x, s.y, s.z);
      h.area = s.E;
      h.intensity = Math.min(1, s.E / E_UNIT);
    });
    this.totalIntensity = total / E_UNIT;
  }

  _spreadHeat(dt) {
    const { heat, state, burn, nStart, nIdx, nW, x, y, z, size, dead, prot } = this;
    const { _bx: bx, _by: by, _bz: bz, _bE: bE } = this;
    const nb = this._nb;
    const R2 = RAD_RANGE * RAD_RANGE;
    const rel = this._rel ??= [];
    for (const f of this.faces) {
      // fires within range of this face
      rel.length = 0;
      const bb = f.bb;
      for (let b = 0; b < nb; b++) {
        const dx = Math.max(bb.min.x - bx[b], 0, bx[b] - bb.max.x);
        const dy = Math.max(bb.min.y - by[b], 0, by[b] - bb.max.y);
        const dz = Math.max(bb.min.z - bz[b], 0, bz[b] - bb.max.z);
        if (dx * dx + dy * dy + dz * dz < R2) rel.push(b);
      }
      const m = MATS[f.mat];
      const end = f.start + f.count;
      for (let i = f.start; i < end; i++) {
        if (state[i] !== 0 || dead[i]) continue;
        let cond = 0;
        for (let k = nStart[i]; k < nStart[i + 1]; k++) {
          const j = nIdx[k];
          if (state[j] === 1) cond += burn[j] * nW[k];
        }
        if (!cond && !rel.length) { heat[i] -= heat[i] * COOL * dt; continue; }
        let rad = 0;
        for (let r = 0; r < rel.length; r++) {
          const b = rel[r];
          const dx = bx[b] - x[i], dy = by[b] - y[i], dz = bz[b] - z[i];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > R2) continue;
          const fall = d2 < 6.25 ? 1 : 1 - (Math.sqrt(d2) - 2.5);
          // flames almost straight overhead (a tabletop over the floor) mostly radiate sideways and up
          rad += (bE[b] * fall * (dy > 0.7 * Math.sqrt(d2) ? 0.4 : 1)) / (d2 + 0.25);
          if (dy < 0) { // flames below this cell: the hot plume rises into it
            const h2 = dx * dx + dz * dz;
            if (h2 < 0.6) rad += (bE[b] * PLUME_K * Math.exp(-h2 / 0.12)) / (1 + 0.6 * -dy);
          }
        }
        // radiant heat saturates (a fire can only fill so much of what a surface 'sees'), so heat
        // that never beats COOL can't ignite anything: distant floor and walls stay unburned
        const gain = (cond * m.spread) / size[i] + RAD_MAX * m.ign * (1 - Math.exp(-rad / RAD_SAT));
        heat[i] += (gain - heat[i] * COOL) * dt;
        if (heat[i] >= 1) {
          if (prot[i]) heat[i] = 0.97;
          else this._ignite(i, 0.2);
        }
      }
    }
  }

  // burning bits fall off tabletop edges and can light the floor below
  _dropBits(dt) {
    this.newDrops.length = 0;
    for (const i of this.burning) {
      if (!this.edge[i]) continue;
      const f = this.faces[this.face[i]];
      if (!f.drop || Math.random() > DROP_RATE * this.burn[i] * dt) continue;
      // start just past the face's edge, nearest to this cell
      const local = i - f.start, ci = local % f.nu, cj = (local / f.nu) | 0;
      const ou = ci === 0 ? -1 : ci === f.nu - 1 ? 1 : 0, ov = cj === 0 ? -1 : cj === f.nv - 1 ? 1 : 0;
      const px = this.x[i] + f.U.x * ou * (f.du / 2 + 0.03) + f.V.x * ov * (f.dv / 2 + 0.03);
      const pz = this.z[i] + f.U.z * ou * (f.du / 2 + 0.03) + f.V.z * ov * (f.dv / 2 + 0.03);
      const target = this._floorCellAt(px, pz);
      const d = { x: px, y: this.y[i] - 0.02, z: pz, vy: 0, cell: target, floorY: target >= 0 ? this.y[target] : this.floorY };
      this.drops.push(d);
      this.newDrops.push(d);
    }
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const d = this.drops[k];
      d.vy -= 9.8 * dt;
      d.y += d.vy * dt;
      if (d.y > d.floorY) continue;
      this.drops.splice(k, 1);
      const c = d.cell;
      if (c < 0 || this.state[c] !== 0) continue;
      this.heat[c] = Math.min(this.prot[c] ? 0.97 : 1, this.heat[c] + DROP_HEAT);
      if (this.heat[c] >= 1) this._ignite(c, 0.2);
    }
  }

  _floorCellAt(px, pz) {
    for (const f of this.faces) {
      if (f.kind !== K_FLOOR) continue;
      const rx = px - f.o.x, rz = pz - f.o.z;
      const u = (rx * f.U.x + rz * f.U.z) / f.du, v = (rx * f.V.x + rz * f.V.z) / f.dv;
      if (u < 0 || v < 0 || u >= f.nu || v >= f.nv) continue;
      const k = f.start + (v | 0) * f.nu + (u | 0);
      return this.dead[k] ? -1 : k;
    }
    return -1;
  }

  /** Fire size within r of a point (0–1), e.g. for the old per-Fire .intensity */
  intensityNear(p, r = 1.5) {
    let e = 0;
    const r2 = r * r;
    for (let b = 0; b < this._nb; b++) {
      if ((this._bx[b] - p.x) ** 2 + (this._bz[b] - p.z) ** 2 + (this._by[b] - p.y) ** 2 < r2) e += this._bE[b];
    }
    return Math.min(1, e / E_UNIT);
  }

  /** Per surface: label, share of it burning or burnt (0–1), hottest unburned cell, burning now */
  objectStatus() {
    return this.objects.map((o) => {
      let cells = 0, burnt = 0, hot = 0, now = false, prot = false;
      for (const f of o.faces) {
        for (let i = f.start; i < f.start + f.count; i++) {
          if (this.dead[i]) continue;
          cells++;
          if (this.state[i]) burnt++;
          if (this.state[i] === 1) now = true;
          else if (this.state[i] === 0) hot = Math.max(hot, this.heat[i]);
          if (this.prot[i]) prot = true;
        }
      }
      return { label: o.label, burnt: cells ? burnt / cells : 0, heat: hot, burning: now, protected: prot };
    });
  }
}

// =====================================================================
// FireSystem: FireSim + everything you see and hear
// =====================================================================
const EMBER_N = 160;
const SMOKE_N = 340;

// ---------------------------------------------------------------------
// Flame flipbook: web/public/textures/flames.png = Unity Labs "Flame03" (CC0, credited in the
// README), 16 x 4 frames of a looping flame. Each tongue plays it at its own speed, start frame
// and mirroring. If it can't load, the procedural noise flame is drawn instead.
// ---------------------------------------------------------------------
const FLIPBOOK_URL = '/textures/flames.png';
const FLIPBOOK_GRID = [16, 4];
const FLIPBOOK_FPS = 24;
let _sheet = null;
let _sheetReady = false;
const _sheetWaiters = new Set();

function flipbookTexture() {
  if (_sheet || typeof document === 'undefined') return _sheet;
  _sheet = new THREE.TextureLoader().load(
    FLIPBOOK_URL,
    () => { _sheetReady = true; _sheetWaiters.forEach((f) => f()); _sheetWaiters.clear(); },
    undefined,
    () => { _sheetWaiters.clear(); }, // missing file: stay procedural
  );
  _sheet.minFilter = _sheet.magFilter = THREE.LinearFilter;
  _sheet.generateMipmaps = false;
  return _sheet;
}

const MAX_LIGHTS = 4;

function flameMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNoise: { value: noiseTexture() }, uTime: { value: 0 }, uScroll: { value: new THREE.Vector3() },
      uSheet: { value: flipbookTexture() }, uSheetOn: { value: 0 }, uLinear: LINEAR_OUT,
      uFlare: { value: new THREE.Vector4(0, 0, 1, 0) },
      uEdge: { value: 0.1 }, // how "over" (vs additive) the dim flame edges blend: 0.1 passthrough, higher on an opaque scene
    },
    vertexShader: /* glsl */ `
      attribute vec2 aQuad;    // x: -1..1 across, y: 0..1 up
      attribute vec4 iPos;     // flame base (world), w: seed
      attribute vec4 iShape;   // x: width, y: height, z: burn 0–1, w: unused
      uniform float uTime;
      uniform float uSheetOn;
      uniform sampler2D uNoise;
      uniform vec4 uFlare;     // flare-up: xy = world x/z, z = radius (m), w = amount 0–1
      varying vec2 vUv;
      varying float vSeed;
      varying float vBurn;
      varying vec3 vFrame;     // flipbook: frame, next frame, blend
      varying float vMirror;
      varying float vSheet;
      void main() {
        vSheet = uSheetOn;
        // instance data is in the parent's space (the sim's); place it in the world through modelMatrix
        vec3 base = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
        float sc = length(modelMatrix[1].xyz);
        vec3 up = modelMatrix[1].xyz / sc;
        // flipbook timing per tongue (highp here, so mediump fragments never see big numbers)
        float speed = 0.75 + 0.5 * fract(iPos.w * 7.13);
        float f = iPos.w * 64.0 + uTime * ${FLIPBOOK_FPS.toFixed(1)} * speed;
        float f0 = mod(floor(f), 64.0);
        vFrame = vec3(f0, mod(f0 + 1.0, 64.0), fract(f));
        vMirror = fract(iPos.w * 3.71) < 0.5 ? -1.0 : 1.0;
        vec3 toCam = cameraPosition - base;
        toCam -= up * dot(toCam, up);
        vec3 side = normalize(cross(toCam, up) + vec3(1e-5, 0.0, 0.0)); // billboard around the room's up
        float s = iPos.w * 6.2832;
        // irregular licks, not a steady loop: a slow swell plus sharp spikes, from noise per tongue
        // (rates × 1000 are whole numbers, so the CPU's time wrap at 1000 s doesn't jump)
        float slow = texture2D(uNoise, vec2(iPos.w * 0.71, uTime * 0.09)).r;
        float fast = texture2D(uNoise, vec2(iPos.w * 0.37 + 0.5, uTime * 0.37)).r;
        float lick = 0.55 + 0.5 * slow + 0.75 * fast * fast * fast;
        // flare-up: tongues near it shoot up and widen for a moment
        float flare = uFlare.w * (1.0 - smoothstep(0.0, uFlare.z, length(iPos.xz - uFlare.xy)));
        float h = iShape.y * lick * (1.0 + 0.9 * flare);
        float sway = (sin(uTime * 1.9 + s) + 0.6 * sin(uTime * 3.3 + s * 2.7)) * 0.07 * h * aQuad.y * aQuad.y;
        // the flipbook flame fills about half its frame's width: widen the quad to match
        float wq = iShape.x * mix(1.0, 1.7, uSheetOn) * (1.0 + 0.25 * flare);
        vec3 w = base + side * ((aQuad.x * 0.5 * wq + sway * (1.0 - 0.7 * uSheetOn)) * sc) + up * (aQuad.y * h * sc);
        vUv = aQuad;
        vSeed = iPos.w;
        vBurn = min(1.0, iShape.z + 0.5 * flare);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform sampler2D uNoise;
      uniform vec3 uScroll;   // per-octave upward noise scroll, wrapped to 0–1 on the CPU (mediump-safe)
      uniform sampler2D uSheet;
      uniform float uLinear;
      uniform float uEdge;
      varying float vSheet;    // uSheetOn, via the vertex shader (uniform precisions must match)
      varying vec2 vUv;
      varying float vSeed;
      varying float vBurn;
      varying vec3 vFrame;
      varying float vMirror;
      float nz(vec2 p) { return texture2D(uNoise, p).r; }
      vec3 frame(float k, vec2 q) {
        float col = mod(k, ${FLIPBOOK_GRID[0].toFixed(1)}), row = floor(k / ${FLIPBOOK_GRID[0].toFixed(1)});
        return texture2D(uSheet, vec2((col + q.x) / ${FLIPBOOK_GRID[0].toFixed(1)}, 1.0 - (row + 1.0 - q.y) / ${FLIPBOOK_GRID[1].toFixed(1)})).rgb;
      }
      void main() {
        float x = vUv.x, y = vUv.y;
        if (vSheet > 0.5) {
          // frame-local coords: flame base sits ~3% above the frame bottom; blend to the next frame
          vec2 q = vec2(0.5 + 0.5 * x * vMirror, 0.03 + 0.95 * y);
          vec3 sc = mix(frame(vFrame.x, q), frame(vFrame.y, q), vFrame.z);
          sc.g = min(sc.g, sc.r); // never green-dominant
          float hm = max(sc.r, max(sc.g, sc.b));
          float fa = smoothstep(0.02, 0.45, hm) * smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.9, 1.0, y));
          fa *= 0.55 + 0.45 * vBurn;
          if (fa < 0.004) discard;
          // layered like a real fire: yellow-white core low down, orange body, dark red tips
          // (brightness stands in for temperature; the black smoke takes over above the tips)
          float core = smoothstep(0.65, 0.95, hm) * (1.0 - smoothstep(0.08, 0.35, y)) * (0.3 + 0.5 * vBurn);
          float tip = smoothstep(0.4, 0.9, y) * (1.0 - smoothstep(0.65, 0.95, hm));
          vec3 fc = mix(vec3(1.0, 0.4, 0.05), vec3(1.0, 0.6, 0.16), smoothstep(0.3, 0.8, hm));
          fc = mix(fc, vec3(1.0, 0.88, 0.6), core);
          fc = mix(fc, vec3(0.55, 0.06, 0.01), tip);
          fc *= mix(0.75, 1.0, vBurn);
          fa *= 1.0 - 0.4 * tip;
          // same blending as the procedural flame: bright cores "over", dim edges additive
          gl_FragColor = vec4(fc * fa, fa * mix(uEdge, 0.85, smoothstep(0.25, 0.75, hm)));
          ${LINEAR_GLSL}
          return;
        }
        // noise rising through the flame
        vec2 p = vec2(x * 0.09 + vSeed * 3.7, y * 0.16 + vSeed);
        float n = 0.6 * nz(p - vec2(0.0, uScroll.x)) + 0.3 * nz(p * 2.3 + vec2(0.37, -uScroll.y)) + 0.1 * nz(p * 5.1 + vec2(0.71, -uScroll.z));
        n = clamp((n - 0.5) * 2.0 + 0.5, 0.0, 1.0);
        // distort: sideways lick and upward stretch growing with height
        float xd = x + (n - 0.5) * 1.2 * y;
        float yd = y - (n - 0.5) * 0.45 * y;
        // rounded bulb at the base, widest a little above the surface, tapering into licks
        float w = 0.95 * pow(clamp(1.0 - yd, 0.0, 1.0), 0.6) * (0.45 + 0.55 * smoothstep(-0.05, 0.22, yd)) + 0.001;
        float body = 1.0 - smoothstep(0.3, 1.0, abs(xd) / w);
        float heat = body * (1.25 - 1.0 * yd) - (1.0 - n) * (0.22 + 0.9 * yd);
        // the very base is dim and see-through (fuel vapour not yet burning): no bright line on the surface
        heat *= 0.55 + 0.45 * smoothstep(0.0, 0.16, y);
        heat = clamp(heat * 1.6, 0.0, 1.0);
        // deep red → orange → yellow, pale core low down on big flames. G <= R everywhere.
        vec3 c = mix(vec3(0.5, 0.05, 0.0), vec3(0.95, 0.27, 0.03), smoothstep(0.05, 0.4, heat));
        c = mix(c, vec3(1.0, 0.52, 0.1), smoothstep(0.35, 0.7, heat));
        c = mix(c, vec3(1.0, 0.72, 0.3), smoothstep(0.7, 0.95, heat) * (0.3 + 0.7 * vBurn));
        c = mix(c, vec3(1.0, 0.88, 0.62), smoothstep(0.9, 1.0, heat) * (1.0 - smoothstep(0.0, 0.35, y)) * vBurn);
        float a = smoothstep(0.0, 0.45, heat) * smoothstep(0.0, 0.1, y) * (1.0 - smoothstep(0.85, 1.0, y));
        a *= 0.55 + 0.45 * vBurn;
        if (a < 0.004) discard;
        // hot cores blend "over" (overlapping flames settle at flame colour instead of adding up
        // to white); thin, cooler edges blend additively, so they never draw dark outlines
        gl_FragColor = vec4(c * a, a * mix(uEdge, 0.85, smoothstep(0.25, 0.75, heat)));
        ${LINEAR_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return setBlend(mat, 'normal');
}

function flameMesh(max) {
  const geo = new THREE.InstancedBufferGeometry();
  // base quad: also used as 'position' so three can compute (unused) bounds
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('aQuad', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iShape = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iShape', iShape);
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, flameMaterial());
  mesh.frustumCulled = false; // vertices are placed in the shader
  mesh.renderOrder = 10;
  return { mesh, geo, iPos, iShape };
}

// Surface overlay: char, glowing embers and the hot front, from a texture with one texel per cell
// plus warm flickering firelight from the biggest fires (uLights), so the floor, walls and furniture
// around a fire light up orange even in AR, where three.js lights have no real surfaces to light
function surfaceMaterial(cells, sizeU, sizeV, lights) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCells: { value: cells }, uNoise: { value: noiseTexture() }, uFlow: { value: new THREE.Vector2() },
      uSize: { value: new THREE.Vector2(sizeU, sizeV) }, uDebug: { value: 0 }, uLights: lights, uLinear: LINEAR_OUT,
      uLightGain: LIGHT_GAIN,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld; // in the sim's space, like uLights (the overlay mesh sits at the group's origin)
      void main() {
        vUv = uv;
        vWorld = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform sampler2D uCells;   // r: char · g: flames · b: heat (unburned) · a: embers (burnt out)
      uniform sampler2D uNoise;
      uniform vec2 uFlow;         // slow drift of the glow noise, wrapped to 0–1 on the CPU
      uniform vec2 uSize;         // face size in meters
      uniform float uDebug;
      uniform vec4 uLights[${MAX_LIGHTS}]; // xyz: light position · w: brightness (flicker included)
      uniform float uLightGain;    // 1 in XR, low on desktop where three.js lights already light the room
      uniform float uLinear;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec4 s = texture2D(uCells, vUv);
        vec2 wp = vUv * uSize;
        float n = texture2D(uNoise, wp * 0.21).r;
        float n2 = texture2D(uNoise, wp * 0.7 + vec2(0.31, 0.17)).r;
        if (uDebug > 0.5) { // heat view: green → red as it heats, orange = burning, dark = burnt
          vec3 hc = mix(vec3(0.1, 0.8, 0.2), vec3(1.0, 0.1, 0.05), s.b);
          float ha = max(s.b * 0.75, 0.0);
          vec3 col = hc * ha + vec3(1.0, 0.5, 0.0) * s.g * 0.8;
          float a = max(ha, s.r * 0.8);
          gl_FragColor = vec4(col, a);
          return;
        }
        // noise breaks up the char edge, but only where there is some char
        float ragged = smoothstep(0.0, 0.12, s.r);
        float charA = smoothstep(0.1, 0.55, s.r + ((n - 0.5) * 0.45 + (n2 - 0.5) * 0.18) * ragged);
        float flick = texture2D(uNoise, wp * 0.45 + vec2(uFlow.x, -uFlow.y)).r;
        float glow = s.g * (0.35 + 0.65 * flick);
        float cracks = smoothstep(0.55, 0.78, n2) * smoothstep(0.25, 0.65, n);
        float ember = (s.a + s.g * 0.7) * cracks * (0.5 + 0.5 * flick);
        float front = smoothstep(0.6, 0.95, s.b + (n - 0.5) * 0.3 * smoothstep(0.4, 0.6, s.b));
        vec3 emit = vec3(1.0, 0.32, 0.05) * glow * 0.5 + vec3(1.0, 0.45, 0.1) * ember * 1.2 + vec3(0.8, 0.22, 0.03) * front * 0.35;
        float a = charA * 0.95;
        // firelight: soft falloff from each fire, absorbed by char
        float lit = 0.0;
        for (int k = 0; k < ${MAX_LIGHTS}; k++) {
          vec3 d = uLights[k].xyz - vWorld;
          lit += uLights[k].w / (1.0 + dot(d, d) * 2.5);
        }
        emit += vec3(1.0, 0.38, 0.09) * min(lit, 0.45) * uLightGain * (1.0 - 0.75 * charA);
        vec3 col = vec3(0.025, 0.018, 0.013) * a + emit;
        if (a < 0.003 && emit.r < 0.003) discard;
        gl_FragColor = vec4(col, a);
        ${LINEAR_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  return setBlend(mat, 'normal');
}

export class FireSystem {
  /**
   * @param {THREE.Object3D|null} scene  where to add .group (or add fire.group yourself)
   * @param {object} [o]
   * @param {Array} [o.surfaces]    room.json surfaces (fuel). Without them a placed fire burns a small patch.
   * @param {number} [o.speed]      1 = demo pace: a table burns fully in ~20 s, neighbours catch at ~30–40 s
   * @param {number} [o.maxFlames]  flame tongues drawn at most (lower if the Quest drops frames)
   * @param {number} [o.exitClearance]  m around an open exit where nothing ignites
   * @param {boolean} [o.flipbook]  flame look: flipbook sheet (default) or procedural noise flames
   * @param {number} [o.embers]  ember pool size · @param {number} [o.smoke] smoke puff pool size
   * @param {number} [o.edgeOver]  0.1 = flame edges glow additively (passthrough); ~0.5 = they cover an opaque scene
   * @param {number|null} [o.surfaceLight]  firelight drawn on the surface overlays (default: 1 in XR, 0.3 on desktop)
   */
  constructor(scene = null, {
    surfaces = null, speed = 1, maxFlames = 300, exitClearance = 1.5, flipbook = true,
    embers = EMBER_N, smoke = SMOKE_N, surfaceLight = null, edgeOver = 0.1,
  } = {}) {
    this.sim = new FireSim({ speed, exitClearance });
    this.maxFlames = maxFlames;
    this.surfaceLight = surfaceLight;
    const EN = (this._emN = embers), SN = (this._smN = smoke);
    this.time = 0;
    this._acc = 0;
    this._surfacesSet = false;
    this._camPos = new THREE.Vector3(0, 1.6, 0);
    this._debug = false;
    this._flare = { age: 99, next: 5 + 5 * Math.random(), x: 0, z: 0, r: 1, amount: 0, spot: -1 };
    // firelight for the surface overlays (shared by all of them)
    this._lightU = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -50, 0, 0)) };

    this.group = new THREE.Group();
    this.group.name = 'FireSystem';
    this.group.userData.fireSystem = this; // createFireBloom finds it here for the heat shimmer
    scene?.add(this.group);

    // surface overlays (rebuilt with the fuel)
    this.surfaceGroup = new THREE.Group();
    this.group.add(this.surfaceGroup);
    this._overlays = [];

    // flames
    const fl = flameMesh(maxFlames * 2);
    fl.mesh.material.uniforms.uEdge.value = edgeOver;
    this._flames = fl;
    this._useFlipbook = flipbook;
    const on = () => { fl.mesh.material.uniforms.uSheetOn.value = this._useFlipbook ? 1 : 0; };
    if (_sheetReady) on(); else _sheetWaiters.add(on);
    this._sheetOn = on;
    fl.mesh.onBeforeRender = (r, s, cam) => {
      this.group.worldToLocal(cam.getWorldPosition(this._camPos)); // flame budget works in the sim's space
      LIGHT_GAIN.value = this.surfaceLight ?? (r.xr.isPresenting ? 1 : 0.3);
    };
    this.group.add(fl.mesh);

    // embers + falling burning bits (additive) and smoke rising off the flames
    const e = makePoints(EN, glowTexture(), 'additive');
    this._em = { ...e, vel: new Float32Array(EN * 3), age: new Float32Array(EN).fill(1), life: new Float32Array(EN).fill(1), kind: new Uint8Array(EN), seed: new Float32Array(EN).map(() => Math.random() * 50), floor: new Float32Array(EN), acc: 0 };
    e.pts.renderOrder = 12;
    this.group.add(e.pts);
    const sm = makePoints(SN, puffTexture(), 'normal');
    this._sm = { ...sm, vel: new Float32Array(SN * 3), age: new Float32Array(SN).fill(1), life: new Float32Array(SN).fill(1), shade: new Float32Array(SN), base: new Float32Array(SN), acc: 0 };
    sm.pts.renderOrder = 11;
    this.group.add(sm.pts);

    // lights on the biggest fires (all created up front, so shaders compile once)
    this._lights = [];
    for (let k = 0; k < MAX_LIGHTS; k++) {
      const l = new THREE.PointLight(0xff6a1a, 0, 9, 2); // reaches the walls and furniture around a fire
      l.userData.base = 0;
      l.position.set(0, -50, 0);
      this.group.add(l);
      this._lights.push(l);
    }
    // halo around each hotspot (camera bloom) and a glow drawn after the head fog (999)
    this._halos = [];
    this._fogGlows = [];
    for (let k = 0; k < MAX_SPOTS; k++) {
      this._halos.push(this._glowSprite(9, true));
      this._fogGlows.push(this._glowSprite(1000, false));
    }

    this.sound = [];
    this._wantSound = false;
    this._rebuildSurfaces();
    if (surfaces) this.setSurfaces(surfaces);
  }

  /** Flame look: true = Unity Labs flipbook (once loaded), false = procedural noise flames */
  get flipbook() { return this._useFlipbook; }
  set flipbook(v) { this._useFlipbook = !!v; if (_sheetReady) this._sheetOn(); }

  get hotspots() { return this.sim.hotspots; }
  get totalIntensity() { return this.sim.totalIntensity; }
  get ceilingY() { return this.sim.ceilingY; }
  get speed() { return this.sim.speed; }
  set speed(v) { this.sim.speed = v; }

  /** Heat view on the surfaces: green → red as they heat up (debug) */
  get debugHeat() { return this._debug; }
  set debugHeat(v) {
    this._debug = !!v;
    for (const o of this._overlays) o.mat.uniforms.uDebug.value = this._debug ? 1 : 0;
    this._writeSurfaces(true);
  }

  /** Use the room scan as fuel (room.json `surfaces`). Fires already placed are re-lit. */
  setSurfaces(surfaces) {
    this._surfacesSet = true;
    this.sim.setSurfaces(surfaces);
    this._rebuildSurfaces();
  }

  /** Use an unlabeled scan mesh (e.g. the room OBJ) as fuel: see surfacesFromMesh() */
  setFuelMesh(root, options) {
    const surfaces = surfacesFromMesh(root, options);
    this.setSurfaces(surfaces);
    return surfaces;
  }

  /** ExitSign list (kept by reference): open exits keep a clear zone. Without it, every ExitSign in a scene counts. */
  setExits(exits) { this._exitsSet = true; this.sim.setExits(exits); }

  /** Start a fire at a position (snaps to the nearest fuel within 0.6 m; { pile: true } = a burning object there) */
  ignite(pos, { pile = false } = {}) {
    const v = this.sim.version;
    const i = this.sim.ignite(pos, 0.25, pile);
    if (this.sim.version !== v) this._rebuildSurfaces();
    this._writeFlames();
    this._writeSurfaces();
    return i;
  }

  /** Put everything out (keeps the room) */
  reset() {
    this.sim.reset();
    this._rebuildSurfaces();
    this._writeFlames();
    for (const p of [this._em, this._sm]) { p.age.fill(1); p.life.fill(1); p.geo.setDrawRange(0, 0); }
    for (const l of this._lights) { l.intensity = 0; l.userData.base = 0; }
    for (const v of this._lightU.value) v.w = 0;
  }

  /**
   * @param {number} dt
   * @param {{running?: boolean}|boolean} [opts]  running = drill on (true also accepted directly)
   */
  update(dt, opts = {}) {
    const running = typeof opts === 'boolean' ? opts : !!opts.running;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this._acc += dt;
    if (!this._exitsSet) { // nobody called setExits(): use every exit sign that's in a scene
      const list = this._liveExits ??= [];
      list.length = 0;
      for (const sgn of _exitSigns) if (sgn.sprite.parent) list.push(sgn);
      this.sim.exits = list;
    }
    let ticked = false;
    for (let k = 0; this._acc >= TICK && k < 3; k++) {
      this._acc -= TICK;
      this.sim.tick(TICK, running);
      ticked = true;
    }
    if (this._acc > TICK) this._acc = 0; // fell behind: drop time rather than stall
    if (ticked) {
      this._writeFlames();
      this._writeSurfaces();
      for (const d of this.sim.newDrops) this._spawnDrop(d);
      this.sim.newDrops.length = 0;
    }
    const t = this.time;
    const fu = this._flames.mesh.material.uniforms;
    fu.uTime.value = t % 1000; // vertex shader (highp): sway
    fu.uScroll.value.set((t * 0.42) % 1, (t * 0.31 * 2.3) % 1, (t * 0.9 * 5.1) % 1);
    for (const o of this._overlays) o.mat.uniforms.uFlow.value.set((t * 0.06) % 1, (t * 0.1) % 1);
    this._updateFlare(dt, running);
    this._updateEmbers(dt);
    this._updateSmoke(dt);
    this._updateGlow(dt);
  }

  // --- surfaces ---------------------------------------------------------
  _rebuildSurfaces() {
    for (const o of this._overlays) { o.mesh.geometry.dispose(); o.mat.dispose(); o.tex.dispose(); }
    this.surfaceGroup.clear();
    this._overlays = this.sim.faces.map((f) => {
      const data = new Uint8Array(f.nu * f.nv * 4);
      const tex = new THREE.DataTexture(data, f.nu, f.nv, THREE.RGBAFormat);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const off = f.kind === K_FLOOR || f.kind === K_TOP ? 0.006 : 0.01;
      const o = f.o.clone().addScaledVector(f.N, off);
      const a = o.clone().addScaledVector(f.U, f.lu);
      const b = a.clone().addScaledVector(f.V, f.lv);
      const c = o.clone().addScaledVector(f.V, f.lv);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([o.x, o.y, o.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const mat = surfaceMaterial(tex, f.lu, f.lv, this._lightU);
      mat.uniforms.uDebug.value = this._debug ? 1 : 0;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      mesh.visible = false;
      this.surfaceGroup.add(mesh);
      return { face: f, mesh, mat, tex, data, active: false };
    });
  }

  _writeSurfaces(force = false) {
    const s = this.sim;
    for (const o of this._overlays) {
      const f = o.face;
      const d = o.data;
      let any = false;
      for (let k = 0; k < f.count; k++) {
        const i = f.start + k;
        const st = s.state[i];
        let r = 0, g = 0, b = 0, a = 0;
        // under the flames the surface chars black within ~30 s of burning
        if (st === 1) { r = 0.45 + 0.55 * Math.min(1, (1 - s.fuel[i]) * 3); g = s.burn[i]; a = 0.4 * (1 - s.fuel[i]); }
        else if (st === 2) { r = 1; a = s.ember[i]; }
        // heated but not burning: soot-stained and browning before it catches
        else if (s.heat[i] > 0.02) { b = Math.min(1, s.heat[i]); r = Math.max(0, s.heat[i] - 0.35) * 0.6; }
        if (r || g || b || a) any = true;
        d[k * 4] = r * 255; d[k * 4 + 1] = g * 255; d[k * 4 + 2] = b * 255; d[k * 4 + 3] = a * 255;
      }
      if (any || o.active || force) o.tex.needsUpdate = true;
      o.active = any;
      // also drawn when a fire is close enough to light it
      let lit = false;
      for (const h of s.hotspots) if (f.bb.distanceToPoint(h.position) < 4.5) { lit = true; break; }
      o.mesh.visible = any || lit;
    }
  }

  // --- flames -----------------------------------------------------------
  _writeFlames() {
    const s = this.sim;
    const list = s.burning;
    const fl = this._flames;
    const P = fl.iPos.array, S = fl.iShape.array;
    let chosen = list;
    if (list.length > this.maxFlames) {
      // over budget: keep the biggest and nearest flames
      const c = this._camPos;
      const score = (i) => (s.burn[i] * MATS[s.mat[i]].flameH) / (0.4 + (s.x[i] - c.x) ** 2 + (s.y[i] - c.y) ** 2 + (s.z[i] - c.z) ** 2);
      chosen = list.slice().sort((p, q) => score(q) - score(p)).slice(0, this.maxFlames);
    }
    const cap = fl.iPos.count;
    let n = 0;
    for (const i of chosen) {
      if (n >= cap) break;
      const f = s.faces[s.face[i]];
      const m = MATS[s.mat[i]];
      const burn = s.burn[i];
      // neighbours on fire merge into one bigger, taller sheet
      let nb = 0, cnt = 0;
      for (let k = s.nStart[i]; k < s.nStart[i + 1]; k++) {
        cnt++;
        if (s.state[s.nIdx[k]] === 1) nb += s.burn[s.nIdx[k]];
      }
      const merge = cnt ? nb / cnt : 0;
      const sd = s.seed[i];
      const h = m.flameH * (0.3 + 0.7 * burn) * (1 + 0.6 * merge) * (0.7 + 0.6 * sd);
      const w = Math.min(h * 0.9, s.size[i] * (1.2 + 0.5 * burn) * (1 + 0.3 * merge));
      const vertical = f.kind === K_SIDE || f.kind === K_WALL;
      const tongues = s.size[i] > 0.32 ? 2 : 1; // big floor/wall cells get two tongues
      for (let t = 0; t < tongues && n < cap; t++) {
        const j1 = ((sd * 7.31 + t * 0.47) % 1) - 0.5, j2 = ((sd * 3.17 + t * 0.29) % 1) - 0.5;
        let x = s.x[i], y = s.y[i], z = s.z[i];
        if (vertical) {
          // rise from the lower part of the cell, a little off the face
          x += f.U.x * j1 * f.du * 0.7 + f.N.x * 0.05;
          z += f.U.z * j1 * f.du * 0.7 + f.N.z * 0.05;
          y -= f.dv * 0.3;
        } else {
          x += f.U.x * j1 * f.du * 0.6 + f.V.x * j2 * f.dv * 0.6;
          z += f.U.z * j1 * f.du * 0.6 + f.V.z * j2 * f.dv * 0.6;
          y += 0.005;
        }
        const k4 = n * 4;
        P[k4] = x; P[k4 + 1] = y; P[k4 + 2] = z; P[k4 + 3] = (sd + t * 0.37) % 1;
        const tw = tongues > 1 ? 0.75 : 1;
        S[k4] = w * tw; S[k4 + 1] = h * (t ? 0.85 : 1); S[k4 + 2] = burn; S[k4 + 3] = 0;
        n++;
      }
    }
    // back to front, for the "over" blending
    const c = this._camPos;
    const order = this._order ??= [];
    order.length = n;
    for (let k = 0; k < n; k++) order[k] = k;
    const d2 = this._d2 ??= new Float32Array(cap);
    for (let k = 0; k < n; k++) d2[k] = (P[k * 4] - c.x) ** 2 + (P[k * 4 + 1] - c.y) ** 2 + (P[k * 4 + 2] - c.z) ** 2;
    order.sort((p, q) => d2[q] - d2[p]);
    const tp = this._tmpP ??= new Float32Array(cap * 4), ts = this._tmpS ??= new Float32Array(cap * 4);
    tp.set(P.subarray(0, n * 4)); ts.set(S.subarray(0, n * 4));
    for (let k = 0; k < n; k++) {
      const o = order[k] * 4;
      for (let q = 0; q < 4; q++) { P[k * 4 + q] = tp[o + q]; S[k * 4 + q] = ts[o + q]; }
    }
    fl.geo.instanceCount = n;
    fl.iPos.needsUpdate = true;
    fl.iShape.needsUpdate = true;
  }

  // --- flare-ups: every 5–10 s one fire bursts taller, with sparks, smoke and a flash ---
  _updateFlare(dt, running) {
    const fx = this._flare, spots = this.sim.hotspots;
    fx.age += dt;
    fx.next -= dt * (running ? 1 : 0.5);
    if (fx.next <= 0 && spots.length) {
      fx.next = 5 + 5 * Math.random();
      fx.age = 0;
      fx.spot = (Math.random() * Math.min(3, spots.length)) | 0;
      const h = spots[fx.spot];
      fx.x = h.position.x; fx.z = h.position.z;
      fx.r = 0.6 + 0.9 * Math.sqrt(h.area);
      this._burst(h, fx.r);
    }
    // quick rise (0.25 s), slower fall (1.3 s)
    const a = fx.age < 0.25 ? fx.age / 0.25 : Math.max(0, 1 - (fx.age - 0.25) / 1.3);
    fx.amount = a * a * (3 - 2 * a);
    this._flames.mesh.material.uniforms.uFlare.value.set(fx.x, fx.z, fx.r, fx.amount);
  }

  // extra sparks and smoke from burning cells near a hotspot
  _burst(h, r) {
    const s = this.sim, em = this._em, sm = this._sm;
    const near = s.burning.filter((i) => (s.x[i] - h.position.x) ** 2 + (s.z[i] - h.position.z) ** 2 < r * r);
    if (!near.length) return;
    let sparks = 30, puffs = 10;
    for (let k = 0; k < this._emN && sparks > 0; k++) {
      if (em.age[k] < em.life[k]) continue;
      const i = near[(Math.random() * near.length) | 0];
      const fh = MATS[s.mat[i]].flameH * s.burn[i];
      em.kind[k] = 0;
      em.pos[k * 3] = s.x[i]; em.pos[k * 3 + 1] = s.y[i] + fh * Math.random(); em.pos[k * 3 + 2] = s.z[i];
      em.vel[k * 3] = (Math.random() - 0.5) * 1.2;
      em.vel[k * 3 + 1] = 1.6 + Math.random() * 2.2;
      em.vel[k * 3 + 2] = (Math.random() - 0.5) * 1.2;
      em.age[k] = 0;
      em.life[k] = 1.2 + Math.random() * 1.6;
      sparks--;
    }
    for (let k = 0; k < this._smN && puffs > 0; k++) {
      if (sm.age[k] < sm.life[k]) continue;
      const i = near[(Math.random() * near.length) | 0];
      const fh = MATS[s.mat[i]].flameH * (0.3 + 0.7 * s.burn[i]);
      sm.pos[k * 3] = s.x[i]; sm.pos[k * 3 + 1] = Math.min(s.ceilingY - 0.2, s.y[i] + fh * 1.3); sm.pos[k * 3 + 2] = s.z[i];
      sm.vel[k * 3] = (Math.random() - 0.5) * 0.06; sm.vel[k * 3 + 1] = 0.8 + Math.random() * 0.4; sm.vel[k * 3 + 2] = (Math.random() - 0.5) * 0.06;
      sm.age[k] = 0; sm.life[k] = 5 + Math.random() * 3; sm.shade[k] = 0.02 + Math.random() * 0.03; sm.base[k] = 0.5 + 0.4 * fh;
      puffs--;
    }
  }

  // --- particles ----------------------------------------------------------
  /** A random burning cell, biased toward bigger flames, or -1 */
  _randomBurning() {
    const list = this.sim.burning;
    if (!list.length) return -1;
    let i = list[(Math.random() * list.length) | 0];
    for (let k = 0; k < 2 && Math.random() > this.sim.burn[i]; k++) i = list[(Math.random() * list.length) | 0];
    return i;
  }

  _spawnDrop(d) {
    const em = this._em;
    let slot = -1;
    for (let k = 0; k < this._emN; k++) if (em.age[k] >= em.life[k]) { slot = k; break; }
    if (slot < 0) return;
    em.kind[slot] = 1;
    em.pos[slot * 3] = d.x; em.pos[slot * 3 + 1] = d.y; em.pos[slot * 3 + 2] = d.z;
    em.vel[slot * 3] = (Math.random() - 0.5) * 0.2; em.vel[slot * 3 + 1] = 0; em.vel[slot * 3 + 2] = (Math.random() - 0.5) * 0.2;
    em.age[slot] = 0;
    em.life[slot] = 3.5; // falls, then smolders on the floor for a moment
    em.floor[slot] = d.floorY + 0.02;
  }

  _updateEmbers(dt) {
    const s = this.sim, em = this._em, t = this.time;
    // sparks: more with more fire
    let fire = 0;
    for (const h of s.hotspots) fire += h.area;
    em.acc += dt * Math.min(45, s.burning.length ? 3 + 30 * fire : 0) * (this._emN / EMBER_N);
    let alive = 0;
    const P = em.pos, C = em.col, Z = em.size, Vv = em.vel;
    for (let k = 0; k < this._emN; k++) {
      if (em.age[k] >= em.life[k] && em.acc >= 1) {
        const i = this._randomBurning();
        if (i < 0) { em.acc = 0; continue; }
        em.acc -= 1;
        em.kind[k] = 0;
        const fh = MATS[s.mat[i]].flameH * s.burn[i];
        P[k * 3] = s.x[i] + (Math.random() - 0.5) * s.size[i];
        P[k * 3 + 1] = s.y[i] + fh * (0.2 + 0.5 * Math.random());
        P[k * 3 + 2] = s.z[i] + (Math.random() - 0.5) * s.size[i];
        Vv[k * 3] = (Math.random() - 0.5) * 0.5;
        Vv[k * 3 + 1] = 0.7 + Math.random() * 1.2;
        Vv[k * 3 + 2] = (Math.random() - 0.5) * 0.5;
        em.age[k] = 0;
        em.life[k] = 0.9 + Math.random() * 1.6;
      }
      if (em.age[k] >= em.life[k]) { C[k * 4 + 3] = 0; continue; }
      alive = k + 1;
      em.age[k] += dt;
      const a = em.age[k] / em.life[k];
      const sd = em.seed[k];
      if (em.kind[k] === 1) {
        // burning bit: falls, lands, glows out
        if (P[k * 3 + 1] > em.floor[k]) {
          Vv[k * 3 + 1] -= 9.8 * dt;
          P[k * 3] += Vv[k * 3] * dt; P[k * 3 + 1] += Vv[k * 3 + 1] * dt; P[k * 3 + 2] += Vv[k * 3 + 2] * dt;
          if (P[k * 3 + 1] <= em.floor[k]) P[k * 3 + 1] = em.floor[k];
        }
        C[k * 4] = 1; C[k * 4 + 1] = 0.45; C[k * 4 + 2] = 0.08;
        C[k * 4 + 3] = (1 - a) * (0.7 + 0.3 * Math.sin(t * 20 + sd));
        Z[k] = 0.07 * (1 - 0.5 * a);
      } else {
        P[k * 3] += (Vv[k * 3] + Math.sin(t * 3 + sd) * 0.3) * dt;
        P[k * 3 + 1] += Vv[k * 3 + 1] * dt * (1 - 0.5 * a);
        P[k * 3 + 2] += (Vv[k * 3 + 2] + Math.cos(t * 2.6 + sd) * 0.3) * dt;
        const wink = clamp01(Math.sin(t * (8 + (sd % 7)) + sd) * 2 + 1.2);
        C[k * 4] = 1; C[k * 4 + 1] = 0.55 - 0.3 * a; C[k * 4 + 2] = 0.12 - 0.1 * a;
        C[k * 4 + 3] = Math.min(1, a * 8) * (1 - a) * wink * 0.95;
        Z[k] = 0.028 - 0.012 * a;
      }
    }
    if (em.acc > 1) em.acc = 1;
    em.geo.setDrawRange(0, alive);
    markDirty(em.geo);
  }

  _updateSmoke(dt) {
    const s = this.sim, sm = this._sm, t = this.time;
    const ceil = s.ceilingY;
    sm.acc += dt * Math.min(70, s.burning.length ? 6 + 22 * s.totalIntensity : 0) * (this._smN / SMOKE_N);
    let alive = 0;
    const P = sm.pos, C = sm.col, Z = sm.size, Vv = sm.vel;
    for (let k = 0; k < this._smN; k++) {
      if (sm.age[k] >= sm.life[k] && sm.acc >= 1) {
        const i = this._randomBurning();
        if (i < 0) { sm.acc = 0; continue; }
        sm.acc -= 1;
        const fh = MATS[s.mat[i]].flameH * (0.3 + 0.7 * s.burn[i]);
        P[k * 3] = s.x[i] + (Math.random() - 0.5) * 0.2;
        // starts among the flame tips, so the flames fade up into it
        P[k * 3 + 1] = Math.min(ceil - 0.2, s.y[i] + fh * (0.7 + 0.3 * Math.random()));
        P[k * 3 + 2] = s.z[i] + (Math.random() - 0.5) * 0.2;
        Vv[k * 3] = (Math.random() - 0.5) * 0.04; // a column rising straight up off the fire
        Vv[k * 3 + 1] = 0.55 + Math.random() * 0.4;
        Vv[k * 3 + 2] = (Math.random() - 0.5) * 0.04;
        sm.age[k] = 0;
        sm.life[k] = 5 + Math.random() * 3;
        sm.shade[k] = 0.02 + Math.random() * 0.04; // near-black soot
        sm.base[k] = 0.3 + 0.35 * fh;
      }
      if (sm.age[k] >= sm.life[k]) { C[k * 4 + 3] = 0; continue; }
      alive = k + 1;
      sm.age[k] += dt;
      const a = sm.age[k] / sm.life[k];
      // rise, then spread out along the ceiling
      const room = ceil - 0.15 - P[k * 3 + 1];
      const up = room > 0 ? Vv[k * 3 + 1] * Math.min(1, room / 0.4) : 0;
      const spread = room < 0.4 ? 1 + 3 * (1 - room / 0.4) : 1;
      const wob = 0.015 + 0.06 * (spread - 1);
      P[k * 3] += (Vv[k * 3] * spread + Math.sin(t * 0.7 + k) * wob) * dt;
      P[k * 3 + 1] += up * dt;
      P[k * 3 + 2] += (Vv[k * 3 + 2] * spread + Math.cos(t * 0.6 + k) * wob) * dt;
      // lit orange-brown from below at first (dark grey over flames would read olive), then black
      const v = sm.shade[k], warm = 1 - clamp01(a * 5);
      C[k * 4] = v + 0.16 * warm; C[k * 4 + 1] = v + 0.06 * warm; C[k * 4 + 2] = v + 0.015 * warm;
      C[k * 4 + 3] = clamp01((a - 0.02) * 6) * Math.pow(Math.max(0, 1 - a), 0.7) * 0.8; // a can pass 1 for a frame: no NaN (it would black out the bloom)
      Z[k] = sm.base[k] + 1.4 * Math.sqrt(a);
    }
    if (sm.acc > 1) sm.acc = 1;
    sm.geo.setDrawRange(0, alive);
    markDirty(sm.geo);
  }

  _glowSprite(renderOrder, depthTest) {
    const mat = new THREE.SpriteMaterial({
      map: softGlowTexture(), color: 0xff5a12, transparent: true, opacity: 0, depthWrite: false, depthTest,
    });
    setBlend(mat, 'additive');
    mat.blendSrc = THREE.SrcAlphaFactor; // the sprite shader doesn't premultiply, so weight rgb by alpha here
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = renderOrder;
    sp.visible = false;
    this.group.add(sp);
    return sp;
  }

  // lights, halos, glow through smoke, sound: follow the hotspots
  _updateGlow(dt) {
    const spots = this.sim.hotspots, t = this.time;
    const k = Math.min(1, dt * 3);
    this._lights.forEach((l, i) => {
      const h = spots[i];
      // brightness grows with the burning area; the flicker rides on top unsmoothed
      const want = h ? Math.min(18, 2 + 9 * Math.sqrt(h.area)) : 0;
      if (h) {
        const y = h.position.y + 0.3 + 0.25 * Math.sqrt(h.area);
        if (l.userData.base < 0.01) l.position.set(h.position.x, y, h.position.z);
        else l.position.lerp(_tmp.set(h.position.x, y, h.position.z), k);
      }
      l.userData.base += (want - l.userData.base) * k;
      const fl = flicker(t * 1.7, i * 13.7) * (0.92 + 0.08 * Math.sin(t * 31 + i * 5));
      l.intensity = l.userData.base * fl * (i === this._flare.spot ? 1 + 0.7 * this._flare.amount : 1);
      l.color.setRGB(1, 0.36 + 0.06 * fl, 0.08); // a touch yellower on the bright flickers
      // same light for the surface overlays (normalised; 0 when there's no fire)
      this._lightU.value[i].set(l.position.x, l.position.y, l.position.z, l.intensity / 30);
    });
    for (let i = 0; i < MAX_SPOTS; i++) {
      const h = spots[i], halo = this._halos[i], fg = this._fogGlows[i];
      halo.visible = fg.visible = !!h;
      if (!h) continue;
      const size = 0.6 + 1.6 * Math.sqrt(h.area);
      const fl = flicker(t, i * 5.3);
      halo.position.set(h.position.x, h.position.y + 0.3 * size, h.position.z);
      halo.scale.setScalar(size * 1.6);
      halo.material.opacity = 0.12 * fl * (0.4 + 0.6 * h.intensity);
      fg.visible = _headFog > 0.02;
      fg.position.copy(halo.position);
      fg.scale.setScalar(size * 2.6);
      fg.material.opacity = _headFog * (0.3 + 0.3 * h.intensity) * fl;
    }
    // sound: up to 3 sources follow the biggest fires
    this.sound.forEach((snd, i) => {
      const h = spots[i];
      if (h) snd.position.lerp(h.position, snd.getVolume() < 0.01 ? 1 : k);
      const want = h && this._wantSound ? 0.35 + 0.65 * h.intensity : 0;
      snd.setVolume(snd.getVolume() + (want - snd.getVolume()) * k);
    });
  }

  /** Looping crackle from the biggest fires. Needs one user tap first (browser rule). */
  startSound() {
    this._wantSound = true;
    if (this.sound.length) {
      for (const s of this.sound) if (!s.isPlaying) try { s.play(); } catch { /* not unlocked yet */ }
      return;
    }
    if (!_listener) return; // no camera listener yet: Smoke(scene, camera) or setAudioListener(camera)
    if (_listener.context.state === 'suspended') _listener.context.resume().catch(() => {});
    loadFireBuffer().then((buffer) => {
      if (!buffer || !this._wantSound || this.sound.length) return;
      for (let i = 0; i < 3; i++) {
        const snd = new THREE.PositionalAudio(_listener);
        snd.setBuffer(buffer);
        snd.setLoop(true);
        snd.setRefDistance(1);
        snd.setRolloffFactor(1.5);
        snd.setVolume(0);
        snd.offset = (i * buffer.duration) / 3; // out of phase, so they don't sound like one loop
        this.group.add(snd);
        this.sound.push(snd);
        try { snd.play(); } catch { /* audio context not unlocked yet */ }
      }
    });
  }

  stopSound() {
    this._wantSound = false;
    for (const s of this.sound) if (s.isPlaying) s.stop();
  }

  dispose() {
    this.stopSound();
    for (const s of this.sound) s.disconnect?.();
    for (const o of this._overlays) { o.mesh.geometry.dispose(); o.mat.dispose(); o.tex.dispose(); }
    this._flames.geo.dispose(); this._flames.mesh.material.dispose();
    this._em.geo.dispose(); this._em.mat.dispose();
    this._sm.geo.dispose(); this._sm.mat.dispose();
    for (const sp of [...this._halos, ...this._fogGlows]) sp.material.dispose();
    this.group.removeFromParent();
    if (_default === this) _default = null;
  }
}
const _tmp = new THREE.Vector3();

// ---------------------------------------------------------------------
// Desktop bloom + heat shimmer: flames glow and bleed light like fire on a camera, and the
// air above each fire ripples. Pass { fire } if the FireSystem isn't in `scene`.
//   const bloom = createFireBloom(renderer, scene, camera);
//   … then each frame call bloom.render() instead of renderer.render(scene, camera).
// In XR it renders straight to the headset (no bloom: too costly per eye on the Quest).
// It follows window resizes; call bloom.setSize(w, h) if your canvas isn't the window.
// ---------------------------------------------------------------------
const SHIMMER_SPOTS = 4;
const ShimmerShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 }, uAmount: { value: 1 },
    uSpots: { value: Array.from({ length: SHIMMER_SPOTS }, () => new THREE.Vector4()) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uAmount;
    uniform vec4 uSpots[${SHIMMER_SPOTS}];   // xy: screen uv of the hot air above a fire · z: radius (u) · w: strength
    varying vec2 vUv;
    void main() {
      float m = 0.0;
      for (int k = 0; k < ${SHIMMER_SPOTS}; k++) {
        vec4 s = uSpots[k];
        vec2 d = (vUv - s.xy) / vec2(s.z, s.z * uAspect * 1.7); // tall oval of rising hot air
        m += s.w * (1.0 - smoothstep(0.3, 1.0, length(d)));
      }
      m = min(m, 1.0) * uAmount;
      // ripples drifting upward
      vec2 off = vec2(
        sin(vUv.y * 95.0 - uTime * 7.0 + sin(vUv.x * 45.0 + uTime) * 2.0),
        cos(vUv.x * 75.0 + vUv.y * 35.0 - uTime * 5.0)) * 0.0032 * m;
      gl_FragColor = texture2D(tDiffuse, vUv + off);
    }`,
};

export function createFireBloom(renderer, scene, camera, { strength = 0.55, radius = 0.45, threshold = 0.7, shimmer = 1, fire = null } = {}) {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // heat shimmer above each fire (desktop only: this composer never runs in XR)
  const heat = new ShaderPass(ShimmerShader);
  heat.uniforms.uAmount.value = shimmer;
  composer.addPass(heat);
  let sys = fire, lookFor = 0;
  const pc = new THREE.Vector3(), pr = new THREE.Vector3(), right = new THREE.Vector3();
  const updateShimmer = () => {
    if (!sys || !sys.group.parent) {
      if (lookFor-- <= 0) { sys = scene.getObjectByName('FireSystem')?.userData.fireSystem ?? null; lookFor = 30; }
    }
    const u = heat.uniforms;
    u.uTime.value = (performance.now() / 1000) % 1000;
    u.uAspect.value = size.x / Math.max(1, size.y);
    const spots = sys ? sys.hotspots : [];
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    for (let k = 0; k < SHIMMER_SPOTS; k++) {
      const v = u.uSpots.value[k], h = spots[k];
      v.set(0, 0, 1, 0);
      if (!h) continue;
      const g = Math.sqrt(h.area);
      pc.copy(h.position).setY(h.position.y + 0.45 + 0.7 * g);   // the hot air above the flames
      pr.copy(pc).addScaledVector(right, 0.35 + 0.45 * g);
      pc.project(camera); pr.project(camera);
      if (pc.z > 1 || pc.z < -1) continue;                         // behind the camera
      v.set(pc.x * 0.5 + 0.5, pc.y * 0.5 + 0.5, Math.max(0.01, Math.abs(pr.x - pc.x) * 0.5), Math.min(1, 0.4 + h.intensity));
    }
  };
  const bloom = new UnrealBloomPass(size.clone(), strength, radius, threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const setSize = (w, h) => { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); };
  setSize(size.x, size.y);
  const onResize = () => { renderer.getSize(size); setSize(size.x, size.y); };
  if (typeof addEventListener === 'function') addEventListener('resize', onResize);
  return {
    composer,
    bloom,
    enabled: true,
    setSize,
    shimmer: heat,
    render() {
      if (renderer.xr.isPresenting || !this.enabled) { renderer.render(scene, camera); return; }
      updateShimmer();
      LINEAR_OUT.value = 1;
      composer.render();
      LINEAR_OUT.value = 0;
    },
    dispose() {
      if (typeof removeEventListener === 'function') removeEventListener('resize', onResize);
      composer.dispose();
    },
  };
}

// ---------------------------------------------------------------------
// The shared FireSystem behind `new Fire(pos)`. Loads /api/room for fuel unless
// someone calls fireSystem().setSurfaces(surfaces) first.
// ---------------------------------------------------------------------
let _default = null;
export function fireSystem() {
  if (_default) return _default;
  _default = new FireSystem();
  const sys = _default;
  sys._compat = new Set();
  sys._roomFetch = 'none';
  if (typeof fetch === 'function') {
    sys._roomFetch = 'pending';
    fetch('/api/room')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.surfaces?.length && !sys._surfacesSet) sys.setSurfaces(d.surfaces);
        sys._roomFetch = d?.surfaces?.length ? 'ok' : 'none';
      })
      .catch(() => { sys._roomFetch = 'none'; });
  }
  return sys;
}

// The scene's room scan for the default system: the direct child of `scene` with the most
// triangles (at least 3,000), skipping our own effects. Used when there's no room.json.
function findScanMesh(scene) {
  let best = null, bestTris = 3000;
  for (const child of scene.children) {
    if (child.name === 'FireSystem' || child.name === 'Smoke' || child.isCamera || child.isLight) continue;
    let tris = 0;
    child.traverse((o) => {
      if (!o.isMesh || o.isSprite || !o.geometry?.attributes?.position) return;
      tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    if (tris > bestTris) { bestTris = tris; best = child; }
  }
  return best;
}

/**
 * README contract: one fire you place. It lights the shared FireSystem, which handles the
 * spreading; .intensity is how big the fire is around this spot (0–1).
 */
export class Fire {
  /** @param {THREE.Vector3|{x,y,z}} position  world position (e.g. the table top) */
  constructor(position, { system = null } = {}) {
    this.system = system ?? fireSystem();
    this.system._compat ??= new Set();
    this.group = new THREE.Group();
    this.group.name = 'Fire';
    if (position) this.group.position.set(position.x, position.y, position.z);
    this.position = this.group.position;
    this.age = 0;
    this.system.ignite(this.position);
    this.system._compat.add(this);
    this.intensity = this.system.sim.intensityNear(this.position);
  }

  /**
   * @param {number} dt
   * @param {boolean} growing  true during the drill: fire grows and spreads
   */
  update(dt, growing = false) {
    this.age += dt;
    const sys = this.system;
    // the system draws in world space: put it next to this fire's group (normally the scene)
    if (!sys.group.parent && this.group.parent) this.group.parent.add(sys.group);
    // no room.json and nobody set fuel: burn the room scan mesh in the scene, once
    if (!sys._surfacesSet && sys._roomFetch === 'none' && !sys._autoFuel && this.group.parent) {
      sys._autoFuel = true;
      const scan = findScanMesh(this.group.parent);
      if (scan) sys.setFuelMesh(scan);
    }
    // all Fires share one system: only the first one steps it
    if (sys._compat.values().next().value === this) sys.update(dt, { running: growing });
    this.intensity = sys.sim.intensityNear(this.position);
  }

  startSound() { this.system.startSound(); }
  stopSound() { this.system.stopSound(); }

  dispose() {
    this.system._compat.delete(this);
    if (!this.system._compat.size) { this.system.stopSound(); this.system.reset(); }
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Smoke: ceiling layer that drops, plus head fog on the camera
// ---------------------------------------------------------------------
const CEIL_GLOWS = 6;

/** Summed fire size and hotspots from a FireSystem, a Fire list, or a count */
function fireSummary(fires) {
  if (fires && typeof fires.totalIntensity === 'number') return [fires.totalIntensity, fires.hotspots || []];
  if (Array.isArray(fires)) {
    const sys = fires.find((f) => f?.system)?.system;
    if (sys) return [sys.totalIntensity, sys.hotspots];
    let t = 0;
    for (const f of fires) t += f.intensity ?? 0.5;
    return [t, fires];
  }
  return [(fires | 0) * 0.5, []];
}

export class Smoke {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera  head fog attaches here (camera is added to the scene if needed)
   */
  constructor(scene, camera, {
    size = 12,         // meters covered (square)
    minY = 1.1,        // lowest the smoke gets
    headHeight = 1.6,  // standing head height the timing below is measured to
    timeToHead = 20,   // s for the smoke to reach headHeight from a small fire …
    fastestTimeToHead = 15, // … and from a big one (summed fire intensity ≥ 1.8)
    depthRange = 0.5,  // head this far above the smoke bottom = depth 1
    layers = 4,
    puffs = 240,
    color = 0x3a3a3c,
  } = {}) {
    Object.assign(this, { size, minY, headHeight, timeToHead, fastestTimeToHead, depthRange });
    this.ceilingY = 2.6;
    this.bottom = this.ceilingY;
    this.darkness = 0.3; // 0–1, follows the summed intensity of all fires
    this.totalIntensity = 0;
    this.depth = 0;
    this.active = false;
    this._t = 0;

    this.group = new THREE.Group();
    this.group.name = 'Smoke';
    this.group.visible = false;
    scene?.add(this.group);

    // flat cloud layers (dense seamless tile, so the underside reads as a solid smoke ceiling)
    const base = puffTexture();
    const layerTex = smokeLayerTexture();
    this._layers = [];
    const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    for (let i = 0; i < layers; i++) {
      const map = layerTex.clone();
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(size / 2.2, size / 2.2);
      map.offset.set(Math.random(), Math.random());
      map.needsUpdate = true;
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map, color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }));
      m.renderOrder = 5;
      this._layers.push(m);
      this.group.add(m);
    }

    // fire light on the smoke's underside, above each big fire (world positions: not in the group)
    this._ceilGlows = [];
    const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < CEIL_GLOWS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: softGlowTexture(), color: 0xff4a0a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      setBlend(mat, 'additive');
      mat.blendSrc = THREE.SrcAlphaFactor;
      const m = new THREE.Mesh(glowGeo, mat);
      m.renderOrder = 7;
      m.visible = false;
      this._ceilGlows.push(m);
      scene?.add(m);
    }

    // volume puffs (look right when walking through it)
    this._nPuffs = puffs;
    const p = makePoints(puffs, base, 'normal');
    this._vGeo = p.geo; this._vPos = p.pos; this._vCol = p.col; this._vSize = p.size;
    this._vU = new Float32Array(puffs);
    this._vVel = new Float32Array(puffs * 2);
    this._grey = new THREE.Color(color);
    this._vShade = new Float32Array(puffs);
    for (let i = 0; i < puffs; i++) {
      this._vPos[i * 3] = (Math.random() - 0.5) * size * 0.9;
      this._vPos[i * 3 + 2] = (Math.random() - 0.5) * size * 0.9;
      this._vU[i] = Math.random();
      this._vVel[i * 2] = (Math.random() - 0.5) * 0.08;
      this._vVel[i * 2 + 1] = (Math.random() - 0.5) * 0.08;
      this._vSize[i] = 1.2 + Math.random() * 1.2;
      this._vShade[i] = 0.8 + Math.random() * 0.45; // some puffs darker, some lighter: billowy, not flat
    }
    p.pts.renderOrder = 6;
    this.group.add(p.pts);

    // head fog: gray sphere around the eyes
    this.fog = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x4a4a4c, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false,
      }),
    );
    this.fog.renderOrder = 999;
    this.fog.frustumCulled = false;
    this.fog.visible = false;
    this._fogLevel = 0;
    this.fogMax = 0.88;
    if (camera) {
      if (scene && !camera.parent) scene.add(camera); // camera children only render if it's in the scene
      camera.add(this.fog);
      setAudioListener(camera);
    }
  }

  /** Start the smoke at the scanned ceiling height (meters). */
  start(ceilingY = 2.6) {
    this.ceilingY = ceilingY;
    this.bottom = ceilingY - 0.05;
    this.active = true;
    this.group.visible = true;
  }

  /** Freeze the smoke where it is (drill over). */
  stop() {
    this.active = false;
  }

  /** Clear everything for a new drill. */
  reset() {
    this.active = false;
    this.group.visible = false;
    for (const g of this._ceilGlows) g.visible = false;
    this.bottom = this.ceilingY;
    this.depth = 0;
    this._fogLevel = 0;
    this.fog.material.opacity = 0;
    this.fog.visible = false;
    this.darkness = 0.3;
    _headFog = 0;
  }

  /** Center the smoke over the room's floor. */
  setCenter(x, z) {
    this.group.position.x = x;
    this.group.position.z = z;
  }

  /**
   * @param {number} dt
   * @param {number} headY  head height in meters
   * @param {FireSystem|Array|number} fires  the FireSystem (or a Fire list / count); more fire = faster, darker smoke
   * @returns {number} smoke depth at the head: 0 clear … 1 fully inside
   */
  update(dt, headY = 1.6, fires = []) {
    dt = Math.min(dt, 0.05);
    this._t += dt;

    let depth = 0;
    const [total, spots] = fireSummary(fires);
    this.totalIntensity = total;
    if (this.group.visible) {
      if (this.active && total > 0) {
        // time to head height between 20 s (small fire) and 15 s (big fire): always finishable
        const T = this.timeToHead - (this.timeToHead - this.fastestTimeToHead) * clamp01((total - 0.3) / 1.5);
        const rate = Math.max(0.02, (this.ceilingY - 0.05 - this.headHeight) / T);
        this.bottom = Math.max(this.minY, this.bottom - rate * dt);
      }
      // darker, denser smoke the bigger the fire, eased so it never pops
      this.darkness += (clamp01(0.25 + total / 2.4) - this.darkness) * Math.min(1, dt * 0.5);
      const dk = this.darkness;
      const thick = Math.max(0.05, this.ceilingY - this.bottom);
      const fill = clamp01(thick / Math.max(0.1, this.ceilingY - this.minY));
      // a big fire tints the whole smoke layer a dull orange from below
      const warm = clamp01(total / 4) * 0.35;

      const L = this._layers.length;
      for (let i = 0; i < L; i++) {
        const m = this._layers[i];
        m.position.y = this.bottom + (i / Math.max(1, L - 1)) * thick * 0.9;
        m.material.opacity = (i === 0 ? 0.4 + 0.45 * fill : 0.2 + 0.3 * fill) * (0.65 + 0.35 * dk);
        const v = 0.36 - 0.2 * dk; // light gray haze → near-black smoke
        const w = i === 0 ? warm : warm * 0.3;
        m.material.color.setRGB(v + w * 0.5, v + w * 0.12, v * 1.03, THREE.SRGBColorSpace);
        m.material.map.offset.x += dt * 0.012 * (i % 2 ? 1 : -1);
        m.material.map.offset.y += dt * 0.008;
      }

      const half = this.size * 0.45;
      const pos = this._vPos, col = this._vCol, g = this._grey;
      for (let i = 0; i < this._nPuffs; i++) {
        const i3 = i * 3;
        pos[i3] += this._vVel[i * 2] * dt;
        pos[i3 + 2] += this._vVel[i * 2 + 1] * dt;
        if (pos[i3] > half) pos[i3] = -half; else if (pos[i3] < -half) pos[i3] = half;
        if (pos[i3 + 2] > half) pos[i3 + 2] = -half; else if (pos[i3 + 2] < -half) pos[i3 + 2] = half;
        // u² packs most puffs just above the bottom: a billowy, visible underside
        pos[i3 + 1] = this.bottom + 0.1 + this._vU[i] * this._vU[i] * thick + Math.sin(this._t * 0.5 + i) * 0.05;
        const sh = this._vShade[i] * (1 - 0.35 * dk);
        col[i * 4] = g.r * sh; col[i * 4 + 1] = g.g * sh; col[i * 4 + 2] = g.b * sh;
        col[i * 4 + 3] = (0.2 + 0.35 * fill) * (0.6 + 0.4 * dk);
      }
      markDirty(this._vGeo);

      depth = clamp01((headY - this.bottom) / this.depthRange);
    }
    this.depth = depth;

    // fire light on the smoke underside
    for (let i = 0; i < CEIL_GLOWS; i++) {
      const g = this._ceilGlows[i], h = spots[i];
      const inten = h ? h.intensity ?? 0.5 : 0;
      g.visible = this.group.visible && !!h?.position && inten > 0.02;
      if (!g.visible) continue;
      const r = 1.6 + 2.4 * inten;
      g.position.set(h.position.x, this.bottom - 0.03, h.position.z);
      g.scale.set(r, 1, r);
      // brighter the closer the flames reach the smoke
      const reach = clamp01(1.4 - (this.bottom - h.position.y) / 1.6);
      g.material.opacity = 0.55 * inten * (0.4 + 0.6 * reach) * flicker(this._t, i * 3.1);
    }

    // fog eases in/out (no hard pops)
    this._fogLevel += (depth * this.fogMax - this._fogLevel) * Math.min(1, dt * 4);
    this.fog.material.opacity = this._fogLevel;
    this.fog.visible = this._fogLevel > 0.01;
    _headFog = this._fogLevel / this.fogMax;
    return depth;
  }
}

// ---------------------------------------------------------------------
// Exit / blocked sign: text sprite at ~1.9 m, always faces the viewer
// ---------------------------------------------------------------------
// ~0.23 m tall EXIT letters: readable from 3 m on a laptop and in the headset
const SIGN_W = 0.9;
const SIGN_H = 0.45;
const RING_Y = 0.025; // just above the floor, so the ring doesn't z-fight with it
const _exitSigns = new Set(); // every live sign: FireSystem keeps fire away from the open ones

export class ExitSign {
  /**
   * @param {THREE.Vector3|{x,y,z}} position  where the door/exit is (x/z used; height set to ~1.9 m)
   * @param {boolean} blocked
   */
  constructor(position, blocked = false) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      // depthTest off: the billboard tilts toward the viewer and would otherwise sink
      // halfway into the door/wall it's placed on. The head fog (renderOrder 999) still covers it.
      transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
    }));
    this.sprite.name = 'ExitSign';
    this.sprite.scale.set(SIGN_W, SIGN_H, 1);
    this.sprite.renderOrder = 20;
    this.position = this.sprite.position;
    if (position) this.position.set(position.x, Math.max(position.y ?? 0, SIGN_HEIGHT), position.z);
    else this.position.y = SIGN_HEIGHT;
    this._t = Math.random() * 10;

    // pulsing ring on the real floor under the sign (child, so it moves with the sprite;
    // scale compensated because sprite scale applies to children)
    this._ring = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.47, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      }),
    );
    this.sprite.add(this._ring);

    this.setBlocked(blocked);
    this.update(0); // place the ring on the floor even if update() is never called
    _exitSigns.add(this);
  }

  setBlocked(blocked) {
    this.blocked = !!blocked;
    this.sprite.material.map = signTexture(this.blocked);
    this.sprite.material.needsUpdate = true;
    this._ring.material.color.setHex(this.blocked ? 0xff2a2a : 0x22e06b);
  }

  /** Optional, call every frame: pulsing floor ring and a flickering BLOCKED sign. */
  update(dt = 0) {
    this._t += dt;
    const t = this._t;
    const sx = this.sprite.scale.x, sy = this.sprite.scale.y;
    this._ring.position.y = (RING_Y - this.position.y) / sy;
    let ringScale;
    if (this.blocked) {
      ringScale = 1;
      this._ring.material.opacity = 0.5 + 0.35 * Math.sin(t * 9);
      this.sprite.material.opacity = Math.random() < 0.05 ? 0.45 : 1;
    } else {
      const pulse = (t * 0.8) % 1;
      ringScale = 0.8 + pulse * 0.6;
      this._ring.material.opacity = 0.85 * (1 - pulse);
      this.sprite.material.opacity = 1;
    }
    this._ring.scale.set(ringScale / sx, ringScale / sy, ringScale);
  }

  dispose() {
    _exitSigns.delete(this);
    this.sprite.material.dispose();
    this._ring.geometry.dispose();
    this._ring.material.dispose();
    this.sprite.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Vision Pro drill hook, called by eileen-xr.js (README section 7, "Vision Pro drill hooks").
// roomRoot = the scan group: its matrix maps scan coordinates → XR world. The fire and smoke are
// parented to it, so they stay on the scan wherever it's aligned; positions given to and kept by
// the sim are scan coordinates, and worldFires() converts to XR world.
// The scan is unlit (baked textures), so engine lights can't touch it: the firelight is injected into
// its materials instead, and the smoke fills the space above the scan's floor.
// ---------------------------------------------------------------------

// visionOS Safari frame budget: everything that trades looks for frame rate, in one place
const XR_QUALITY = { maxFlames: 140, embers: 80, smoke: 200, smokePuffs: 120, smokeLayers: 3 };

// Warm, flickering firelight on unlit (MeshBasic) scan materials, from the fire's 4 lights.
// Multiplies the scan's own colours, so walls and floor near the fire glow orange like real firelight.
function tintWithFirelight(scan, roomRoot, lights) {
  const inv = new THREE.Matrix4().copy(roomRoot.matrixWorld).invert();
  scan.traverse((o) => {
    if (!o.isMesh) return;
    const toScan = { value: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) };
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!mat || mat.userData.firelight) continue;
      mat.userData.firelight = true;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uFireLights = lights;
        sh.uniforms.uFireToScan = toScan;
        sh.vertexShader = 'uniform mat4 uFireToScan;\nvarying vec3 vFireScan;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>', '#include <begin_vertex>\n  vFireScan = (uFireToScan * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = `uniform vec4 uFireLights[${MAX_LIGHTS}];\nvarying vec3 vFireScan;\n` + sh.fragmentShader.replace(
          '#include <opaque_fragment>', `{
    float lit = 0.0;
    for (int k = 0; k < ${MAX_LIGHTS}; k++) {
      vec3 d = uFireLights[k].xyz - vFireScan;
      lit += uFireLights[k].w / (1.0 + dot(d, d) * 1.2);
    }
    outgoingLight *= 1.0 + vec3(1.0, 0.42, 0.12) * min(lit, 1.2) * 1.4;
  }
  #include <opaque_fragment>`);
      };
      mat.customProgramCacheKey = () => 'firelight';
      mat.needsUpdate = true;
    }
  });
}

export function createXRFire(roomRoot, camera) {
  const fire = new FireSystem(roomRoot, {
    maxFlames: XR_QUALITY.maxFlames, embers: XR_QUALITY.embers, smoke: XR_QUALITY.smoke,
    surfaceLight: 0.15, // the scan itself carries the firelight (tintWithFirelight)
    edgeOver: 0.5,      // opaque scan, not passthrough: additive edges would tint its grey-blue walls green
  });
  const smoke = new Smoke(roomRoot, camera, { size: 18, layers: XR_QUALITY.smokeLayers, puffs: XR_QUALITY.smokePuffs });
  const head = new THREE.Vector3();
  let fueled = false, burning = false, pending = null;

  // the scan loads asynchronously: build its fuel the first time a fire needs it
  const fuel = () => {
    if (fueled) return true;
    const scan = findScanMesh(roomRoot);
    if (!scan) return false;
    fire.setFuelMesh(scan, { relativeTo: roomRoot });
    tintWithFirelight(scan, roomRoot, fire._lightU);
    const s = fire.sim;
    smoke.minY = s.floorY + 1.1;        // smoke heights are above the scan's floor, not its origin
    smoke.headHeight = s.floorY + 1.6;
    smoke.setCenter(s.center.x, s.center.z);
    fueled = true;
    return true;
  };

  const api = {
    fire, smoke,
    /** Start the fire at [x, y, z] in scan coordinates (snaps to the nearest fuel) */
    ignite(scanPos) {
      const p = { x: scanPos[0], y: scanPos[1], z: scanPos[2] };
      if (!fuel()) { pending = p; return; } // scan still loading: lit when it arrives
      // the marker is usually on the floor, and carpet alone burns low: start a burning object there,
      // which then lights the floor and the furniture around it
      fire.ignite(p, { pile: true });
      if (!burning) { smoke.start(fire.ceilingY); fire.startSound(); }
      burning = true;
    },
    /** Step fire + smoke; returns how deep the head is in smoke (0–1) */
    update(dt, running) {
      if (pending && fuel()) { const p = pending; pending = null; api.ignite([p.x, p.y, p.z]); }
      fire.update(dt, { running });
      smoke.active = burning && running; // the smoke drops during the drill and holds after it
      camera.getWorldPosition(head);
      roomRoot.worldToLocal(head);
      return smoke.update(dt, head.y, fire);
    },
    /** Fire positions in XR world, biggest first (for the DataFeel heat and the voice agent) */
    worldFires() {
      return fire.hotspots.map((h) => roomRoot.localToWorld(h.position.clone()));
    },
    /** Put the fire out and clear the smoke (keeps the fuel) */
    reset() {
      pending = null;
      burning = false;
      fire.stopSound();
      fire.reset();
      smoke.reset();
    },
  };
  return api;
}
