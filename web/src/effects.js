import * as THREE from 'three';

/* =====================================================================
   FireDrill AR — effects.js   (owner: Varnika)

   README section 7 contract:
     new Fire(position)       → .group (add to scene), .update(dt, growing), .intensity,
                                .startSound(), .stopSound()
     new Smoke(scene, camera) → .start(ceilingY), .update(dt, headY, fires) returns depth 0–1, .stop()
     new ExitSign(position, blocked) → .sprite, .position, .setBlocked(bool)

   Extras (safe to ignore):
     fire.dispose()
     smoke.reset(), smoke.setCenter(x, z), smoke.bottom
     sign.update(dt)   (pulsing floor ring, blocked flicker), sign.dispose()
     new FireSpread({ surfaces, onSpread }) → .update(dt, fires, exitSigns), .reset(), .targets[].heat
                                (heat-based spreading, smolder wisps, open exits stay clear)
     fire.spreadOver(area)    (FireSpread calls it: flames creep across big surfaces)
     setAudioListener(camera)   (Smoke does this for you)

   Built for Quest passthrough: premultiplied-alpha blending so fire stays bright
   over the real room. Each flame is a mediump noise shader on 3 quads (one draw call);
   only embers and smoke puffs are particles. All fires share a 1,700-particle budget
   (Smoke adds 240, so < 2,000) and only the first 4 fires get a PointLight.
   When the head is in smoke, a dim glow pass drawn after the head fog keeps fires visible.
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

// Smooth tiling value noise for the flame shader. Sampling a texture (instead of hashing in
// the shader) stays clean at mediump on the Quest and costs one fetch per octave.
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

// Charred scorch decal: near-black brown center, blotchy soft edge
let _scorchTex = null;
function scorchTexture() {
  return (_scorchTex ??= canvasTexture(128, 128, (g, s) => {
    const c = s / 2;
    let gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(8,5,3,0.92)');
    gr.addColorStop(0.45, 'rgba(18,11,6,0.7)');
    gr.addColorStop(0.8, 'rgba(30,20,12,0.25)');
    gr.addColorStop(1, 'rgba(30,20,12,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 14; i++) { // irregular edge
      const a = Math.random() * Math.PI * 2;
      const d = s * (0.08 + Math.random() * 0.22);
      const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
      const r = s * (0.08 + Math.random() * 0.12);
      gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(12,8,5,0.35)');
      gr.addColorStop(1, 'rgba(12,8,5,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    }
  }, true));
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

// Point sprites sized in meters, correct on desktop and in each Quest eye.
const _viewport = new THREE.Vector4();

function particleMaterial(map, mode) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uHalfH: { value: 500 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec4 aColor;
      uniform float uHalfH;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uHalfH * projectionMatrix[1][1] / max(-mv.z, 0.05);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec4 vColor;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vColor.a;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor.rgb * a, a);
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

// ---------------------------------------------------------------------
// Fire: procedural noise-shader flame on 3 quads, plus a few embers and smoke puffs
// ---------------------------------------------------------------------
const EMBER_N = 16;
const PUFF_N = 32;
const FLAME_W = 1.1;  // quad size in meters at scale 1, with room for tongues to wander and widen
const FLAME_H = 1.4;
const FLAME_NOMINAL_H = 1.1; // flame height at full intensity (tips can lick higher)

// Embers and puffs of all fires share one particle budget (+ Smoke's 240 puffs stays under 2,000).
// The flames themselves are 3 quads per fire, not particles.
const FIRE_BUDGET = 1700;
// Every PointLight adds cost to every lit pixel, so only the first few fires get one.
const MAX_FIRE_LIGHTS = 4;
const _fires = new Set();
let _sceneFires = 1;
let _countAcc = 0;
let _budgetCheckedAt = -Infinity;
let _lightsUsed = 0;
const _countIfInScene = (f) => { if (f.group.parent) _countAcc++; };
// How far the viewer's head is in smoke (0–1). Smoke.update() writes it; fires use it to glow through the fog.
let _headFog = 0;
// Particles currently used by smoldering wisps (FireSpread); fires leave that much budget free.
let _smolderInUse = 0;

function sceneFireCount() {
  const now = performance.now();
  if (now - _budgetCheckedAt > 250) {
    _budgetCheckedAt = now;
    _countAcc = 0;
    _fires.forEach(_countIfInScene);
    _sceneFires = Math.max(1, _countAcc);
  }
  return _sceneFires;
}

// Smooth "breathing" flicker around 1 (about 0.6–1.4): several sines, no Math.random
function flicker(t, seed) {
  return 1
    + 0.14 * Math.sin(t * 7.3 + seed)
    + 0.09 * Math.sin(t * 12.9 + seed * 2.1)
    + 0.05 * Math.sin(t * 23.7 + seed * 3.7)
    + 0.1 * Math.sin(t * 1.9 + seed * 0.7);
}

// 3 vertical quads: one Y-axis billboard and two crossed planes (at 0° and 90°) for volume
function flameGeometry() {
  const quads = [[0, 0, 0.0], [1, 0, 0.37], [1, Math.PI / 2, 0.71]]; // kind, angle, noise seed
  const quad = new Float32Array(quads.length * 8);
  const kind = new Float32Array(quads.length * 4);
  const angle = new Float32Array(quads.length * 4);
  const seed = new Float32Array(quads.length * 4);
  const pos = new Float32Array(quads.length * 12);
  const index = [];
  quads.forEach(([k, a, s], q) => {
    [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([x, y], v) => {
      const i = q * 4 + v;
      quad[i * 2] = x; quad[i * 2 + 1] = y;
      kind[i] = k; angle[i] = a; seed[i] = s;
      pos[i * 3] = x * FLAME_W * 0.5; pos[i * 3 + 1] = y * FLAME_H; // only for bounds
    });
    index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aQuad', new THREE.BufferAttribute(quad, 2));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setIndex(index);
  return geo;
}

function flameMaterial(scale) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNoise: { value: noiseTexture() },
      uSize: { value: new THREE.Vector2(FLAME_W * scale, FLAME_H * scale) },
      uScroll: { value: new THREE.Vector4() },
      uHeight: { value: 0.7 },
      uWidth: { value: 1 },
      uBright: { value: 1 },
      uSeed: { value: Math.random() },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aQuad;   // x: -1..1 across, y: 0..1 up
      attribute float aKind;  // 0 = billboard around Y, 1 = fixed crossed plane
      attribute float aAngle;
      attribute float aSeed;
      uniform vec2 uSize;
      varying vec2 vUv;
      varying float vFade;
      varying float vSeed;
      varying float vKind;
      void main() {
        vec3 center = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec2 d = normalize(cameraPosition.xz - center.xz + vec2(1e-4, 0.0));
        vec3 side;
        float fade = 1.0;
        if (aKind < 0.5) {
          side = vec3(-d.y, 0.0, d.x);
        } else {
          side = vec3(cos(aAngle), 0.0, sin(aAngle));
          // crossed planes fade out edge-on so they never show as thin streaks
          fade = 0.45 * smoothstep(0.2, 0.8, abs(dot(vec2(-side.z, side.x), d)));
        }
        float s = length(modelMatrix[0].xyz);
        vec3 world = center + side * (aQuad.x * 0.5 * uSize.x * s) + vec3(0.0, aQuad.y * uSize.y * s, 0.0);
        vUv = aQuad;
        vFade = fade;
        vSeed = aSeed;
        vKind = aKind;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform sampler2D uNoise;
      uniform vec4 uScroll;   // per-octave upward scroll, wrapped to 0–1 on the CPU
      uniform float uHeight;  // share of the quad the flame fills (intensity + flicker)
      uniform float uWidth;   // flame width factor: a thin lick when small, wide when grown
      uniform float uBright;
      uniform float uSeed;
      varying vec2 vUv;
      varying float vFade;
      varying float vSeed;
      varying float vKind;

      float nz(vec2 p) { return texture2D(uNoise, p).r; }

      void main() {
        // flame-space coords (the quad is wider than the flame body). Crossed planes draw a
        // narrower, shorter flame that adds depth inside the billboard's silhouette.
        float x = vUv.x * mix(1.833, 2.4, vKind) / uWidth;
        float y = vUv.y / uHeight * mix(1.0, 1.2, vKind);
        vec2 p = vec2(x * 0.045 + vSeed + uSeed, vUv.y * 0.09);
        // 4-octave fbm scrolling upward
        float n = 0.5 * nz(p + vec2(0.0, -uScroll.x))
                + 0.25 * nz(p * 2.0 + vec2(0.31, -uScroll.y))
                + 0.125 * nz(p * 4.0 + vec2(0.57, -uScroll.z))
                + 0.0625 * nz(p * 8.0 + vec2(0.11, -uScroll.w));
        n = clamp((n / 0.9375 - 0.5) * 2.2 + 0.5, 0.0, 1.0); // blurred fbm is low-contrast: stretch it
        // a second, narrower noise splits the upper flame into separate tongues
        float tongues = nz(vec2(x * 0.11 + uSeed * 1.7 + vSeed, vUv.y * 0.05 - uScroll.y));

        // distort: sideways wobble and upward stretch, both growing with height
        float xd = x + (n - 0.5) * 1.6 * y;
        float yd = y - (n - 0.45) * 0.9 * y;
        // teardrop: wide rounded base on the surface, tapering upward
        float w = 0.9 * pow(clamp(1.0 - yd, 0.0, 1.0), 0.7) * smoothstep(-0.3, 0.1, yd);
        float body = 1.0 - smoothstep(0.25 * w, w + 0.01, abs(xd));
        // heat: hottest low and central, eroded by noise toward the tips (licks)
        float heat = body * (1.25 - 0.8 * yd) - (1.0 - n) * (0.15 + 0.9 * yd) - (1.0 - tongues) * 0.9 * yd * yd;
        heat = clamp(heat * 1.6, 0.0, 1.0);
        if (heat <= 0.0) discard;

        // transparent → deep red → orange → yellow → near-white core. Every stop has G <= R,
        // so additive overlaps can clip to yellow-white but never tint green.
        vec3 c = mix(vec3(0.32, 0.015, 0.0), vec3(0.92, 0.2, 0.015), smoothstep(0.0, 0.35, heat));
        c = mix(c, vec3(1.0, 0.45, 0.05), smoothstep(0.3, 0.6, heat));
        c = mix(c, vec3(1.0, 0.6, 0.17), smoothstep(0.6, 0.9, heat));
        float core = smoothstep(0.8, 1.0, heat) * (1.0 - smoothstep(0.0, 0.35, y)) * (1.0 - smoothstep(0.0, 0.4, abs(x)));
        c = mix(c, vec3(1.0, 0.88, 0.72), core);

        // fade out before the quad edges so wandering tongues are never cut off,
        // and softly at the very bottom so the base doesn't end in a hard line
        float edge = (1.0 - smoothstep(0.7, 1.0, abs(vUv.x))) * (1.0 - smoothstep(0.85, 1.0, vUv.y)) * smoothstep(0.0, 0.05, vUv.y);
        float a = smoothstep(0.0, 0.3, heat) * vFade * edge;
        gl_FragColor = vec4(c * (a * uBright), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return setBlend(mat, 'additive');
}

// Drive one flame material: upward noise scroll, height and width from intensity, flicker
function setFlameUniforms(u, t, intensity, fl, fl2, widthMul = 1) {
  const rise = t * 0.16; // wrapped per octave so the shader stays at small numbers
  u.uScroll.value.set(rise % 1, (rise * 2.1) % 1, (rise * 4.3) % 1, (rise * 8.9) % 1);
  u.uHeight.value = (FLAME_NOMINAL_H / FLAME_H) * (0.3 + 0.7 * intensity) * (0.9 + 0.1 * fl2);
  u.uWidth.value = (0.4 + 0.6 * intensity) * widthMul;
  u.uBright.value = (0.8 + 0.3 * intensity) * (0.9 + 0.1 * fl);
}

const MAX_CLUSTERS = 3;      // extra flames per fire on a big surface
const CLUSTER_CREEP_S = 20;  // seconds for a cluster to creep from the start point to its edge

export class Fire {
  /**
   * @param {THREE.Vector3|{x,y,z}} position  base of the flames (e.g. the table top)
   */
  constructor(position, { scale = 1 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'Fire';
    if (position) this.group.position.set(position.x, position.y, position.z);
    this.position = this.group.position;
    this.baseScale = scale;
    this.intensity = 0.15; // 0–1: starts as a lick of flame, grows while growing === true
    this._growTime = 0;    // seconds spent growing (drives the creep across big surfaces)
    this._clusters = [];   // extra flames creeping across a large surface (see spreadOver)
    this._widthMul = 1;    // wider flames on big surfaces, so neighbouring clusters merge
    this._scorchMax = Infinity; // scorch never wider than the surface it's on
    this.age = 0;
    this.sound = null;
    this._wantSound = false;
    this._seed = Math.random() * 100;
    _fires.add(this);
    _budgetCheckedAt = -Infinity; // recount on the next update

    // scorch mark on the surface under the fire
    this._scorch = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: scorchTexture(), transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      }),
    );
    this._scorch.position.y = 0.004;
    this._scorch.rotation.y = Math.random() * Math.PI * 2;
    this._scorch.renderOrder = 1;
    this.group.add(this._scorch);

    // gray smoke puffs rising off the flame
    const p = makePoints(PUFF_N, puffTexture(), 'normal');
    this._pGeo = p.geo; this._pMat = p.mat; this._pPos = p.pos; this._pCol = p.col; this._pSize = p.size;
    this._pLife = new Float32Array(PUFF_N);
    this._pAge = new Float32Array(PUFF_N);
    this._pDrift = new Float32Array(PUFF_N * 2);
    for (let i = 0; i < PUFF_N; i++) {
      this._respawnPuff(i);
      this._pAge[i] = Math.random() * this._pLife[i];
    }
    p.pts.renderOrder = 8;
    this.group.add(p.pts);

    // faint halo around the flame (camera bloom)
    this._halo = this._glowSprite(0.12, 9, true);

    // the flame
    this._flameMat = flameMaterial(scale);
    this._flame = new THREE.Mesh(flameGeometry(), this._flameMat);
    this._flame.frustumCulled = false; // vertices are placed in the shader
    this._flame.renderOrder = 10;
    this.group.add(this._flame);

    // embers / sparks
    const e = makePoints(EMBER_N, glowTexture(), 'additive');
    this._eGeo = e.geo; this._eMat = e.mat; this._ePos = e.pos; this._eCol = e.col; this._eSize = e.size;
    this._eVel = new Float32Array(EMBER_N * 3);
    this._eLife = new Float32Array(EMBER_N);
    this._eAge = new Float32Array(EMBER_N);
    this._eSeed = new Float32Array(EMBER_N);
    for (let i = 0; i < EMBER_N; i++) {
      this._eSeed[i] = Math.random() * 50;
      this._respawnEmber(i);
      this._eAge[i] = Math.random() * this._eLife[i];
    }
    e.pts.renderOrder = 11;
    this.group.add(e.pts);

    // glow pass drawn after the head fog (999): flames read as an orange glow through smoke
    // not depth-tested: light scattered by smoke isn't cut off by the table/floor it sits on
    this._fogGlow = this._glowSprite(0, 1000, false);

    // breathing light (first MAX_FIRE_LIGHTS fires only)
    this.light = null;
    if (_lightsUsed < MAX_FIRE_LIGHTS) {
      _lightsUsed++;
      this.light = new THREE.PointLight(0xff6a1a, 2, 4, 2);
      this.light.position.y = 0.35;
      this.group.add(this.light);
    }

    this.update(0, false);
  }

  _glowSprite(opacity, renderOrder, depthTest) {
    const mat = new THREE.SpriteMaterial({
      map: softGlowTexture(), color: 0xff5a12, transparent: true, opacity, depthWrite: false, depthTest,
    });
    setBlend(mat, 'additive');
    mat.blendSrc = THREE.SrcAlphaFactor; // the sprite shader doesn't premultiply, so weight rgb by alpha here
    const sp = new THREE.Sprite(mat);
    sp.renderOrder = renderOrder;
    this.group.add(sp);
    return sp;
  }

  _respawnEmber(i) {
    const s = this.baseScale;
    const a = Math.random() * Math.PI * 2;
    const r = 0.12 * s * Math.sqrt(Math.random());
    const p = this._ePos, v = this._eVel;
    p[i * 3] = Math.cos(a) * r;
    p[i * 3 + 1] = (0.1 + Math.random() * 0.3) * s;
    p[i * 3 + 2] = Math.sin(a) * r;
    v[i * 3] = (Math.random() - 0.5) * 0.4;
    v[i * 3 + 1] = (0.6 + Math.random() * 0.9) * s;
    v[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    this._eLife[i] = 0.8 + Math.random() * 1.4;
    this._eAge[i] = 0;
  }

  _respawnPuff(i) {
    const s = this.baseScale * (0.65 + 0.45 * this.intensity);
    this._pPos[i * 3] = (Math.random() - 0.5) * 0.2 * s;
    this._pPos[i * 3 + 1] = 0.55 * s;
    this._pPos[i * 3 + 2] = (Math.random() - 0.5) * 0.2 * s;
    this._pDrift[i * 2] = (Math.random() - 0.5) * 0.2;
    this._pDrift[i * 2 + 1] = (Math.random() - 0.5) * 0.2;
    this._pLife[i] = 3.2 + Math.random() * 1.8; // long enough to reach the ceiling smoke
    this._pAge[i] = 0;
  }

  /**
   * @param {number} dt
   * @param {boolean} growing  true during the drill: the fire slowly gets bigger
   */
  update(dt, growing = false) {
    dt = Math.min(dt, 0.05);
    this.age += dt;
    if (growing) {
      this.intensity = Math.min(1, this.intensity + dt * 0.045);
      this._growTime += dt;
    }
    const s = this.baseScale * (0.65 + 0.45 * this.intensity);
    const t = this.age;
    const fl = flicker(t, this._seed);
    const fl2 = flicker(t * 1.3, this._seed + 17);

    // flame shader: scroll noise upward (wrapped per octave so the shader stays at small numbers)
    const u = this._flameMat.uniforms;
    setFlameUniforms(u, t, this.intensity, fl, fl2, this._widthMul);
    this._updateClusters(t);

    // share of the particle budget for embers and puffs (smoldering wisps take theirs first)
    const share = Math.floor((FIRE_BUDGET - _smolderInUse) / sceneFireCount());
    const nEmber = Math.min(EMBER_N, Math.max(0, Math.round(share * 0.3)));
    const nPuff = Math.min(PUFF_N, Math.max(0, share - nEmber));
    this._eGeo.setDrawRange(0, nEmber);
    this._pGeo.setDrawRange(0, nPuff);

    // embers: rise fast, drift and swirl, wink on and off, then die out
    const ep = this._ePos, ev = this._eVel, ec = this._eCol, es = this._eSize;
    for (let i = 0; i < nEmber; i++) {
      this._eAge[i] += dt;
      if (this._eAge[i] >= this._eLife[i]) this._respawnEmber(i);
      const k = this._eAge[i] / this._eLife[i];
      const sd = this._eSeed[i];
      const i3 = i * 3, i4 = i * 4;
      ep[i3] += (ev[i3] + Math.sin(t * 3 + sd) * 0.25) * dt;
      ep[i3 + 1] += ev[i3 + 1] * dt * (1 - 0.5 * k);
      ep[i3 + 2] += (ev[i3 + 2] + Math.cos(t * 2.6 + sd) * 0.25) * dt;
      const wink = Math.min(1, Math.max(0, Math.sin(t * (8 + (sd % 7)) + sd) * 2 + 1.2));
      ec[i4] = 1.0;
      ec[i4 + 1] = 0.55 - 0.3 * k;
      ec[i4 + 2] = 0.12 - 0.1 * k;
      ec[i4 + 3] = Math.min(1, k * 8) * (1 - k) * wink * 0.95;
      es[i] = (0.03 - 0.015 * k) * this.baseScale;
    }
    markDirty(this._eGeo);

    // smoke puffs: dark column rising off the flame toward the ceiling, growing and fading
    const pp = this._pPos, pc = this._pCol, ps = this._pSize;
    const puffA = 0.5 * (0.6 + 0.4 * this.intensity) * Math.min(1.8, Math.sqrt(PUFF_N / Math.max(1, nPuff)));
    for (let i = 0; i < nPuff; i++) {
      this._pAge[i] += dt;
      if (this._pAge[i] >= this._pLife[i]) this._respawnPuff(i);
      const k = this._pAge[i] / this._pLife[i];
      const i3 = i * 3, i4 = i * 4;
      pp[i3] += this._pDrift[i * 2] * dt;
      pp[i3 + 1] += 0.5 * s * dt;
      pp[i3 + 2] += this._pDrift[i * 2 + 1] * dt;
      pc[i4] = pc[i4 + 1] = pc[i4 + 2] = 0.16;
      pc[i4 + 3] = Math.min(1, k * 4) * (1 - k) * puffA;
      ps[i] = (0.3 + 0.9 * k) * s;
    }
    markDirty(this._pGeo);

    const flameH = FLAME_H * this.baseScale * u.uHeight.value;
    if (this.light) {
      this.light.intensity = 2.4 * this.intensity * fl;
      this.light.position.y = 0.3 * flameH + 0.03 * Math.sin(t * 5.1 + this._seed);
    }
    this._halo.scale.setScalar(1.1 * flameH);
    this._halo.position.y = 0.5 * flameH; // bottom edge at the surface, so it isn't sliced off
    this._halo.material.opacity = 0.1 * fl;
    // through the smoke: dim glow scaled by how deep the head is in it
    this._fogGlow.visible = _headFog > 0.02;
    this._fogGlow.scale.setScalar(2.6 * flameH);
    this._fogGlow.position.y = 0.4 * flameH;
    this._fogGlow.material.opacity = _headFog * (0.35 + 0.2 * this.intensity) * fl;

    const sc = Math.min(this._scorchMax, this.baseScale * (0.4 + 0.8 * this.intensity));
    this._scorch.scale.set(sc, 1, sc);
    this._scorch.material.opacity = Math.min(1, t / 4) * (0.7 + 0.3 * this.intensity);
    if (this.sound) this.sound.setVolume(0.5 + 0.5 * this.intensity);
  }

  /**
   * Called by FireSpread when this fire sits on a furniture surface. On a big surface (couch,
   * table) extra flame clusters creep from where it started toward the surface's edges over
   * ~20 s of growing, instead of one flame in the middle.
   * @param {{min:{x,z}, max:{x,z}, top:THREE.Vector3}} area  surface footprint (world, axis-aligned)
   */
  spreadOver(area) {
    if (this._clusters.length || this._scorchMax !== Infinity) return;
    const w = area.max.x - area.min.x, d = area.max.z - area.min.z;
    // room to the nearest edge from (x, z): caps the scorch so it never hangs off the surface
    const room = (x, z) => 2 * Math.max(0, Math.min(x - area.min.x, area.max.x - x, z - area.min.z, area.max.z - z)) + 0.1;
    const p0 = this.group.position;
    this._scorchMax = Math.max(0.2, room(p0.x, p0.z));
    const n = Math.min(MAX_CLUSTERS, Math.floor(Math.max(w, d) / 0.45));
    if (n < 1) return;
    this._widthMul = 1.35;
    // candidate spots: inset corners and edge midpoints; pick the n most spread out
    // (farthest-point sampling from where the fire started)
    const ix = Math.min(0.15, w / 4), iz = Math.min(0.15, d / 4);
    const xs = [area.min.x + ix, (area.min.x + area.max.x) / 2, area.max.x - ix];
    const zs = [area.min.z + iz, (area.min.z + area.max.z) / 2, area.max.z - iz];
    const cand = [];
    for (const x of xs) for (const z of zs) cand.push([x, z]);
    const p = this.group.position;
    const chosen = [[p.x, p.z]];
    for (let c = 0; c < n; c++) {
      let best = null, bestD = 0.3; // skip spots too close to an existing flame
      for (const q of cand) {
        let dmin = Infinity;
        for (const h of chosen) dmin = Math.min(dmin, Math.hypot(q[0] - h[0], q[1] - h[1]));
        if (dmin > bestD) { bestD = dmin; best = q; }
      }
      if (!best) break;
      chosen.push(best);
      const mat = flameMaterial(this.baseScale);
      const mesh = new THREE.Mesh(this._flame.geometry, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      mesh.visible = false;
      const scorch = new THREE.Mesh(this._scorch.geometry, this._scorch.material);
      scorch.renderOrder = 1;
      scorch.rotation.y = Math.random() * Math.PI * 2;
      scorch.visible = false;
      this.group.add(mesh, scorch);
      this._clusters.push({
        mesh, mat, scorch, start: this._growTime + c * 2.5, // staggered, one after another
        tx: best[0] - p.x, tz: best[1] - p.z, seed: Math.random() * 50,
        scorchMax: Math.max(0.2, room(best[0], best[1])),
      });
    }
  }

  _updateClusters(t) {
    for (const c of this._clusters) {
      const k = clamp01((this._growTime - c.start) / CLUSTER_CREEP_S);
      const e = k * k * (3 - 2 * k); // ease in/out
      c.mesh.visible = c.scorch.visible = k > 0;
      if (k <= 0) continue;
      c.mesh.position.set(c.tx * e, 0, c.tz * e);
      c.scorch.position.set(c.tx * e, 0.004, c.tz * e);
      const cs = 0.55 + 0.45 * e;
      c.mesh.scale.setScalar(cs);
      const ss = Math.min(cs * 0.9, c.scorchMax);
      c.scorch.scale.set(ss, 1, ss);
      const fl = flicker(t, c.seed), fl2 = flicker(t * 1.3, c.seed + 17);
      setFlameUniforms(c.mat.uniforms, t + c.seed, this.intensity * (0.4 + 0.6 * e), fl, fl2, this._widthMul);
    }
  }

  /** Looping crackle from the fire's position. Needs one user tap first (browser rule). */
  startSound() {
    this._wantSound = true;
    if (this.sound) {
      if (!this.sound.isPlaying) this.sound.play();
      return;
    }
    if (!_listener) return; // no camera listener yet: Smoke(scene, camera) or setAudioListener(camera)
    if (_listener.context.state === 'suspended') _listener.context.resume().catch(() => {});
    loadFireBuffer().then((buffer) => {
      if (!buffer || !this._wantSound || this.sound) return;
      const snd = new THREE.PositionalAudio(_listener);
      snd.setBuffer(buffer);
      snd.setLoop(true);
      snd.setRefDistance(1);
      snd.setRolloffFactor(1.5);
      snd.setVolume(0.5 + 0.5 * this.intensity);
      snd.position.y = 0.3;
      this.group.add(snd);
      this.sound = snd;
      try { snd.play(); } catch { /* audio context not unlocked yet */ }
    });
  }

  stopSound() {
    this._wantSound = false;
    if (this.sound?.isPlaying) this.sound.stop();
  }

  dispose() {
    this.stopSound();
    if (this.sound) this.sound.disconnect?.();
    this._flame.geometry.dispose(); this._flameMat.dispose();
    this._eGeo.dispose(); this._eMat.dispose();
    this._pGeo.dispose(); this._pMat.dispose();
    this._scorch.geometry.dispose(); this._scorch.material.dispose();
    this._halo.material.dispose(); this._fogGlow.material.dispose();
    for (const c of this._clusters) c.mat.dispose();
    if (this.light) { _lightsUsed--; this.light = null; }
    _fires.delete(this);
    _budgetCheckedAt = -Infinity;
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Smoke: ceiling layer that drops, plus head fog on the camera
// ---------------------------------------------------------------------
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

    // volume puffs (look right when walking through it)
    this._nPuffs = puffs;
    const p = makePoints(puffs, base, 'normal');
    this._vGeo = p.geo; this._vPos = p.pos; this._vCol = p.col; this._vSize = p.size;
    this._vU = new Float32Array(puffs);
    this._vVel = new Float32Array(puffs * 2);
    const grey = new THREE.Color(color);
    for (let i = 0; i < puffs; i++) {
      this._vPos[i * 3] = (Math.random() - 0.5) * size * 0.9;
      this._vPos[i * 3 + 2] = (Math.random() - 0.5) * size * 0.9;
      this._vU[i] = Math.random();
      this._vVel[i * 2] = (Math.random() - 0.5) * 0.08;
      this._vVel[i * 2 + 1] = (Math.random() - 0.5) * 0.08;
      this._vSize[i] = 1.2 + Math.random() * 1.2;
      const shade = 0.8 + Math.random() * 0.45; // some puffs darker, some lighter: billowy, not flat
      this._vCol[i * 4] = grey.r * shade;
      this._vCol[i * 4 + 1] = grey.g * shade;
      this._vCol[i * 4 + 2] = grey.b * shade;
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
   * @param {Array|number} fires  Fire list (or a count); more fires = faster smoke
   * @returns {number} smoke depth at the head: 0 clear … 1 fully inside
   */
  update(dt, headY = 1.6, fires = []) {
    dt = Math.min(dt, 0.05);
    this._t += dt;

    let depth = 0;
    if (this.group.visible) {
      // total fire size = summed intensity (a number is read as that many medium fires)
      let total = 0;
      if (Array.isArray(fires)) for (let i = 0; i < fires.length; i++) total += fires[i].intensity ?? 0.5;
      else total = (fires | 0) * 0.5;
      this.totalIntensity = total;
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

      const L = this._layers.length;
      for (let i = 0; i < L; i++) {
        const m = this._layers[i];
        m.position.y = this.bottom + (i / Math.max(1, L - 1)) * thick * 0.9;
        m.material.opacity = (i === 0 ? 0.4 + 0.45 * fill : 0.2 + 0.3 * fill) * (0.65 + 0.35 * dk);
        const v = 0.36 - 0.2 * dk; // light gray haze → near-black smoke
        m.material.color.setRGB(v, v, v * 1.03, THREE.SRGBColorSpace);
        m.material.map.offset.x += dt * 0.012 * (i % 2 ? 1 : -1);
        m.material.map.offset.y += dt * 0.008;
      }

      const half = this.size * 0.45;
      const pos = this._vPos, col = this._vCol;
      for (let i = 0; i < this._nPuffs; i++) {
        const i3 = i * 3;
        pos[i3] += this._vVel[i * 2] * dt;
        pos[i3 + 2] += this._vVel[i * 2 + 1] * dt;
        if (pos[i3] > half) pos[i3] = -half; else if (pos[i3] < -half) pos[i3] = half;
        if (pos[i3 + 2] > half) pos[i3 + 2] = -half; else if (pos[i3 + 2] < -half) pos[i3 + 2] = half;
        // u² packs most puffs just above the bottom: a billowy, visible underside
        pos[i3 + 1] = this.bottom + 0.1 + this._vU[i] * this._vU[i] * thick + Math.sin(this._t * 0.5 + i) * 0.05;
        col[i * 4 + 3] = (0.2 + 0.35 * fill) * (0.6 + 0.4 * dk);
      }
      markDirty(this._vGeo);

      depth = clamp01((headY - this.bottom) / this.depthRange);
    }
    this.depth = depth;

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
    this.sprite.material.dispose();
    this._ring.geometry.dispose();
    this._ring.material.dispose();
    this.sprite.removeFromParent();
  }
}

// ---------------------------------------------------------------------
// Fire spread: heat-based. Every unburned furniture surface soaks up heat from every fire
// (more from bigger and closer fires, most from fires below it). It smolders at 60% and
// ignites at 100%. Close things catch in seconds, far things later or never.
// surfaces = room.json surfaces: { label, kind, matrix: [16], polygon | vertices + indices }
// ---------------------------------------------------------------------
export const FURNITURE = /table|desk|couch|sofa|bed|chair|shelf|storage|cabinet|screen|lamp|plant/i;

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

/** World-space top area of a room.json surface: x/z bounds of its top, and the top-center point. */
export function surfaceArea(s) {
  const m = new THREE.Matrix4();
  if (Array.isArray(s.matrix) && s.matrix.length === 16) m.fromArray(s.matrix);
  const pts = readPoints(s);
  if (!pts.length) {
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    return { min: { x: c.x, z: c.z }, max: { x: c.x, z: c.z }, top: c };
  }
  let maxY = -Infinity;
  for (const p of pts) { p.applyMatrix4(m); maxY = Math.max(maxY, p.y); }
  const min = { x: Infinity, z: Infinity }, max = { x: -Infinity, z: -Infinity };
  for (const p of pts) {
    if (p.y < maxY - 0.06) continue; // top face only
    min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
    min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z);
  }
  return { min, max, top: new THREE.Vector3((min.x + max.x) / 2, maxY, (min.z + max.z) / 2) };
}

/** Top-center of a room.json surface in world space. */
export function surfaceTop(s) {
  return surfaceArea(s).top;
}

const SMOLDER_N = 96;        // wisp particles shared by all smoldering surfaces
const SMOLDER_AT = 0.6;      // share of the ignition threshold where wisps start

export class FireSpread {
  /**
   * @param {object} o
   * @param {Array} o.surfaces  room.json surfaces (furniture is picked by label)
   * @param {(pos: THREE.Vector3, surface: object) => void} o.onSpread  create the new Fire here
   * @param {number} o.maxFires  no new ignitions at or above this many fires
   * @param {number} o.firstSpreadAt  s into the drill before anything may ignite
   * @param {number} o.minGap  s between two ignitions
   * @param {number} o.heatRate  heat gain scale (1 = ignition threshold)
   * @param {number} o.exitClearance  m around an open exit sign where nothing ignites
   */
  constructor({
    surfaces = [], onSpread = null, maxFires = 6, firstSpreadAt = 10, minGap = 3,
    heatRate = 0.45, exitClearance = 1.5,
  } = {}) {
    Object.assign(this, { onSpread, maxFires, firstSpreadAt, minGap, heatRate, exitClearance });
    this.time = 0;
    this._lastIgnite = -Infinity;
    this._gen = 0;
    this._firePos = [];

    // smoldering wisps (added next to the fires automatically, or add spread.group yourself)
    this.group = new THREE.Group();
    this.group.name = 'FireSpreadSmolder';
    const w = makePoints(SMOLDER_N, puffTexture(), 'normal');
    this._wGeo = w.geo; this._wPos = w.pos; this._wCol = w.col; this._wSize = w.size;
    this._wAge = new Float32Array(SMOLDER_N).fill(1e9);
    this._wLife = new Float32Array(SMOLDER_N).fill(1);
    this._wTarget = new Int16Array(SMOLDER_N).fill(-1);
    this._wSeed = new Float32Array(SMOLDER_N).map(() => Math.random() * 50);
    w.pts.renderOrder = 7;
    this.group.add(w.pts);
    this._smoldering = [];
    this.setSurfaces(surfaces);
  }

  setSurfaces(surfaces = []) {
    this._gen++;
    this.targets = surfaces
      .filter((s) => FURNITURE.test(s.label || ''))
      .map((s) => ({ surface: s, label: s.label, ...surfaceArea(s), heat: 0, burning: false, protected: false }));
  }

  reset() {
    this.time = 0;
    this._lastIgnite = -Infinity;
    this._gen++;
    for (const t of this.targets) { t.heat = 0; t.burning = false; }
    this._wAge.fill(1e9);
    this._smoldering.length = 0;
    this._wGeo.setDrawRange(0, 0);
    _smolderInUse = 0;
  }

  /**
   * @param {number} dt
   * @param {Fire[]} fires
   * @param {ExitSign[]} [exits]  open (not blocked) exits keep a fire-free zone around them
   * @returns {THREE.Vector3|null} where a new fire just started, if any
   */
  update(dt, fires = [], exits = []) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    if (!this.group.parent && fires.length && fires[0].group?.parent) fires[0].group.parent.add(this.group);

    while (this._firePos.length < fires.length) this._firePos.push(new THREE.Vector3());
    for (let i = 0; i < fires.length; i++) (fires[i].group ?? fires[i]).getWorldPosition(this._firePos[i]);

    // fires sitting on a surface mark it burning, and big surfaces get creeping flames
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i];
      if (f._spreadGen === this._gen) continue;
      f._spreadGen = this._gen;
      const p = this._firePos[i];
      for (const t of this.targets) {
        if (p.x < t.min.x - 0.1 || p.x > t.max.x + 0.1 || p.z < t.min.z - 0.1 || p.z > t.max.z + 0.1) continue;
        if (Math.abs(p.y - t.top.y) > 0.2) continue;
        t.burning = true;
        f.spreadOver?.(t);
        break;
      }
    }

    // heat: Σ intensity × bias / (d² + 0.25), d to the surface's nearest point, none beyond 3.5 m
    let hottest = null;
    for (const t of this.targets) {
      t.protected = false;
      for (const s of exits) {
        if (!s || s.blocked) continue;
        const sp = s.position;
        const dx = Math.max(t.min.x - sp.x, 0, sp.x - t.max.x);
        const dz = Math.max(t.min.z - sp.z, 0, sp.z - t.max.z);
        if (Math.hypot(dx, dz) < this.exitClearance) { t.protected = true; break; }
      }
      if (t.burning) continue;
      let gain = 0, best = 0;
      for (let i = 0; i < fires.length; i++) {
        const p = this._firePos[i];
        const qx = Math.min(Math.max(p.x, t.min.x), t.max.x);
        const qz = Math.min(Math.max(p.z, t.min.z), t.max.z);
        const dy = t.top.y - p.y;
        const d = Math.hypot(qx - p.x, dy, qz - p.z);
        if (d > 3.5) continue;
        // above the flames heats fastest (up to 3.5x); below the fire heats slower
        const bias = dy > 0 ? 1 + 2.5 * clamp01(dy / (d + 0.01)) : 0.6 + 0.4 * (1 - clamp01(-dy / (d + 0.01)));
        const fall = 1 - clamp01((d - 2) / 1.5);
        const g = (fires[i].intensity ?? 0.5) * bias * fall / (d * d + 0.25);
        gain += g;
        if (g > best) { best = g; t._from = i; }
      }
      t.heat += gain * this.heatRate * dt;
      if (t.protected) t.heat = Math.min(t.heat, SMOLDER_AT - 0.01); // escape route stays clear
      if (t.heat >= 1 && (!hottest || t.heat > hottest.heat)) hottest = t;
    }

    this._updateSmolder(dt);

    if (!hottest || fires.length >= this.maxFires) return null;
    if (this.time < this.firstSpreadAt || this.time - this._lastIgnite < this.minGap) return null;

    // ignite where the heat comes from: the surface point nearest the hottest fire, a bit inside
    hottest.burning = true;
    this._lastIgnite = this.time;
    const src = this._firePos[hottest._from ?? 0] ?? hottest.top;
    const pos = new THREE.Vector3(
      Math.min(Math.max(src.x, hottest.min.x + 0.12), hottest.max.x - 0.12),
      hottest.top.y + 0.01,
      Math.min(Math.max(src.z, hottest.min.z + 0.12), hottest.max.z - 0.12),
    );
    if (hottest.min.x + 0.12 > hottest.max.x - 0.12) pos.x = hottest.top.x;
    if (hottest.min.z + 0.12 > hottest.max.z - 0.12) pos.z = hottest.top.z;
    this.onSpread?.(pos, hottest.surface);
    return pos;
  }

  // thin gray wisps rising from surfaces past 60% heat: shows what's about to catch
  _updateSmolder(dt) {
    const list = this._smoldering;
    list.length = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (!t.burning && t.heat >= SMOLDER_AT) list.push(i);
    }
    const n = list.length ? SMOLDER_N : 0;
    _smolderInUse = n;
    this._wGeo.setDrawRange(0, n);
    if (!n) return;
    const p = this._wPos, c = this._wCol, sz = this._wSize;
    for (let i = 0; i < n; i++) {
      this._wAge[i] += dt;
      const ti = this._wTarget[i];
      const t = ti >= 0 ? this.targets[ti] : null;
      const expired = t && this._wAge[i] >= this._wLife[i];
      if (expired || !t || t.burning || t.heat < SMOLDER_AT) {
        // respawn on one of the smoldering surfaces, at a random spot on its top
        const nt = this.targets[list[i % list.length]];
        this._wTarget[i] = list[i % list.length];
        p[i * 3] = nt.min.x + Math.random() * (nt.max.x - nt.min.x);
        p[i * 3 + 1] = nt.top.y + 0.02;
        p[i * 3 + 2] = nt.min.z + Math.random() * (nt.max.z - nt.min.z);
        this._wLife[i] = 2.5 + Math.random() * 1.5;
        // a fresh wisp starts at the surface; a reassigned one gets a random phase so they don't rise in lockstep
        this._wAge[i] = expired ? 0 : Math.random() * this._wLife[i];
        p[i * 3 + 1] += 0.28 * this._wAge[i];
      }
      const tt = this.targets[this._wTarget[i]];
      const k = this._wAge[i] / this._wLife[i];
      const strength = clamp01((tt.heat - SMOLDER_AT) / (1 - SMOLDER_AT));
      const sd = this._wSeed[i];
      p[i * 3] += Math.sin(this.time * 1.7 + sd) * 0.06 * dt;
      p[i * 3 + 1] += 0.28 * dt;
      p[i * 3 + 2] += Math.cos(this.time * 1.3 + sd) * 0.06 * dt;
      c[i * 4] = c[i * 4 + 1] = c[i * 4 + 2] = 0.5;
      c[i * 4 + 3] = Math.min(1, k * 5) * (1 - k) * (0.12 + 0.3 * strength);
      sz[i] = 0.1 + 0.45 * k;
    }
    markDirty(this._wGeo);
  }
}
