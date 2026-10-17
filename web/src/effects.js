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
     new FireSpread({ surfaces, onSpread }) → .update(dt, fires), .reset()   (stretch: fire spreading)
     setAudioListener(camera)   (Smoke does this for you)

   Built for Quest passthrough: premultiplied-alpha blending so fire stays bright
   over the real room. Cheap: ~100 flame + 24 smoke particles per fire.
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
    if (blocked) {
      g.font = 'bold 92px Arial, Helvetica, sans-serif';
      g.fillText('BLOCKED', w / 2, h / 2 - 18);
      g.font = 'bold 34px Arial, Helvetica, sans-serif';
      g.fillText('DO NOT USE', w / 2, h / 2 + 52);
    } else {
      g.font = 'bold 132px Arial, Helvetica, sans-serif';
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
// Fire
// ---------------------------------------------------------------------
const FLAME_N = 100;
const PUFF_N = 24;

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
    this.intensity = 0.35; // 0–1, grows while growing === true
    this.age = 0;
    this.sound = null;
    this._wantSound = false;

    // flames
    const f = makePoints(FLAME_N, glowTexture(), 'additive');
    this._fGeo = f.geo; this._fMat = f.mat; this._fPos = f.pos; this._fCol = f.col; this._fSize = f.size;
    this._fVel = new Float32Array(FLAME_N * 3);
    this._fLife = new Float32Array(FLAME_N);
    this._fAge = new Float32Array(FLAME_N);
    this._fSeed = new Float32Array(FLAME_N);
    for (let i = 0; i < FLAME_N; i++) {
      this._fSeed[i] = Math.random() * 100;
      this._respawnFlame(i);
      this._fAge[i] = Math.random() * this._fLife[i];
    }
    f.pts.renderOrder = 10;
    this.group.add(f.pts);

    // gray smoke puffs rising off the flames
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

    // glow at the base
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xff6a14, transparent: true, opacity: 0.55,
      depthWrite: false,
    });
    setBlend(glowMat, 'additive');
    glowMat.blendSrc = THREE.SrcAlphaFactor; // the sprite shader doesn't premultiply, so weight rgb by alpha here
    this._glow = new THREE.Sprite(glowMat);
    this._glow.position.y = 0.12;
    this._glow.renderOrder = 9;
    this.group.add(this._glow);

    // flickering light
    this.light = new THREE.PointLight(0xff6a1a, 2, 4, 2);
    this.light.position.y = 0.35;
    this.group.add(this.light);

    this.update(0, false);
  }

  _respawnFlame(i) {
    const s = this.baseScale * (0.65 + 0.45 * this.intensity);
    const r = 0.17 * s * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const p = this._fPos, v = this._fVel;
    p[i * 3] = Math.cos(a) * r;
    p[i * 3 + 1] = 0.02;
    p[i * 3 + 2] = Math.sin(a) * r;
    v[i * 3] = (Math.random() - 0.5) * 0.1;
    v[i * 3 + 1] = (0.5 + Math.random() * 0.6) * s;
    v[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    this._fLife[i] = 0.5 + Math.random() * 0.6;
    this._fAge[i] = 0;
  }

  _respawnPuff(i) {
    const s = this.baseScale * (0.65 + 0.45 * this.intensity);
    this._pPos[i * 3] = (Math.random() - 0.5) * 0.15 * s;
    this._pPos[i * 3 + 1] = 0.35 * s;
    this._pPos[i * 3 + 2] = (Math.random() - 0.5) * 0.15 * s;
    this._pDrift[i * 2] = (Math.random() - 0.5) * 0.12;
    this._pDrift[i * 2 + 1] = (Math.random() - 0.5) * 0.12;
    this._pLife[i] = 2.2 + Math.random() * 1.6;
    this._pAge[i] = 0;
  }

  /**
   * @param {number} dt
   * @param {boolean} growing  true during the drill: the fire slowly gets bigger
   */
  update(dt, growing = false) {
    dt = Math.min(dt, 0.05);
    this.age += dt;
    if (growing) this.intensity = Math.min(1, this.intensity + dt * 0.04);
    const s = this.baseScale * (0.65 + 0.45 * this.intensity);
    const t = this.age;

    // flames: rise, pull into a cone, sway; yellow → orange → dark red
    const p = this._fPos, v = this._fVel, c = this._fCol, sz = this._fSize;
    for (let i = 0; i < FLAME_N; i++) {
      this._fAge[i] += dt;
      if (this._fAge[i] >= this._fLife[i]) this._respawnFlame(i);
      const k = this._fAge[i] / this._fLife[i];
      const i3 = i * 3, i4 = i * 4;
      const sway = Math.sin(t * 6 + this._fSeed[i]) * 0.06;
      p[i3] += (v[i3] + sway) * dt - p[i3] * dt * 1.6;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt - p[i3 + 2] * dt * 1.6;
      c[i4] = 1.0;
      c[i4 + 1] = Math.max(0.12, 0.88 - 0.75 * k);
      c[i4 + 2] = Math.max(0, 0.5 - 1.4 * k);
      c[i4 + 3] = Math.pow(Math.sin(Math.PI * k), 0.8) * 0.9;
      sz[i] = (0.3 - 0.19 * k) * s;
    }
    markDirty(this._fGeo);

    // smoke puffs: rise slowly, grow, fade
    const pp = this._pPos, pc = this._pCol, ps = this._pSize;
    for (let i = 0; i < PUFF_N; i++) {
      this._pAge[i] += dt;
      if (this._pAge[i] >= this._pLife[i]) this._respawnPuff(i);
      const k = this._pAge[i] / this._pLife[i];
      const i3 = i * 3, i4 = i * 4;
      pp[i3] += this._pDrift[i * 2] * dt;
      pp[i3 + 1] += 0.45 * s * dt;
      pp[i3 + 2] += this._pDrift[i * 2 + 1] * dt;
      pc[i4] = pc[i4 + 1] = pc[i4 + 2] = 0.22;
      pc[i4 + 3] = Math.sin(Math.PI * k) * 0.45 * (0.5 + 0.5 * this.intensity);
      ps[i] = (0.25 + 0.6 * k) * s;
    }
    markDirty(this._pGeo);

    const flick = 0.75 + Math.random() * 0.35 + 0.15 * Math.sin(t * 17);
    this.light.intensity = 2.4 * this.intensity * flick;
    this._glow.scale.setScalar(0.75 * s * (0.9 + 0.1 * Math.sin(t * 11)));
    this._glow.material.opacity = 0.45 + 0.15 * flick;
    if (this.sound) this.sound.setVolume(0.5 + 0.5 * this.intensity);
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
    this._fGeo.dispose(); this._fMat.dispose();
    this._pGeo.dispose(); this._pMat.dispose();
    this._glow.material.dispose();
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
    dropRate = 0.06,   // m/s with one fire; more fires drop faster
    depthRange = 0.5,  // head this far above the smoke bottom = depth 1
    layers = 4,
    puffs = 120,
    color = 0x3a3a3c,
  } = {}) {
    Object.assign(this, { size, minY, dropRate, depthRange });
    this.ceilingY = 2.6;
    this.bottom = this.ceilingY;
    this.depth = 0;
    this.active = false;
    this._t = 0;

    this.group = new THREE.Group();
    this.group.name = 'Smoke';
    this.group.visible = false;
    scene?.add(this.group);

    // flat cloud layers
    const base = puffTexture();
    this._layers = [];
    const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    for (let i = 0; i < layers; i++) {
      const map = base.clone();
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
      this._vSize[i] = 1.1 + Math.random() * 0.9;
      this._vCol[i * 4] = grey.r * 1.15;
      this._vCol[i * 4 + 1] = grey.g * 1.15;
      this._vCol[i * 4 + 2] = grey.b * 1.15;
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
      const n = Array.isArray(fires) ? fires.length : fires | 0;
      if (this.active && n > 0) {
        const rate = this.dropRate * Math.min(2, 0.6 + 0.4 * n);
        this.bottom = Math.max(this.minY, this.bottom - rate * dt);
      }
      const thick = Math.max(0.05, this.ceilingY - this.bottom);
      const fill = clamp01(thick / Math.max(0.1, this.ceilingY - this.minY));

      const L = this._layers.length;
      for (let i = 0; i < L; i++) {
        const m = this._layers[i];
        m.position.y = this.bottom + (i / Math.max(1, L - 1)) * thick * 0.9;
        m.material.opacity = (0.12 + 0.3 * fill) * (i === 0 ? 1.3 : 0.8);
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
        pos[i3 + 1] = this.bottom + 0.15 + this._vU[i] * thick + Math.sin(this._t * 0.5 + i) * 0.05;
        col[i * 4 + 3] = 0.1 + 0.3 * fill;
      }
      markDirty(this._vGeo);

      depth = clamp01((headY - this.bottom) / this.depthRange);
    }
    this.depth = depth;

    // fog eases in/out (no hard pops)
    this._fogLevel += (depth * this.fogMax - this._fogLevel) * Math.min(1, dt * 4);
    this.fog.material.opacity = this._fogLevel;
    this.fog.visible = this._fogLevel > 0.01;
    return depth;
  }
}

// ---------------------------------------------------------------------
// Exit / blocked sign: text sprite at ~1.9 m, always faces the viewer
// ---------------------------------------------------------------------
const SIGN_W = 0.62;
const SIGN_H = 0.31;

export class ExitSign {
  /**
   * @param {THREE.Vector3|{x,y,z}} position  where the door/exit is (x/z used; height set to ~1.9 m)
   * @param {boolean} blocked
   */
  constructor(position, blocked = false) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
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
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
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
    this._ring.position.y = (0.01 - this.position.y) / sy;
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
// Fire spread (stretch): every 12 s, nearest unburned furniture within 3 m catches fire
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

/** Top-center of a room.json surface in world space (x/z centroid, highest y). */
export function surfaceTop(s) {
  const m = new THREE.Matrix4();
  if (Array.isArray(s.matrix) && s.matrix.length === 16) m.fromArray(s.matrix);
  const pts = readPoints(s);
  if (!pts.length) return new THREE.Vector3().setFromMatrixPosition(m);
  let x = 0, z = 0, maxY = -Infinity;
  for (const p of pts) {
    p.applyMatrix4(m);
    x += p.x;
    z += p.z;
    maxY = Math.max(maxY, p.y);
  }
  return new THREE.Vector3(x / pts.length, maxY, z / pts.length);
}

export class FireSpread {
  constructor({ surfaces = [], interval = 12, maxDist = 3, maxFires = 6, onSpread = null } = {}) {
    Object.assign(this, { interval, maxDist, maxFires, onSpread });
    this.timer = 0;
    this._firePos = [];
    this.setSurfaces(surfaces);
  }

  setSurfaces(surfaces = []) {
    this.targets = surfaces
      .filter((s) => FURNITURE.test(s.label || ''))
      .map((s) => ({ surface: s, label: s.label, top: surfaceTop(s), burning: false }));
  }

  reset() {
    this.timer = 0;
    for (const t of this.targets) t.burning = false;
  }

  /** @returns {THREE.Vector3|null} where a new fire just started, if any */
  update(dt, fires = []) {
    if (!fires.length || !this.targets.length) return null;

    while (this._firePos.length < fires.length) this._firePos.push(new THREE.Vector3());
    for (let i = 0; i < fires.length; i++) {
      const obj = fires[i].group ?? fires[i];
      obj.getWorldPosition(this._firePos[i]);
    }

    for (const t of this.targets) {
      if (t.burning) continue;
      for (let i = 0; i < fires.length; i++) {
        const p = this._firePos[i];
        if (Math.hypot(p.x - t.top.x, p.z - t.top.z) < 0.6) { t.burning = true; break; }
      }
    }
    if (fires.length >= this.maxFires) return null;

    this.timer += dt;
    if (this.timer < this.interval) return null;
    this.timer = 0;

    let best = null;
    let bestD = this.maxDist;
    for (const t of this.targets) {
      if (t.burning) continue;
      for (let i = 0; i < fires.length; i++) {
        const d = this._firePos[i].distanceTo(t.top);
        if (d < bestD) { bestD = d; best = t; }
      }
    }
    if (!best) return null;
    best.burning = true;
    const pos = best.top.clone();
    pos.y += 0.01;
    this.onSpread?.(pos, best.surface);
    return pos;
  }
}
