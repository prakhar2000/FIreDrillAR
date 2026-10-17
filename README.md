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
- **SDK:** Unity, .NET "and more." Watch and velcro mounts are included.
- **Ask Jiyi (DataFeel, on site):**
  1. What is a safe heat cap on skin? 50°C is too hot to hold against skin; plan for about 40°C until she gives a number.
  2. Which SDK is easiest to drive from a laptop (Python?), and can it take commands over the network?

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
    src/
      main.js               (Prakhar) app loop, AR session, pinches, scenario functions
      room.js               (Prakhar) room scan → surfaces, save/load room.json
      effects.js            (Varnika) Fire, Smoke, ExitSign
      desktop.js            (Eileen)  WASD walk, crouch, load room.json
      drill.js              (Eileen)  drill timer, escape checks, review
      voice.js              (Emma)    AssemblyAI streaming + command parser
      heat.js               (Devaj)   WebSocket to the server, heat direction math
      hud.js                (Prakhar) status text on screen / in headset
  server/                   (Devaj)   Python server + DataFeel driver
  data/                     room.json and drill logs (commit room.json so everyone gets it)
  pitch/                    (Emma)    script, slides, video
  README.md                 this handbook
  CLAUDE.md                 shared Claude instructions (CLAUDE.local.md = personal, gitignored)
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
pip install fastapi "uvicorn[standard]" httpx python-dotenv
pip freeze > requirements.txt
```

`server/.env` (never commit this):
```
ASSEMBLYAI_API_KEY=your_key_here
```

`server/app.py` starting point:
```python
import json, os
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

load_dotenv()
KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
app = FastAPI()

MAX_HEAT_C = 40      # replace with Jiyi's safe number
NEUTRAL_C = 33       # roughly skin temperature
COOL_C = 20

def drive_dots(left, right, buzz, cool):
    """Translate the app's message into Dot commands. Replace the print with DataFeel SDK calls."""
    t_left = NEUTRAL_C + left * (MAX_HEAT_C - NEUTRAL_C)
    t_right = NEUTRAL_C + right * (MAX_HEAT_C - NEUTRAL_C)
    if cool:
        t_left = t_right = COOL_C
    print(f"L {t_left:.1f}C  R {t_right:.1f}C  buzz={buzz}  cool={cool}")
    # TODO (Devaj): set Dot temperatures, vibrate when buzz, LEDs red scaled by max(left, right)

@app.get("/health")
def health():
    return {"ok": True, "assemblyai_key": bool(KEY)}

@app.get("/token")
async def token():
    if not KEY:
        raise HTTPException(500, "Set ASSEMBLYAI_API_KEY in server/.env")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get("https://streaming.assemblyai.com/v3/token",
                        params={"expires_in_seconds": 60}, headers={"Authorization": KEY})
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    return r.json()          # {"token": "..."}

@app.websocket("/ws/heat")
async def heat(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            m = json.loads(await ws.receive_text())
            drive_dots(m.get("left", 0), m.get("right", 0), m.get("buzz", False), m.get("cool", False))
    except WebSocketDisconnect:
        drive_dots(0, 0, False, False)
```

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
- `new Fire(position)` → `.group` (add to scene), `.update(dt, growing)`, `.intensity`, `.startSound()`, `.stopSound()`
- `new Smoke(scene, camera)` → `.start(ceilingY)`, `.update(dt, headY, fires)` returns smoke depth 0–1, `.stop()`
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

---

## 8. Build plan by person

### Prakhar — XR lead + host
- **Scaffold** (Vite HTTPS app, placeholder modules, `server/app.py`): ✅ done
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
- **Fire, smoke, head fog, signs, spread:** ✅ done in test page (`/effects-test.html`) · **Visual polish:** 🚧 next
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
2. **`heat.js` (browser side):** a WebSocket to `/py/ws/heat` that reconnects every 3 s, sending at most 4 messages per second. Heat math:
   - proximity = 1 at 0.5 m from the nearest fire, 0 at 4.5 m
   - side = dot product of the direction to the fire with the head's right vector
   - `left = proximity × (0.5 − 0.5 × side)`, `right = proximity × (0.5 + 0.5 × side)`
3. **Before the kit arrives:** talk to Jiyi about the safe heat cap and the easiest SDK. Install the SDK and run its hello-world.
4. **DataFeel slot:** fill in `drive_dots()`:
   - left/right Dots warm by proximity, capped
   - vibrate on `buzz`
   - all Dots cool on `cool`
   - LEDs glow red by heat
   - Heat changes over seconds, so start warming from a few metres away.

*Done when:* walking toward the fire in desktop mode warms the correct wrist, standing up in smoke buzzes, and reaching the exit gives a cool pulse.

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
