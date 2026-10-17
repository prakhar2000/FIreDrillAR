# FireDrill AR — shared agent instructions

Committed and shared by the whole team, for any coding agent (Claude Code, Codex, Cursor, Copilot, …). Personal preferences go in your agent's local or global config (e.g. `CLAUDE.local.md`, gitignored), not here.

`README.md` is the team handbook: idea, roles, file ownership, shared contracts, timeline. Read it before making changes.

## Keep the docs current

With every commit or meaningful bit of progress, update the docs in the same commit:

- **`README.md`** — if you changed a shared contract (section 7: `room.json`, scenario functions, effects API, drill API, voice commands, haptics message), a setup step, the folder layout, ports/URLs, or a troubleshooting fix you discovered.
- **Progress** — tick off or note status in the build plan (section 8) for the owner's steps, e.g. `✅ done`, `🚧 in progress`, `⚠️ blocked: <why>`.
- Any other `.md` in the repo that the change makes stale.

Keep edits short and factual. Don't rewrite other people's sections beyond what your change affects.

## Team rules (from the handbook)

- Only edit files you own (section 5 / folder layout). Touching someone else's file? Say so in the commit message.
- Work on your own branch (`prakhar`, `varnika`, `eileen`, `devaj`, `emma`); Prakhar merges into `main`.
- Never commit `server/.env` or any API key.
- After 5:30 PM: no new features, fixes only.
- The team is mixed Mac and Windows. Code and commands must work on both; see the next section. Add any new cross-platform gotcha you hit to it.

## Mac vs Windows: full reference

**Mac:** Prakhar (hosts the Quest + Vite), Varnika, Emma · **Windows:** Eileen (desktop demo), Devaj (Python server + DataFeel)

When you give a shell command, give both forms if they differ (bash/zsh on Mac, PowerShell on Windows). Agents on Windows usually run PowerShell.

### Will break the demo if missed
1. **Devaj's server is unreachable.** Prakhar's Vite proxies `/py` to Devaj's laptop on port 8000. Windows marks a phone hotspot as *Public*, and its firewall then blocks inbound traffic. Fix: Settings → Network → hotspot → **Private**, and allow Python on Private networks. Test: `https://<prakhar-ip>:5173/py/health`.
2. **The AR clip is stuck on the Quest.** macOS can't browse the headset as a drive. Prakhar needs **Meta Quest Developer Hub** or `adb` (`brew install android-platform-tools`) installed *before* the Quest slot. Alternative: share it from the headset itself.
3. **DataFeel SDK.** It's Unity/.NET, so it most likely works best on Windows. Keep the driver and the server on Devaj's laptop. Read the El Jefe's serial port from config (`COM3` on Windows, `/dev/tty.usbmodem…` on Mac); never hard-code it. A Windows laptop may need a USB-serial driver. Only one process can hold the port, so close the SDK's demo app before running ours.
4. **Line endings.** `.gitattributes` forces LF. Don't remove it, and don't commit with a tool that rewrites it to CRLF.

### Git / files
- **Case-insensitive filesystems on both systems:** `Effects.js` and `effects.js` are the same file locally, so a bad import still works there and fails elsewhere. Use lowercase filenames and match case exactly in imports. To rename case only: `git mv effects.js tmp.js` then `git mv tmp.js Effects.js`.
- **Characters Windows doesn't allow in filenames:** `: * ? " < > |`, trailing spaces/dots, and the reserved names `CON`, `PRN`, `AUX`, `NUL`, `COM1`… Generated filenames (logs, room captures) must avoid them; `vite.config.js` already strips `:` from timestamps.
- **Long paths on Windows** (260 chars, deep `node_modules`): `git config --global core.longpaths true`.
- **Executable bits** aren't tracked from Windows. Avoid committing scripts that rely on `chmod +x`; write helpers in Node or Python instead of `.sh` / `.bat`.
- No symlinks. `.DS_Store`, `Thumbs.db`, `node_modules/`, `.venv/` and `.env` are gitignored.
- **WSL:** if a Windows user uses WSL, keep the repo inside the WSL filesystem, not `/mnt/c` (slow file watching). Simpler: don't use WSL; native PowerShell works.

### Node / npm / Vite
- Same Node major everywhere (20+). A different npm major rewrites `package-lock.json` and creates noisy diffs.
- **Per-OS binaries:** Rollup/esbuild ship per-OS packages, and a lockfile made on a Mac can miss the Windows one (`Cannot find module @rollup/rollup-win32-x64-msvc`). Fix: delete `node_modules`, `npm install`. Still broken → delete `package-lock.json` too, reinstall, commit it.
- **PowerShell blocks scripts** ("running scripts is disabled on this system" for `npm`, `npx` or `Activate.ps1`): `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **`package.json` scripts run in `cmd.exe` on Windows:** no `rm`/`cp`/`export`, no `VAR=x cmd`, no single-quoted args. Use Node one-liners or `cross-env` if ever needed.
- **Paths:** `path.join` / `path.resolve` in Node, `pathlib` in Python; never hard-code `/` or `\`. Fetch URLs always use `/`.
- **Env var for the proxy:** `PY_SERVER=http://<ip>:8000 npm run dev` (Mac) vs `$env:PY_SERVER="http://<ip>:8000"; npm run dev` (PowerShell).
- **HTTPS certificate:** `basicSsl` makes a self-signed cert per machine, so every browser/Quest clicks through once per host. The Quest has to accept again whenever the laptop's IP changes (e.g. rejoining the hotspot); this looks like a "broken" page, but it isn't.

### Python (server)
- `python3` on Mac, `py` on Windows. If `python` opens the Microsoft Store on Windows: Settings → Apps → Advanced app settings → App execution aliases → turn off the `python.exe` / `python3.exe` aliases.
- venv activate: `source .venv/bin/activate` (Mac) vs `.venv\Scripts\activate` (Windows).
- `requirements.txt` is hand-written, not `pip freeze`. A Mac freeze pins `uvloop`, which won't install on Windows.
- **`server/.env` encoding:** Windows Notepad or PowerShell 5's `>` can save UTF-16 or add a BOM, and then python-dotenv silently misses the first key. Save it as UTF-8 (VS Code: bottom bar → encoding). `/py/health` shows `"assemblyai_key": false` when this happens.

### Network
- Everyone on **one phone hotspot**, Windows profile set to **Private**. Use IPs, not hostnames. Turn off VPNs/Tailscale on laptops that need to reach each other.
- Firewall prompts: Windows asks about Node/Python, so click **Allow** on Private. macOS asks "accept incoming connections?" for node/python, so click **Allow**. Only Prakhar (Vite, 5173) and Devaj (Python, 8000) need inbound access.
- IP: `ipconfig getifaddr en0` (Mac), `ipconfig` → IPv4 (Windows).

### Quest / WebXR
- WebXR only works on HTTPS pages; always open `https://<ip>:5173`, and call the server through `/py/...`, never `http://…:8000` directly.
- **USB fallback** if the hotspot fails: turn on Quest developer mode, plug in, accept "Allow USB debugging" in the headset, run `adb reverse tcp:5173 tcp:5173`, then open `https://localhost:5173` in the Quest. The same cable lets desktop Chrome debug the Quest browser at `chrome://inspect`. Mac needs no driver; a Windows laptop needs Meta's Quest ADB driver.
- **Quest Link / Air Link are Windows-only, and we don't use them** (we run in the Quest browser). Ignore tutorials that assume them.
- **Casting:** `meta.com/casting` in Chrome on either system, logged into the Quest's Meta account.
- **Immersive Web Emulator** (Chrome extension) works the same on both, so use it for everything that doesn't need the real headset.

### Browser code (all `web/src`)
- **Keyboard:** use `e.code` (`KeyW`, `KeyC`, `Digit1`) not `e.key`, so non-US layouts work. Avoid Ctrl/Cmd shortcuts (Cmd on Mac, Ctrl on Windows; Ctrl+click is right-click on Mac). Esc exits pointer lock on both.
- **Mic:** macOS needs Chrome allowed in System Settings → Privacy & Security → Microphone, then a Chrome restart. Windows: Settings → Privacy → Microphone → allow desktop apps. Use `new AudioContext({ sampleRate: 16000 })`; don't assume the hardware rate (often 48 kHz).
- **Audio** needs one user click/tap before playing, on both systems.
- **Fonts on canvas sprites:** name a font both have (`bold 64px Arial`); fallbacks differ per system.
- **Text parsing:** if you read text files, split on `/\r?\n/`.

### Demo laptops (day-of)
- **Eileen's Windows laptop runs the desktop demo:** set Chrome to **High performance** GPU (Settings → Display → Graphics), keep it plugged in, set power mode to Best performance, and check `chrome://gpu`.
- **Pause Windows Update** (Settings → Windows Update → Pause) on Eileen's and Devaj's laptops so nothing reboots mid-demo.
- Turn off sleep and notifications on every demo laptop (Windows: Focus / Do not disturb; Mac: Focus, and turn off Low Power Mode).
- Macs need a USB-C → HDMI adapter for the big screen; check which laptop goes on screen and that its adapter is in the bag.
