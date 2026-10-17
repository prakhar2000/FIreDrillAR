# Vision Pro drill: paste-ready tasks (Oct 17)

Each block below is a complete instruction for that person's coding agent. Copy the whole block into a fresh session in your clone of the repo.

**Shared ground rules (already in each block):** pull first, edit only your files, keep `README.md` section 8 status current in the same commit, push to your own branch, and tell Prakhar when it's ready to merge. The team's 5:30 PM feature freeze still applies unless the team agrees to move it.

**Unity:** Devaj has the Unity project (`unity/`) working, so he is the one who builds and runs it. Don't open, build or commit `unity/` yourself; send Unity changes or requests to Devaj. (A Vision Pro Unity build after the hackathon needs a Mac with Xcode; Devaj drives it from there.)

**How the pieces fit:** `web/src/eileen-xr.js` already calls every hook below, and each hook has a working stub. You can each fill in your own piece and test it without waiting for anyone else. The contract is in README section 7, "Vision Pro drill hooks". Test without a headset: run the Eileen dev server (below), open `https://localhost:5173/eileen-xr.html` in Chrome with the **Immersive Web Emulator** extension, Start VR, then type `firedrill.ignite([0, 0, 0])` in the console (scan coordinates).

Dev server (Prakhar hosts; anyone can run it locally):
- Mac: `cd web && PY_SERVER=http://<devaj-ip>:8000 npm run dev -- --config vite.eileen.config.js`
- Windows: `cd web; $env:PY_SERVER="http://<devaj-ip>:8000"; npm run dev -- --config vite.eileen.config.js`

Observer (computer): `https://<host-ip>:5173/` · Headset (Vision Pro Safari): `https://<host-ip>:5173/eileen-xr.html`

---

## Prakhar: oxygen, timer, HUD, review (and host + merge)

```text
Project: FireDrill AR (repo root). Read AGENTS.md and README.md sections 7 and 8 ("Vision Pro drill hooks", "Today's demo: Vision Pro") first. Today's demo is the Vision Pro WebXR page web/eileen-xr.html (immersive-vr in Safari, the textured room scan, not passthrough). Work on branch `prakhar`; first run `git pull origin main`.

Your files: web/src/drill.js (Eileen's file; she agreed you take it today, so say so in the commit message) and web/src/hud.js. Don't edit other files; eileen-xr.js already calls your code.

1. drill.js: implement the contract in the file's header comment.
   - start(): reset and start the clock at ignition.
   - update(dt, { smokeDepth, head, exits }): head is a THREE.Vector3 in XR local-floor space (y = eye height above the floor), and exits is a THREE.Vector3[] in the same space. Return { time, oxygen, smokeDepth, escaped, timedOut }.
     - Oxygen starts at 1 and drains while smokeDepth > 0 (rate ∝ smokeDepth; empty after about 45 s at depth 1, as a named constant). It recovers slowly when out of smoke.
     - escaped = horizontal distance to any exit < 1 m. timedOut = time > 180 s or oxygen hits 0.
     - Track smokeTime (seconds with smokeDepth > 0.3) and pctLow (share of time with head.y < 1.2 m).
   - stop(reason) freezes the clock. stats() returns { time, oxygen, smokeTime, pctLow, checkedBlocked }; leave checkedBlocked false for now.
   - Leave a small node self-check (like web/src/heat.check.js) for the oxygen and escape math.
2. hud.js createXRHud(camera): a head-locked panel parented to the camera, about 1 m ahead and slightly below eye level. Use a canvas texture (font 'bold 64px Arial'), depthTest false and a high renderOrder.
   - update(state): show the mm:ss timer, a large oxygen bar (green → amber → red), and a flashing "STAY LOW" when smokeDepth > 0.3.
   - review(stats): replace it with a large review card: Escaped / Out of air, escape time, oxygen left, time in smoke, % time low.
   - It must look polished: rounded panel, generous padding, high contrast, readable in VR. Redraw the canvas only when the text changes.
3. Test: Chrome + Immersive Web Emulator on eileen-xr.html, then firedrill.ignite([0,0,0]) in the console. Move the emulated headset into the smoke and out to an EXIT marker.
4. Host for the demo: run the Eileen dev server with PY_SERVER pointing at Devaj's laptop (README "Today's demo" + TASKS-visionpro.md), and check https://<your-ip>:5173/py/health.
5. Update README section 8 (your row in the Vision Pro table: ✅/🚧), commit, push `prakhar`. Then merge everyone's branches into main as they come in: `node --test eileen/pose.test.mjs`, `node src/heat.check.js` and `npx vite build --config vite.eileen.config.js` must pass in web/.
```

---

## Varnika: fire and smoke in the Vision Pro

```text
Project: FireDrill AR (repo root). Read AGENTS.md and README.md sections 7 and 8 ("Vision Pro drill hooks", "Today's demo: Vision Pro") first. Today's demo is the Vision Pro WebXR page web/eileen-xr.html (immersive-vr in Safari: an opaque textured room scan, not passthrough). Work on branch `varnika`; first run `git pull origin main`.

Your file: web/src/effects.js only. At the bottom there is a stub `createXRFire(roomRoot, camera)` that eileen-xr.js already calls. Fill it in using your own FireSystem / Smoke:
- roomRoot is the THREE.Group holding the scan (web/src/eileen-xr-room.js loads it). Its matrix maps scan coordinates → XR world.
- ignite(scanPos): scanPos is [x, y, z] in scan coordinates. Use the scan mesh under roomRoot as fuel (fire.setFuelMesh / surfacesFromMesh) and parent the fire to roomRoot, so it stays aligned with the room.
- update(dt, running): step the fire (spreads only when running) and smoke, and return the head's smoke depth (0–1). The head is the camera; use its world position converted into scan space for Smoke.
- worldFires(): fire.hotspots positions converted to XR world (roomRoot.localToWorld), as THREE.Vector3[]. They feed the DataFeel heat and the voice agent.
- reset(): remove the fire and smoke.

Look and performance:
- This is VR on an opaque scan, so the Quest passthrough tuning (premultiplied alpha) may look different; tune for it.
- Firelight should tint the scan. Smoke must visibly fill the ceiling and drop.
- No EffectComposer bloom in XR. Hold the frame rate in visionOS Safari: lower maxFlames and the particle counts as needed, behind one named constant.

Test: run the Eileen dev server (TASKS-visionpro.md), open https://localhost:5173/eileen-xr.html in Chrome with the Immersive Web Emulator, Start VR, then run firedrill.ignite([x, y, z]) in the console (pick a floor corner of the scan). Then try it on the Vision Pro.

Update README section 8 (your row in the Vision Pro table + your effects line), commit, push `varnika`, and tell Prakhar.
```

---

## Eileen: fire tool, route guide and exit signs

```text
Project: FireDrill AR (repo root). Read AGENTS.md, README.md sections 7 and 8 ("Vision Pro drill hooks", "Today's demo: Vision Pro") and web/eileen/README.md first. Today's demo is your Vision Pro page web/eileen-xr.html. Work on branch `eileen`; first run `git pull origin main`.

Already done for you (by Devaj; review it):
- eileen-xr.js now wires the drill: an annotation item { type: 'fire', position } ignites the fire, and each frame feeds fire → drill → HUD, DataFeel heat and the voice agent.
- pose-relay.js accepts type 'fire'. eileen-xr-annotations.js skips fire items.
- window.firedrill.ignite([x,y,z]) lets you test it from the console.

Your files: web/src/desktop.js, web/src/eileen-*.js, web/eileen/*.

1. Observer fire tool (desktop.js): a "Fire" tool/button next to Exit/Blocked/Route. Clicking the scan places a single { type: 'fire', position } (replace any previous one) and sends the annotations. Clear/undo remove it, which resets the drill on the headset.
2. Guide right after ignition: when a fire is placed, run autoRoute automatically from the live headset position to the nearest unblocked EXIT. While the fire exists, replan every 3 s as the user moves. Use your planner's existing failure messages.
3. Exit signs: the observer's EXIT marks are our exit-sign detection, so place them where the real signs are. In eileen-xr-annotations.js, once a fire exists:
   - the EXIT signs become large glowing green signs at ~2.1 m with a soft pulse;
   - the route becomes a chain of bright floor chevrons pointing to the exit (not thin lines);
   - BLOCKED is red with an X.
   Before ignition, keep them subtle.
4. Polish the observer page UI (desktop.js panel) so it reads well on the big screen: clear status, big buttons, consistent colours.
5. Run `node --test eileen/pose.test.mjs` and `npx vite build --config vite.eileen.config.js` in web/. Update web/eileen/README.md and your README section 8 row, commit, push `eileen`, and tell Prakhar.
```

---

## Emma: hands-free voice agent (+ pitch)

```text
Project: FireDrill AR (repo root). Read AGENTS.md and README.md sections 7 and 8 ("Vision Pro drill hooks", "Today's demo: Vision Pro") first. Today's demo is the Vision Pro WebXR page web/eileen-xr.html (Safari on visionOS). Work on branch `emma`; first run `git pull origin main`.

Your file: web/src/voice.js. At the bottom there is a stub `startAgent(getContext)` that eileen-xr.js calls right after VR starts. Fill it in:
- Hands-free: no button. Open the mic and keep listening, reusing your AssemblyAI streaming code (token from /py/token, 16 kHz PCM). Share the code with the existing start() panel; don't copy it.
- On each Turn with end_of_turn: POST /py/agent with JSON { transcript, ...getContext() }. getContext() returns { head, facing, fires, exits, blocked } as [x,y,z] arrays in XR world space. Speak the reply { reply } with speechSynthesis (en-US, rate ~1.05).
- Mute or ignore the mic while speaking, so the agent doesn't hear itself.
- Until Devaj's /py/agent is up, a 404 falls back to a canned "Stay low, head to the nearest exit."
- On ignition, the agent should speak first, unprompted. Export say(text) and ask Eileen to call it from eileen-xr.js when the fire starts.

Vision Pro Safari risks; test these first, on the device:
(a) Does getUserMedia prompt while in an immersive session? If not, the mic must be opened before Start VR: ask Eileen for a "Enable voice" step before VR.
(b) new AudioContext({ sampleRate: 16000 }): if Safari refuses it, resample from the native rate.
(c) speechSynthesis must work during the immersive session.
Report what you find in the README troubleshooting section.

Then: README section 8 row, commit, push `emma`, tell Prakhar. After that: pitch/ script for the Vision Pro flow (place the fire → exit guide → voice coach → wrists heat → oxygen and review), plus credits.
```

---

## Devaj: /agent endpoint, heat from the headset, wrists

```text
Project: FireDrill AR (repo root). Read AGENTS.md and README.md sections 7 and 8 ("Vision Pro drill hooks", "Today's demo: Vision Pro") first. Never read server/.env. Today's demo is the Vision Pro WebXR page web/eileen-xr.html. Work on branch `devaj`; first run `git pull origin main`.

Your files: server/, web/src/heat.js and unity/. You have Unity working, so you are the only one who builds and runs the Unity app; the rest of the team sends Unity requests to you.

1. POST /agent in server/app.py:
   - Body { transcript, head, facing, fires, exits, blocked } (XR world, metres, y up).
   - In Python, compute the facts: nearest exit not within 1.5 m of a blocked marker, its distance, and its direction relative to `facing` (ahead / left / right / behind, from the horizontal angle), plus the nearest fire's distance and side.
   - Send the transcript + facts to Claude via httpx (no new dependency): POST https://api.anthropic.com/v1/messages, model claude-haiku-5-5 for low latency, max_tokens 120, timeout 6 s, with ANTHROPIC_API_KEY from server/.env (add the key name to server/.env.example).
   - System prompt: a calm fire-safety coach; at most two short spoken sentences; use only the given facts for directions; always say to stay low if in smoke.
   - Return { reply }. With no key or on error, return a rule-based reply built from the same facts, so the demo never goes silent.
   - Add "anthropic_key": bool to /health.
   - Leave one small assert-based self-check for the direction math.
2. Heat: eileen-xr.js already sends heatFrom(head, quat, fire.worldFires()) to /py/ws/heat, with buzz = smokeDepth > 0.5 (sent every 250 ms while in smoke) and cool on escape. Check that dots.py turns a continuous buzz into short pulses, not a constant drone; adjust in dots.py if needed. Verify the stream end to end from the Vision Pro through Prakhar's Vite proxy.
3. Wear the Dots (left = Dots 1–2) and do the heat/buzz/cool run on the wrists. Set SWAP_SIDES if needed.
4. Windows: hotspot profile = Private; allow Python through the firewall (AGENTS.md).
5. README section 7 (/agent contract is listed; keep it in sync) and the section 8 row; commit and push `devaj`; tell Prakhar.
Stretch (after 1–3 only): find EXIT signs automatically in the scan textures (10_17_2026/textures/*.jpg) with Claude vision and map them to 3D via the OBJ UVs.
```
