// Records the footage in video/assets/ from the app, frame by frame at an exact 30 fps.
//   1. cd web && npx vite --config vite.eileen.config.js --port 5175
//   2. node video/capture/record.cjs [shot ...]     (needs puppeteer: npm i -g puppeteer, and ffmpeg on PATH)
// Shots 1-6 come from web/video-capture.html (real scan + effects.js + hud.js, stepped by window.cap);
// "crouch" comes from web/effects-test.html with its clock replaced by a stepped one.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch {
  puppeteer = require(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'puppeteer'));
}

const BASE = process.env.CAPTURE_URL || 'https://localhost:5175';
const FPS = 30;
const OUT = path.resolve(__dirname, '..', 'assets');
const FRAMES = path.resolve(__dirname, 'frames');
const only = process.argv.slice(2);

// ---- camera helpers (scan coordinates, metres; scan floor ≈ -0.9) ----
const C = [4.6, -0.7, 5.2];
const lerp = (a, b, t) => a + (b - a) * t;
const lerpV = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
const ease = (t) => t * t * (3 - 2 * t);
const orbit = (deg, r, h) => [C[0] + r * Math.cos(deg * Math.PI / 180), h, C[2] + r * Math.sin(deg * Math.PI / 180)];
const ROUTE = [[4.4, 7], [3.7, 4], [3.3, 1.2], [3.5, -0.2]];
function along(points, d) { // point d metres along a polyline
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= len || i === points.length - 2) { const t = Math.min(1, d / len); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; }
    d -= len;
  }
}
const routeLen = ROUTE.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - ROUTE[i][0], p[1] - ROUTE[i][1]), 0);
const HEAD = -0.35; // crouched: 0.55 m above the scan floor

// Each shot: seconds, optional setup (once), frame(t 0..1, i) → page JS run before cap.step()
const SHOTS = [
  { name: '01-scan-orbit', secs: 9, setup: 'cap.fx.bloom.bloom.threshold = 0.92; cap.fx.bloom.bloom.strength = 0.45;',
    frame: (t) => `cap.look(${JSON.stringify(orbit(lerp(-85, -20, ease(t)), lerp(11.5, 9.5, t), lerp(6.5, 4.2, ease(t))))}, ${JSON.stringify(C)}, 45)` },
  { name: '02-ignite', secs: 7, setup: 'cap.speed(2);',
    frame: (t, i) => (i === 20 ? 'cap.ignite([6.2, 0, 2.9]);' : '')
      + `cap.look(${JSON.stringify(lerpV([10.2, 1.5, -2.2], [9.0, 0.9, -0.6], ease(t)))}, [6.0, -0.45, 3.0], 48)` },
  { name: '03-spread', secs: 7, setup: 'cap.speed(3);',
    frame: (t) => `cap.look(${JSON.stringify(lerpV([10.6, 1.6, 1.0], [10.2, 4.2, -2.6], ease(t)))}, [5.6, -0.8, 4.2], 50)` },
  { name: '04-signs-route', secs: 7,
    setup: `cap.speed(1); cap.smoke(false); cap.exit([3.5, -0.2, -0.5]); cap.exit([3.6, -0.2, 11.6], true); cap.route(${JSON.stringify(ROUTE)});`,
    frame: (t) => `cap.routeAlpha(${Math.min(1, t * 4).toFixed(3)}); cap.look(${JSON.stringify(lerpV([7.2, 3.6, 11.4], [6.2, 2.7, 9.6], ease(t)))}, [4.1, -1.0, 2.6], 52)` },
  { name: '05-pov-escape', secs: 10, setup: 'cap.smoke(true); cap.hud(true);',
    frame: (t) => {
      const d = ease(t) * (routeLen - 0.6);
      const p = along(ROUTE, d), q = along(ROUTE, d + 1.4);
      const bob = 0.02 * Math.sin(t * 10 * 2 * Math.PI * 0.9);
      return `cap.look([${p[0]}, ${HEAD + bob}, ${p[1]}], [${q[0]}, ${HEAD - 0.12}, ${q[1]}], 72)`;
    } },
  { name: '06-review', secs: 5, setup: 'cap.review(); cap.hud(true, [0, -0.02, -1], 0.82);',
    frame: (t) => { const p = along(ROUTE, routeLen - 0.6); return `cap.look([${p[0]}, ${HEAD + 0.25 * ease(Math.min(1, t * 2))}, ${p[1]}], [3.5, -0.25, -1.5], 72)`; } },
];

// effects-test.html: replace its clock + rAF with a stepped one before any page script runs
const STEPPED_CLOCK = `(() => {
  let vt = 0, id = 0; const cbs = new Map();
  performance.now = () => vt;
  window.requestAnimationFrame = (cb) => { cbs.set(++id, cb); return id; };
  window.cancelAnimationFrame = (i) => cbs.delete(i);
  window.__step = (ms) => { vt += ms; const list = [...cbs.values()]; cbs.clear(); for (const cb of list) cb(vt); };
})();`;
const CROUCH = { name: '07-crouch', secs: 9,
  frame: (t, i) => (i === 0 ? `effectsTest.look(0.4, 1.6, 2.2, 0.05, -0.12, false);` : '')
    + (i === 150 ? `effectsTest.look(0.4, 1.6, 2.2, 0.05, -0.05, true);` : '') + `window.__step(1000 / ${FPS});` };

function encode(name) {
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, name, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(OUT, `${name}.mp4`)], { stdio: 'inherit' });
  fs.rmSync(path.join(FRAMES, name), { recursive: true, force: true });
  console.log('wrote', path.join(OUT, `${name}.mp4`));
}

async function record(page, shot, stepJs = 'cap.step()') {
  const dir = path.join(FRAMES, shot.name);
  fs.mkdirSync(dir, { recursive: true });
  if (shot.setup) await page.evaluate(shot.setup);
  const n = Math.round(shot.secs * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(`${shot.frame(i / (n - 1), i)}; ${stepJs}`);
    await page.screenshot({ path: path.join(dir, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92, optimizeForSpeed: true });
  }
  encode(shot.name);
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, acceptInsecureCerts: true, defaultViewport: null,
    args: ['--window-size=1920,1140', '--ignore-certificate-errors', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--mute-audio'] });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const want = (name) => !only.length || only.some((o) => name.startsWith(o));

  if (SHOTS.some((s) => want(s.name))) {
    await page.goto(`${BASE}/video-capture.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.capReady', { timeout: 120000 });
    // shots share one simulation, so earlier shots always run (unrecorded ones fast-forward)
    const last = Math.max(...SHOTS.map((s, i) => (want(s.name) ? i : -1)));
    for (const shot of SHOTS.slice(0, last + 1)) {
      if (want(shot.name)) { await record(page, shot); continue; }
      if (shot.setup) await page.evaluate(shot.setup);
      const n = Math.round(shot.secs * FPS);
      for (let i = 0; i < n; i++) await page.evaluate(`${shot.frame(i / (n - 1), i)}; cap.step()`);
    }
  }
  if (want(CROUCH.name)) {
    await page.evaluateOnNewDocument(STEPPED_CLOCK);
    await page.goto(`${BASE}/effects-test.html`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '#hud, #ARButton, button { display: none !important; }' });
    await page.evaluate(`window.__step(16); effectsTest.addFire({ x: 0, y: 0.76, z: -1.5 }); effectsTest.startDrill();`);
    for (let i = 0; i < 300; i++) await page.evaluate('window.__step(1000 / 30)'); // let it catch and the smoke drop a bit
    await record(page, CROUCH, '0');
  }
  await browser.close();
})();
