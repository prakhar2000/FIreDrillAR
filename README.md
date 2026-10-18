# FireDrill AR — Team Handbook

**MOLTEN Spatial Hackathon · LA Tech Week · Sat Oct 17, 2026 · 231 S La Brea Ave, Inglewood · 9 AM – 9 PM**

Team: **Prakhar · Varnika · Eileen · Devaj · Emma**

---

## 1. TL;DR

An instructor builds a fire drill inside a real room in AR, using their voice and hands. A trainee then runs the drill: smoke drops from the real ceiling, fire crackles from its real spot, and DataFeel Dots on their wrists warm up on the side the fire is on. Afterwards, the review shows their path, how long they stayed low, and whether they found the right exit.

**Our track:** Worldbuild ("How do you say 'a forest over there' and get one?"; for us, "fire over there").

---

## 2. The event

- **What MOLTEN wants:** tools for *making* spatial content with your body and voice, not mouse-and-monitor tools like Blender or Unity.
- **Grand prize:** a Meta Quest 3S. Breakfast, lunch and Porto's dinner are provided.
- **Five tracks (pick one when submitting):**

| Track | Brief | Sponsors |
|---|---|---|
| **Worldbuild (ours)** | Author 3D environments and scenes | SideFX, Kaedim |
| Navigate | Interfaces that live in the air | AssemblyAI |
| Capture | Record and generate volumetric content | Roboflow, Niantic Spatial, Volinga |
| Inhabit | Embody a character or avatar | Rokoko, DataFeel |
| Open | Any spatial, multimodal creation tool | ElevenLabs, Miro |

- **Sponsors we use:** AssemblyAI (voice), ElevenLabs (sounds; free Creator month for participants), DataFeel (haptics).
- **To ask organizers:** Are sponsor prizes judged across all tracks? What time is submission, and what time is judging?

---

## 3. The idea

**Problem.** Realistic fire drills are hard to run in schools and offices. Live-fire training is dangerous and expensive, so most people never practice escaping a smoky room.

**How it works.**
1. **Build (instructor, in the Quest).** The headset's room scan already knows where the tables, doors and ceiling are. The instructor points and says:
   - "fire on the table" → AR fire appears on the real table
   - "this exit is blocked" → a red BLOCKED sign appears on that door
   - "exit here" → a green EXIT sign appears
   - No 3D skills needed.
2. **Drill (trainee).**
   - Smoke drops from the real ceiling and fogs their view if they stand up; they hear "stay low."
   - The fire crackles from its real direction and spreads to nearby furniture.
   - They must find the exit that isn't blocked.
3. **Feel it (DataFeel).**
   - The Dot on the side facing the fire warms up as they get closer.
   - Dots buzz when their head is in the smoke, and when they reach a blocked door.
   - A cool pulse means they reached the safe exit.
   - The Dots glow red so the audience can see what the trainee feels.
4. **Review.**
   - Their path is drawn on the floor: green where they stayed low, red where they were in smoke.
   - A stats panel shows time to exit, % of time low, and whether they checked the blocked door.

**Why it scores.**
- It's a creation tool for someone who isn't a 3D artist, which is exactly the brief.
- Social impact, and it runs in any room.
- Whole-body interaction: crouching under smoke is the actual skill being trained.

**Pitch line:** *"Realistic fire drills are hard to run. FireDrill AR lets an instructor build one in any room in minutes — and lets the trainee feel where the fire is."*

---

## 4. Hardware facts

### Meta Quest 3S (ours for ~1.5 hrs; 1 unit at the event)
- **Space Setup** scans the room and labels surfaces (floor, wall, ceiling, door, table, couch, …).
- Our web app reads that scan through **WebXR plane detection and mesh detection**.
- The scan is **not live**: it comes from setup time. Run Space Setup at the demo spot first.
- The 3S has no depth projector, so its scan is rougher than a Quest 3's. Rely on the labeled furniture boxes and walls, not fine detail.
- The Quest browser supports AR passthrough, hand tracking and the room scan, but **only on HTTPS pages**.

### DataFeel Gen 10 DevKit (after the Quest)
- **4 Dots** per kit, which chain to the **El Jefe** controller.
- Each Dot can do:
  - **vibration** (140–210 Hz)
  - **heat and cold** (4–50°C)
  - **8 full-colour LEDs**
  - motion sensing (IMU; we won't use it)
- Watch and velcro mounts are included. The El Jefe needs **its own power brick** (USB alone isn't enough).
- **El Jefe ports (from DataFeel's devkit guide):** it has two USB-C ports. The **top** one (USB symbol) is the **serial/data** port and goes to the laptop. The one below it (battery symbol) is **charging only** (a ≥20 W charger), and Windows won't see the kit if the laptop is plugged in there. Press the El Jefe's **power button**, and its battery LED should turn **blue** once it's connected to the computer (green = charging, red = on battery). Then press each **Dot's** power button: its blue LEDs "breathe". To reset the Dots, unplug them and plug them back in.
- **SDK (found):** official **Python** SDK `datafeel` in [DataFeel/devkit-samples](https://github.com/DataFeel/devkit-samples) `Python/` (also .NET there; no Unity needed). Not on PyPI; installed from GitHub via `server/requirements.txt`.
  - USB serial via a Silicon Labs **CP210x** chip, Modbus RTU at 115200. `discover_devices(4)` finds the port by USB ID (no hard-coded `COM3`) and returns Dots at addresses 1–4. No COM port in Device Manager → install Silicon Labs' "CP210x VCP" driver.
  - Calls we use: `registers.set_thermal_mode(ThermalMode.TEMPERATURE_TARGET)` + `registers.set_skin_temp_target(°C)`, `play_frequency(Hz, 0–1)` / `stop_vibration()`, `set_led(r, g, b)`, `disable_all_thermal()`, `registers.get_skin_temperature()` / `get_sink_temperature()`.
  - **SDK bug:** `activate_thermal_temperature_control()` calls a method that doesn't exist; use the two `registers.` calls above.
- **Lessons from another team's project** ([KaushikSiva/resonance](https://github.com/KaushikSiva/resonance), `thermoscene.py`):
  - Raw power mode (`activate_thermal_intensity_control`) overshot to 43°C. Use **temperature-target mode**; they ran 39°C hot / 32°C neutral / 19°C cold.
  - The heat sink saturates in **~15 s** of strong heat, so turn thermal off when the trainee isn't near a fire.
  - Hard cut-outs: skin > 40.5°C or sink > 48°C → drive to 28°C; resume below 37°C / 42°C.
  - Modbus is slow: drive the Dots from a background thread and only write when a value changes.
- **All of the above is implemented in `server/dots.py`** (38°C max, 20°C cool pulse, those cut-outs).
- **Hardware test (Oct 17, Dots lying on the table, not on skin):** all 4 Dots found on COM10, and the `devkit-samples` register map works with our kit. With a 39°C target, skin went 32 → 41°C in about 5 s, overshot to about 41.8°C, and the 40.5°C cut-out caught it, so heat cycled between about 36 and 42°C. Cool took skin from 36 to 28°C in about 9 s while the sink rose to 36°C. Left/right mapping is correct (left = Dots 1–2). Still to do: retest on a wrist, where skin's thermal mass should slow the overshoot.
- **If the El Jefe shows a COM port but no Dots answer** (`No device at address 1–4`): the CP210x is USB-powered, so the port appears even when the El Jefe is off. Press its power button (LED blue), reseat the 5-pin chain, and unplug and replug the Dots.
- **Ask Jiyi (DataFeel, on site):**
  1. ✅ Safe heat cap on skin: **38°C** (`MAX_HEAT_C` in `server/dots.py`; adjust there).
  2. Does the `devkit-samples` Python register map match our Gen 10 firmware?
  3. Can we keep the kit through judging?

---

## 5. Team & roles

| Person | Role | Owns | Hardware |
|---|---|---|---|
| **Prakhar** | XR lead + host | AR session, hand pinches, room scan, placement, doors → exits. Runs the laptop the Quest connects to. Merges code. | Quest |
| **Varnika** | Effects | Fire, smoke, head fog, exit/blocked signs, fire spreading | — |
| **Eileen** | Desktop + drill | Desktop mode (walk the saved room on a laptop), drill logic, review path + stats | — |
| **Devaj** | Backend + DataFeel | Python server, heat WebSocket, DataFeel driver (heat, buzz, cool, LEDs) | DataFeel |
| **Emma** | Voice, sound, pitch | AssemblyAI voice commands, ElevenLabs sounds, demo script, slides, backup video, submission | — |

Only Prakhar needs the Quest and only Devaj needs DataFeel. Everyone else builds and tests in Chrome on their own laptop. Each person owns separate files, so merges don't collide.

### Mac vs Windows

**Mac:** Prakhar, Varnika, Emma · **Windows:** Eileen, Devaj

The ones that can actually break the demo:
1. **Devaj's server unreachable.** Prakhar's Vite proxies `/py` to Devaj's laptop on port 8000. Windows marks a phone hotspot as *Public* and the firewall blocks it. Devaj: Settings → Network → hotspot → **Private**, and allow Python on Private networks. Test with `https://<prakhar-ip>:5173/py/health`.
2. **Getting the AR clip off the Quest (Prakhar, Mac).** macOS can't browse the headset like a drive. Install **Meta Quest Developer Hub** (or `adb`) *before* the Quest slot.
3. **DataFeel.** The Python SDK finds the El Jefe's port automatically (`COM…` on Windows, `/dev/tty.…` on Mac), but the kit plugs into one laptop, so keep the server and driver on Devaj's Windows laptop. If no COM port appears, install the Silicon Labs CP210x driver.
4. **Line endings.** `.gitattributes` forces LF for everyone, so Windows commits don't show whole-file diffs or conflicts. Don't remove it.

**Full list (git, npm, Python, network, Quest, browser code, demo-day laptop prep): see "Mac vs Windows: full reference" in [AGENTS.md](AGENTS.md).**

---

## 6. Setup from scratch

### 6.1 Everyone (15 min)

| | Mac | Windows | Linux |
|---|---|---|---|
| Install Node 20+ and Python 3.11 | `brew install node python@3.11` | Installers from nodejs.org and python.org (tick **Add to PATH**) | `nvm install 20`, then `sudo apt install python3.11 python3-pip python3.11-venv` |
| Terminal | Terminal | PowerShell | Terminal |
| Your IP (for the Quest) | `ipconfig getifaddr en0` | `ipconfig` → IPv4 Address | `hostname -I` |
| Firewall | Usually fine | When Windows asks about Node, click **Allow** on *Private* networks | `sudo ufw allow 5173` (and `8000` for Devaj) |
| Python venv | `python3 -m venv .venv && source .venv/bin/activate` | `py -m venv .venv` then `.venv\Scripts\activate` | `python3 -m venv .venv && source .venv/bin/activate` |

Also:
1. Install **Chrome** and **VS Code** (or any editor) and **git**.
2. Add Meta's **Immersive Web Emulator** extension to Chrome. It adds a **WebXR** tab in DevTools that fakes a Quest, including hands, pinches and a room.
3. Get a GitHub account and send your username to Prakhar.
4. Join everyone's laptops and the Quest to **one phone hotspot** (venue Wi-Fi often blocks devices from talking to each other).

### 6.2 Prakhar: create the repo (15 min, then everyone clones)

```bash
mkdir firedrill && cd firedrill
git init
npm create vite@latest web -- --template vanilla
cd web
npm install
npm install three
npm install -D @vitejs/plugin-basic-ssl
mkdir -p public/sounds
cd ..
mkdir server data pitch
```

**Folder layout:**
```
firedrill/
  web/
    index.html
    vite.config.js          (Prakhar)
    public/sounds/          (Emma: fire.mp3, alarm.mp3)
    public/textures/        (Varnika: flames.png, fire flipbook; credit Unity Labs, CC0)
    src/
      main.js               (Prakhar) app loop, AR session, pinches, scenario functions
      room.js               (Prakhar) room scan → surfaces, save/load room.json
      effects.js            (Varnika) FireSystem (+ Fire), Smoke, ExitSign
      desktop.js            (Eileen)  WASD walk, crouch, load room.json
      drill.js              (Eileen)  drill timer, escape checks, review
      voice.js              (Emma)    AssemblyAI streaming + command parser
      heat.js               (Devaj)   WebSocket to the server, heat direction math
      hud.js                (Prakhar) status text on screen / in headset
  server/                   (Devaj)   Python server + DataFeel driver
  unity/                    (Devaj)   Unity 6000.5.10f1 phone-AR fire (ARCore/ARKit): tap a surface to ignite; code in Assets/Fire
  data/                     room.json and drill logs (commit room.json so everyone gets it)
  pitch/                    (Emma)    script, slides, video
  README.md                 this handbook
  AGENTS.md                 shared agent instructions (all agents read this)
  CLAUDE.md                 just imports AGENTS.md for Claude Code (CLAUDE.local.md = personal, gitignored)
```

**`web/vite.config.js`** (replace the generated one). It serves over HTTPS, lets the Quest reach the laptop, saves `room.json` and drill logs into `data/`, and forwards `/py/...` to Devaj's Python server:

```js
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(__dirname, '../data');
// Devaj's laptop IP if the server runs there; localhost if it runs on Prakhar's laptop
const PY_SERVER = process.env.PY_SERVER || 'http://localhost:8000';

const readBody = (req) => new Promise((ok, fail) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); req.on('error', fail);
});

function jsonStore() {
  return {
    name: 'json-store',
    configureServer(server) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      server.middlewares.use(async (req, res, next) => {
        const url = req.url.split('?')[0];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          if (url === '/api/room' && req.method === 'POST') {
            const body = await readBody(req); JSON.parse(body);
            fs.writeFileSync(path.join(DATA_DIR, 'room.json'), body);
            fs.writeFileSync(path.join(DATA_DIR, `room-${stamp}.json`), body); // keep every capture
            return res.end('{"ok":true}');
          }
          if (url === '/api/room' && req.method === 'GET') {
            const f = path.join(DATA_DIR, 'room.json');
            if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('{}'); }
            res.setHeader('Content-Type', 'application/json');
            return res.end(fs.readFileSync(f));
          }
          if (url === '/api/log' && req.method === 'POST') {
            const body = await readBody(req); JSON.parse(body);
            fs.writeFileSync(path.join(DATA_DIR, `drill-${stamp}.json`), body);
            return res.end('{"ok":true}');
          }
        } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: String(e) })); }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), jsonStore()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/py': { target: PY_SERVER, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/py/, '') } },
  },
});
```

Then:
1. Create the empty files from the layout, each exporting a placeholder, so imports work from minute one.
2. Add a `.gitignore` with `node_modules/`, `.venv/`, `.env`, `dist/`.
3. Commit, push to GitHub, and add everyone as collaborators.

**Everyone else:**
```bash
git clone <repo-url>
cd firedrill/web
npm install
npm run dev
```
Open the `https://localhost:5173` link Vite prints, and click past the certificate warning (Advanced → Proceed).

### 6.3 Connecting the Quest (Prakhar)
1. On the Quest: **Settings → Environment setup → Space setup** at the demo spot. Look at every wall, the floor, the ceiling, the table and a door.
2. Put the Quest on the same hotspot as your laptop.
3. Sanity check: open `threejs.org/examples/webxr_ar_cones.html` in the Quest browser and tap **Start AR**. You should see your room.
4. On your laptop, run `npm run dev`. On the Quest, open `https://<your-laptop-ip>:5173` and accept the warning.
5. When the page asks to use **spatial data**, tap **Allow**; it's how we read the room scan.
6. **Casting**, so the team can watch: ask the hardware desk which Meta account the Quest uses. Open `meta.com/casting` on a laptop logged into it, then in the headset go to Camera → Cast → Computer.
7. If the Quest can't reach the laptop, use a tunnel instead: `cloudflared tunnel --url https://localhost:5173 --no-tls-verify`, then open the `https://…trycloudflare.com` link it prints.

### 6.4 Devaj: Python server

```bash
cd firedrill/server
python3 -m venv .venv && source .venv/bin/activate     # Windows: py -m venv .venv ; .venv\Scripts\activate
pip install -r requirements.txt
```

`server/requirements.txt` is hand-written (includes the DataFeel SDK from GitHub, so `git` must be installed). Don't regenerate it with `pip freeze`; see "Mac vs Windows" in section 5.

`server/.env` (never commit this):
```
ASSEMBLYAI_API_KEY=your_key_here
```

Server code (in the repo):
- `server/app.py`: `/health` (key loaded? Dots status), `/token` (temporary AssemblyAI token for Emma's `voice.js`), `/ws/heat` (haptics messages → `dots.update()`; on disconnect everything turns off).
- `server/dots.py`: DataFeel driver (section 4). `python dots.py` = logic check + hardware hello-world.

Run it with `uvicorn app:app --host 0.0.0.0 --port 8000 --reload`. Then check `https://<prakhar-ip>:5173/py/health` in a browser; you should see `{"ok": true, ...}`.

If the server runs on **Devaj's** laptop, Prakhar starts Vite with:
- `PY_SERVER=http://<devaj-ip>:8000 npm run dev` (Mac/Linux)
- `$env:PY_SERVER="http://<devaj-ip>:8000"; npm run dev` (Windows PowerShell)

### 6.5 Emma: keys and accounts
- **AssemblyAI:** sign up, copy the API key, and give it to Devaj for `server/.env`. Don't paste it anywhere else.
- **ElevenLabs:** claim the free Creator month via the link on the portal's Tracks page. Generate:
  - `fire.mp3`: a crackling indoor fire, about 10 s, loopable
  - `alarm.mp3`: a building fire alarm, about 3 s
  - Put both in `web/public/sounds/`.

---

## 7. Shared contracts (agree on these first)

Everyone codes against these, so pieces plug together at merge time.

**`room.json`** (Prakhar writes, Eileen reads):
```json
{
  "version": 1,
  "capturedAt": "2026-10-17T12:40:00Z",
  "surfaces": [
    { "kind": "plane", "label": "table", "matrix": [16 numbers], "polygon": [[x,y,z], ...] },
    { "kind": "mesh",  "label": "couch", "matrix": [16 numbers], "vertices": [...], "indices": [...] }
  ]
}
```

**Scenario functions** (in `main.js`; Prakhar writes them, everyone calls them):
`addFire(pos)` · `addExit(pos, blocked)` · `startDrill()` · `stopDrill(reason)` · `resetDrill()` · `clearAll()`

**Effects** (Varnika, `effects.js`):
- `new FireSystem(scene, { surfaces })` → one fire simulation for the whole room (recommended). `surfaces` = `room.json` surfaces; tables, couches etc., the floor and the walls become fuel.
  - `.ignite(pos)` start a fire (snaps to the nearest fuel) · `.update(dt, { running })` (running = drill on: spreads, grows, burns out) · `.setExits(exitSigns)` (open exits keep a 1.5 m fire-free zone)
  - `.hotspots` → up to 8 `{ position, intensity 0–1 }` (use for heat direction) · `.totalIntensity` · `.reset()` · `.startSound()` / `.stopSound()` · `.setSurfaces(surfaces)` · `.speed` (1 = demo pace)
- `new Fire(position)` still works: it lights a shared FireSystem (`fireSystem()`), which loads `/api/room` for fuel unless you call `fireSystem().setSurfaces(surfaces)`. With no `room.json`, it burns the room scan mesh in the scene by itself (floor, flat furniture 0.25–1.4 m up, scanned walls); `fireSystem().setFuelMesh(mesh)` does that explicitly. Every `ExitSign` in the scene keeps fire 1.5 m away unless `setExits()` names the exits. `.group` (add to scene), `.update(dt, growing)`, `.intensity` (fire size around that spot), `.startSound()`, `.stopSound()`
- `createFireBloom(renderer, scene, camera)` → `.render()` (desktop glow + heat shimmer above the fires; call it instead of `renderer.render(scene, camera)`; renders plainly in XR), `.enabled`, `.setSize(w, h)`
- `new Smoke(scene, camera)` → `.start(ceilingY)`, `.update(dt, headY, fires)` returns smoke depth 0–1 (`fires` = the FireSystem or the Fire list), `.stop()`
- `new ExitSign(position, blocked)` → `.sprite`, `.position`, `.setBlocked(bool)`

**Drill** (Eileen, `drill.js`):
- `drill.start()`
- `drill.update(dt, headPos, smokeDepth, exits)` returns `'escaped' | 'blocked' | 'timeout' | null`
- `drill.stop(reason)`, `drill.drawReview(floorY, headPos, headQuat)`, `drill.stats()`

**Voice commands** (Emma, `voice.js`): `parseCommand(text)` returns one of:
`{type:'fire', on:'table'|null}` · `{type:'exit'}` · `{type:'block'}` · `{type:'start'}` · `{type:'stop'}` · `{type:'reset'}` · `{type:'clear'}`

**Haptics message** (browser → Devaj's server over `/py/ws/heat`, about 4 per second):
```json
{ "left": 0.0, "right": 0.7, "buzz": false, "cool": false }
```
`left`/`right` = how hot each wrist should be (0–1). `buzz` = in smoke or at a blocked door. `cool` = reached the safe exit.

**Calling it** (`heat.js`, Devaj): `connect()` once at startup (`main.js` already does), then each frame in the drill loop:
`send({ ...heatFrom(headPos, headQuat, firePositions), buzz, cool })`. `headPos`/`headQuat` are the camera's world position and quaternion (three.js objects work as-is); `firePositions` are the fires' world positions. `send` keeps only the newest message and handles the 4/s limit and reconnects, so call it freely.

**Vision Pro drill hooks** (`eileen-xr.js` calls these; stubs are in place, owners fill them in). Positions are XR world unless noted:
- `createXRFire(roomRoot, camera)` (effects.js) → `{ ignite(scanPos), update(dt, running) → smokeDepth 0–1, worldFires() → Vector3[], reset() }`
- `drill` (drill.js) `.start()`, `.update(dt, { smokeDepth, head, exits }) → { time, oxygen 0–1, smokeDepth, escaped, timedOut }`, `.stop(reason)`, `.stats() → { time, oxygen, smokeTime, pctLow, checkedBlocked }`
- `createXRHud(camera)` (hud.js) → `{ update(state), review(stats) }`
- `startAgent(getContext)` (voice.js): `getContext() → { head, facing, fires, exits, blocked }` as `[x,y,z]` arrays
- `POST /py/agent` (server): `{ transcript, head, facing, fires, exits, blocked } → { reply }`
- Ignition: an annotation item `{ type: 'fire', position }` (scan coordinates) from the observer. Test without it: `firedrill.ignite([x, y, z])` in the headset page console.

---

## 8. Build plan by person

### Today's demo: Vision Pro (WebXR), decided 4:50 PM
The demo runs on Eileen's Vision Pro page (`web/eileen-xr.html`, `immersive-vr` in Safari: the textured scan, not passthrough). The desktop observer (`desktop.js`) aligns the headset and places markers. A Unity Vision Pro port comes **after** the hackathon: it needs a Mac, a paid Unity license tier, and the fire shaders rewritten in Shader Graph, and visionOS gives no camera frames without Apple's Enterprise entitlement. The 5:30 feature freeze still applies unless the team agrees to move it.

Flow: the observer places a fire in a corner of the scan → the headset sees fire and smoke → the EXIT signs light up and route arrows appear at once → the user walks out while the agent coaches by voice, the wrists warm near the fire, and the oxygen bar drains in smoke → review screen with time and oxygen.

Paste-ready instructions for each person's agent: [`TASKS-visionpro.md`](TASKS-visionpro.md). The wiring and stubs are already in `eileen-xr.js`, so everyone can start at once.

| Who | Task | Files |
|---|---|---|
| Eileen | Add a Fire tool to the observer. On ignition, run Auto route from the headset to the nearest unblocked EXIT and show it. Exits come from the observer's EXIT marks on the scan; that is our "exit-sign detection". After ignition, show large glowing EXIT signs and floor arrows. | `eileen-*.js`, `desktop.js` |
| Varnika | ✅ `createXRFire()` done: the marker starts a burning object that spreads over the scan's floor and furniture (scan mesh as fuel, in scan coordinates under `roomRoot`); firelight tints the scan itself; smoke fills the space 2.4 m above the scan floor and drops to 1.1 m; flame edges tuned for an opaque scene; budget in `XR_QUALITY` (140 flames, 80 embers, 200 smoke puffs). Tested in Chrome with a rotated, aligned scan; 🚧 not yet on the Vision Pro. | `effects.js` |
| Prakhar | Host: Vite with `vite.eileen.config.js` plus `PY_SERVER`. In-headset HUD: drill timer, an oxygen bar that drains with `smoke.update()` depth, and a review panel (escape time, oxygen left, time in smoke). Merge to `main`. | `hud.js`, `drill.js` (Eileen's, agreed) |
| Emma | Hands-free voice: start the mic when VR starts, keep listening, and send each finished turn to `/py/agent`. Speak the reply with `speechSynthesis`. Test the mic in visionOS Safari first. Pitch and submission. | `voice.js`, `pitch/` |
| Devaj | `/py/agent`: transcript + headset position, fire and exits → a short spoken direction from Claude. Check the heat stream from the headset (already wired in `eileen-xr.js`). Wear the DataFeel on the wrists and test. Stretch: find EXIT signs automatically in the scan textures with Claude vision. | `server/`, `heat.js` |

### Prakhar — XR lead + host
- **Scaffold** (Vite HTTPS app, placeholder modules, `server/app.py`): ✅ done
- **Exported scan preview** (`10_17_2026 (1)/*.obj` in the browser): ✅ loads. Mesh is about 7.6 × 1.8 × 13.8 m. Click places fire. **Start AR** puts the headset on the floor of the scan.
1. **Hello AR.** three.js scene + `ARButton` with `requiredFeatures: ['local-floor']` and `optionalFeatures: ['hand-tracking', 'plane-detection', 'mesh-detection']`. Set `renderer.xr.setReferenceSpaceType('local-floor')` and a transparent background.
   *Done when:* a cube floats in your real room.
2. **Room reader (`room.js`).** Each frame, loop over `frame.detectedPlanes` and `frame.detectedMeshes`:
   - Read `semanticLabel`, the pose (`frame.getPose(plane.planeSpace, refSpace)`), and `polygon` (planes) or `vertices`/`indices` (meshes).
   - Draw faint outlines.
   - When nothing has changed for 3 s, POST everything to `/api/room`.
   - *Done when:* table, door and ceiling show up labeled, and `data/room.json` exists. **Commit it.**
3. **Pinches.** Use `renderer.xr.getController(0/1)` and read `handedness` on `connected`.
   - Right pinch (`select`): raycast to the room surfaces and place the current tool.
   - Left pinch: cycle fire → exit → blocked → start.
   - Doors from the scan become exits automatically.
   - *Done when:* fire sits on the real table.
4. **Scenario functions + HUD** from section 7, then wire in Varnika's effects, Eileen's drill and Emma's voice at each merge.
5. **Record an AR clip** before the Quest goes back (Quest: Camera → Record video). Try to rebook the Quest near judging for a clean final recording.

### Varnika — Effects (`effects.js`)
- **Fire, smoke, head fog, signs, spread:** ✅ done in test page (`/effects-test.html`) · **Visual polish:** ✅ done (readable signs at 3 m, visible smoke ceiling reaching 1.6 m in 15–18 s, fire under a 2,000-particle / 4-light budget) · **Realistic fire:** ✅ done (noise-shader flames, embers, scorch marks, breathing light, glow through smoke) · **Fire redesign:** ✅ done: `FireSystem` burns the room's surfaces cell by cell (tabletops, furniture sides, floor, walls). Fire grows, creeps across surfaces, climbs walls, drops burning bits on the floor, catches nearby furniture by radiant heat, then chars and glows out. Demo pace in the test room: table fully alight ~20 s, couch ~37 s, floor 20–45 s, first wall ~88 s, desk ~2.2 min. Flames play a flipbook (Unity Labs `Flame03`, `web/public/textures/flames.png`; each tongue with its own speed, start frame and mirroring; procedural flames if the file is missing; V toggles on the test page), char and ember overlays on the surfaces, smoke rising off the flames, fire glow on the smoke ceiling. Test page: H = heat view, F = 4× time · next: 🚧 test in the Quest (lower `maxFlames` if it drops frames) · **Fire look in the room:** ✅ done (desktop bloom via `createFireBloom`, stronger firelight that scales with fire size and also tints the real room in AR, furniture chars under the flames, thick black smoke above each fire; B toggles bloom on the test page) · **Fire in the real app:** ✅ done (no room.json needed: fire spreads over the scanned office mesh in `main.js` with no code changes there; open exit signs stay clear automatically) · **Vision Pro:** ✅ `createXRFire()` (see the Vision Pro table) · **Layered fire:** ✅ done (yellow-white core, orange body, dark red tips into a straight black smoke column; irregular licking heights; flare-ups with sparks every 5–10 s; desktop heat shimmer)
- **Credit (for the submission form):** Flame flipbooks: Unity Labs, CC0 (`Flame03` from Unity's free VFX flipbooks, https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks). Emma: list it under credits / third-party assets.
1. **Fire:** about 80–100 particles with a soft round texture and additive blending. Colour runs yellow → orange → dark red as they rise; add a flickering orange `PointLight`. `intensity` grows slowly during the drill.
2. **Smoke layer:** a few stacked gray translucent planes starting at the ceiling height and dropping slowly to about 1.1 m, faster with more fires. Add gray smoke puffs rising from each fire.
3. **Head fog:** a gray sphere (BackSide, depthTest off) attached to the camera, with opacity rising as the head goes above the smoke layer. `update()` returns how deep the head is in smoke (0–1).
4. **Signs:** green "EXIT" and red "BLOCKED" text sprites placed at about 1.9 m height.
5. **Fire spread (stretch):** every ~12 s, a new fire appears on the nearest unburned piece of furniture within 3 m.

*Done when:* in a test page, the fire looks convincing, the smoke drops, and moving the camera up fogs the view.

### Eileen — Desktop mode + drill (`desktop.js`, `drill.js`)
1. **Desktop mode:** `PointerLockControls`, WASD to walk, mouse to look, **C** to crouch (eye height 1.6 m ↔ 0.9 m).
   - Load `/api/room` (Prakhar's `room.json`). Until it exists, use a fake room: floor, 4 walls, ceiling at 2.6 m, a table, a couch, 2 doors.
   - Keys: **1/2/3** pick the tool, click places, **Enter** starts/stops the drill, **R** resets.
2. **Drill logic:**
   - Timer, and log the head position every 0.2 s.
   - Within 1 m of an open exit = escaped; within 1 m of a blocked exit = "checked the blocked door" (buzz).
   - 3-minute timeout.
3. **Review:**
   - Path line on the floor, coloured green when low and red when in smoke.
   - A stats panel facing the user: time, % time low, checked blocked door yes/no.
   - POST the log to `/api/log`.

*Done when:* the full drill runs on a laptop in the real scanned room and ends on the review screen. **This is our live demo after the Quest goes back.**

### Devaj — Backend + DataFeel (`server/`, `heat.js`)
1. **Server** from section 6.4: `/health`, `/token`, `/ws/heat` printing messages.
2. ✅ **`heat.js` (browser side):** a WebSocket to `/py/ws/heat` that reconnects every 3 s, sending at most 4 messages per second. Heat math:
   - proximity = 1 at 0.5 m from the nearest fire, 0 at 4.5 m
   - side = dot product of the direction to the fire with the head's right vector
   - `left = proximity × (0.5 − 0.5 × side)`, `right = proximity × (0.5 + 0.5 × side)`
   - Check: `node web/src/heat.check.js` (no output = pass). Distances are horizontal only, so crouching doesn't change which wrist is warm.
3. ✅ **Kit connected:** `python dots.py` finds 4 Dots on COM10 (Dots 1–2 left, 3–4 right). Heat cap confirmed with Jiyi: 38°C. 🚧 Still to do: the wrist test (the same heat/buzz/cool run, with the Dots worn).
4. ✅ (code) / ✅ (end-to-end over `/ws/heat` on hardware: heat, cut-outs, buzz, cool, mapping) / 🚧 (not yet worn on a wrist) **DataFeel driver, `server/dots.py`:**
   - left/right Dots warm by proximity (first half of the Dots = left wrist; `SWAP_SIDES` if strapped the other way), 33°C → 38°C, off when not near a fire
   - vibrate at 170 Hz on `buzz`; all Dots go to 20°C and blue on `cool`; LEDs red by heat
   - safety cut-outs and auto-reconnect; `/health` shows the Dots' status; with no kit it prints `[no Dots] L … R …` instead
   - Heat changes over seconds, so start warming from a few metres away.

*Done when:* walking toward the fire in desktop mode warms the correct wrist, standing up in smoke buzzes, and reaching the exit gives a cool pulse.

5. ⏸ **Phone-AR fire (`unity/`)**, paused for today's Vision Pro demo; port to visionOS after the hackathon. Devaj has it working and is the only one who builds and runs the Unity app; send Unity requests to him. Open it with Unity Hub → Add → `unity/` (Unity 6000.5.10f1). Then run **Fire > Build AR Scene**, which writes `Assets/Fire/Scenes/FireAR.unity`. Tapping a detected plane ignites a fire, which spreads over the planes with smoke and firelight. `Library/` is regenerated and gitignored.

### Emma — Voice, sound, pitch (`voice.js`, `public/sounds/`, `pitch/`)
1. **Voice (`voice.js`):**
   - Fetch `/py/token`, then open the mic with `getUserMedia`.
   - Convert to 16 kHz mono 16-bit PCM and send ~100 ms chunks to `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&token=…`.
   - On a `Turn` message with `end_of_turn: true`, pass `transcript` to `parseCommand()`.
   - Matching is simple keywords: fire (+ table/couch/desk…), exit, blocked, start, stop, reset, clear.
2. **Sounds:** ElevenLabs `fire.mp3` and `alarm.mp3` (section 6.5). Prakhar plays the fire sound from the fire's position.
3. **Pitch:** a 90-second demo script, 3–4 slides (problem, how it works, what it feels like, impact), the backup video, and the submission write-up. Sort out the submission form early.

*Done when:* saying "fire on the table" places fire, and the team has rehearsed the demo three times.

---

## 9. Timeline

Submission is assumed around 6:30 PM; check the portal's Overview and Event calendar for the real time.

| Time | Prakhar | Varnika | Eileen | Devaj | Emma |
|---|---|---|---|---|---|
| 12:15–12:45 | Space Setup, AR test, create repo | Setup, clone | Setup, clone | Setup, server skeleton, find Jiyi | Setup, keys, ElevenLabs |
| 12:45–1:30 | AR + room reader on the Quest, **save + commit room.json**, **record AR clip** | Fire + smoke test page | Desktop mode, fake room | `/token`, `/ws/heat`, `heat.js` | Voice commands working on desktop |
| **1:30** | **Merge 1** | | | | |
| 1:30–3:00 | Pinch placement, wire effects + voice | Head fog, signs, spread | Load real room, drill + review | DataFeel SDK hello-world | Sounds in, demo script |
| **3:00** | **Merge 2** | | | | |
| 3:00–4:30 | Bug fixes, rebook the Quest | Polish visuals | Review polish | **DataFeel slot:** heat, buzz, cool, LEDs | Slides |
| **4:30** | **Merge 3: everything works together** | | | | |
| 4:30–5:30 | Final AR recording (if rebooked) | Test | Test | Tune haptics on real walks | Record backup video |
| 5:30–6:30 | **Freeze.** Rehearse 3 times, submit | | | | |

The two things that matter most during the Quest slot are **`room.json` saved and committed** and **an AR clip recorded**. Everything after that runs on laptops.

---

## 10. Git workflow
- Everyone works on their own branch (`prakhar`, `varnika`, `eileen`, `devaj`, `emma`) and only edits the files they own.
- Push often: `git add -A && git commit -m "…" && git push`.
- At each merge time, Prakhar merges all branches into `main`, and everyone pulls: `git pull origin main`.
- After **5:30, no new features**, only fixes.

---

## 11. Demo (90 seconds)
1. **Pitch line** (Emma).
2. **AR recording:** the instructor says "fire on the table," fire appears on the real table, the exit is marked blocked, smoke drops.
3. **Live:** a judge wears the Dots and walks the drill on the laptop in our scanned room.
   - The wrist facing the fire warms up.
   - Standing up into smoke buzzes and fogs the view.
   - Reaching the open exit gives a cool pulse.
4. **Review screen:** their path and stats.
5. **Close:** "Any room. Any instructor. Minutes, not a training facility."

**Props:** the Dots, the laptop on a big screen, the AR clip ready to play, and the backup video.

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| No "Start AR" / "AR not supported" | The page isn't HTTPS. Use `https://<ip>:5173` and accept the certificate warning |
| Quest can't reach the laptop | Same hotspot? Using the IP, not localhost? Firewall allowed (Windows: Allow on Private)? Else use the cloudflared tunnel |
| No room surfaces in AR | Space Setup not done at this spot, or the spatial-data prompt was denied. Restart the AR session |
| Calls to the server fail from the Quest | Always go through `/py/...` on the Vite address, never `http://…:8000` directly (the Quest blocks HTTP from an HTTPS page) |
| No sound | Browsers need one tap/click before playing audio |
| Voice does nothing | Is the server running? Key in `server/.env`? Mic allowed? Check `/py/health` |
| Desktop mode shows the fake room | `data/room.json` is missing; pull `main` after Prakhar commits it |
| DataFeel doesn't respond | Check the El Jefe connection and power, run the SDK's hello-world, ask Jiyi |

---

## 13. Links
- Immersive Web Emulator: https://github.com/meta-quest/immersive-web-emulator
- three.js WebXR AR example: https://threejs.org/examples/webxr_ar_cones.html
- Meta web docs, scene understanding: https://developers.meta.com/horizon/documentation/web/iwsdk-guide-scene-understanding/
- AssemblyAI streaming: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
- AssemblyAI temporary tokens: https://www.assemblyai.com/docs/speech-to-text/universal-streaming/authenticate-with-a-temporary-token
- ElevenLabs sound effects: https://elevenlabs.io/docs/overview/capabilities/sound-effects
- Quest casting: https://www.meta.com/casting
- DataFeel quick start: the link on the portal's Tracks page (Inhabit)
