# Eileen's Vision Pro pose demo

Status: desktop scan viewer, dual cameras, annotations, draft route planning,
Vision Pro model viewer, WebSocket pose relay and calibration implemented.
Live Vision Pro pose reception was observed during the demo. Browser tests verified
camera updates, annotation transfer/clear, model loading and coordinate conversion.
Physical scale, alignment accuracy and sustained headset stability still require
on-device verification. Shared team files are unchanged.

Progress:
- In progress: single-fire annotation lifecycle and automatic headset guidance; preserved checkpoint before integrating main.
- Done: desktop sample/scan view, keyboard simulation and headset-following camera.
- Done: paired pose transport, calibration, live scan annotations and draft routes.
- Done: automated relay/transform tests and both-entry production build.
- Done: team fire/smoke rendering, opt-in audio and paired effect snapshots.
- Done: up to six automatic fire patches and browser-persisted default exits with JSON import.
- Done: fire-avoiding routes from the current blue dot/headset; automatic planning after scan exit restore/import.
- Done: relaxed desktop route preview with reduced fire clearance and no extra obstacle padding.
- Pending: physical room validation; native Vision Pro scanning is not implemented.

## Start

Use Node 22.12+ or 24 LTS (the installed Vite version requires a supported modern
Node runtime). From `web`, install the locked dependencies and start the server:

```text
npm ci
npm run dev -- --config vite.eileen.config.js --host 0.0.0.0
```

On Windows PowerShell, use `npm.cmd` if script execution blocks `npm`.
Only one server can use port 5173. Stop the previous preview first.

- Computer: `https://localhost:5173/`.
- Vision Pro Safari: `https://<computer-wifi-ip>:5173/eileen-xr.html`.
- Both devices must reach the same computer over the network and trust its HTTPS
  certificate. IP changes require a new headset URL and possibly certificate consent.
- Find the address with `ipconfig` on Windows or `ipconfig getifaddr en0` on macOS.
- `https://<computer-wifi-ip>:5173/__eileen/relay` returns JSON with `ok: true`.
  A normal Vite config or a static preview does not provide the relay.
  Diagnostics also report publishers, observers and accepted pose counts per pairing
  code, plus the age of the last pose. No headset positions are included in this URL.

## Connect and align

The computer defaults to two side-by-side views: an editable room overview on the
left and a headset-following camera on the right. The right view waits for a calibrated
live pose; interrupted tracking is labelled paused. Both views: on/off toggles the
split layout. Angled view / Top view affect only the overview. The right view hides
the blue head marker and uses a fixed 75-degree field of view: it reconstructs the
scene from pose data, not a pixel-exact headset cast or passthrough feed.

1. Computer: load the scan and choose **Set start on floor**, then click a clear
   floor location corresponding to the user's physical starting position.
2. Set **Facing** to the direction the user will face in the model: 0 is -Z,
   90 is +X. Set model units per meter using a measured real-world distance;
   the imported OBJ's scale has not been verified. One is the initial estimate.
3. Use the same pairing code on both pages (default `firedrill`). Computer:
   **Connect headset**. Headset: **Start VR**, then allow the immersive session.
4. When the computer reports head poses received, stand at the chosen start,
   look horizontally in the agreed direction, and click **Align headset at start**.
5. Test a small translation, head turn and crouch. The observer camera remains
   fixed; its blue marker, arrow and head sphere update from the incoming pose.
   Connection status should show `Headsets: 1`, at least `Observers: 1`, and an
   increasing `Received poses` count. Zero headsets means no sender joined that code;
   a connected headset with no received poses means XR tracking has not started.
6. Exit via the Digital Crown or **Stop VR**. Re-entering VR, reference-space resets,
   tracking loss, changing rooms or calibration settings require alignment again.
   Network interruptions retain calibration, but resume it only when fresh poses
   carry the same headset session ID. Old positions remain marked stale after two
   seconds. A different session ID requires alignment again.
   **Reset simulation** disconnects the observer and restores keyboard control.

The headset loads the same textured OBJ as the computer, showing a miniature preview
before alignment. Wait for the room-ready message, enter VR, select the scanned room
on the computer and click Align. The observer sends its calibration to the paired
headset, which applies the inverse transform to place the room in XR coordinates.
Head tracking continues in raw XR coordinates. Scan scale is still manually verified.
After a tracking reset, align again. Alignment received during model loading is
applied when loading completes, provided the headset session is unchanged.
This is immersive VR, not passthrough; start with stationary
tests in clear space. Scan EXIT, BLOCKED and route markers now synchronize to the
headset on edits, including undo and clear. A snapshot is also sent on the observer's
one-second connection heartbeat so late-joining headsets receive current marks.
Markers share the room's calibration transform and use depth testing. Sample-room
annotations are not displayed over the scan. Use one editing observer per pairing
code; multiple observers can overwrite each other's snapshots. Marked exits are
automatically saved in this browser for each room and restored before automatic fires
are placed. Use **Import default exits** to restore exits from an earlier annotation
export; this replaces exits and repositions demo fires away from them. It does not
import routes or blocked markers. **Undo mark** and **Clear marks** update the saved
exits too. Storage is specific to the browser and URL origin (host and port); use
export/import when changing computers, browsers or URLs. Other marks remain in-memory.

## Fire and smoke demo

The first scan display automatically places up to six fixed fires on observed floor
and starts smoke. It excludes candidate points near the selected start, marked exits
and other fires, and rejects scan holes or overhead furniture near floor level.
This is demo placement, not a real-world safety assessment. **Auto fire & smoke**
retries placement or restarts existing fires without duplicating them. Clear fires
and Stop smoke remain effective; switching views does not reapply the initial preset.
Sound still requires **Enable sound**. If no suitable floor is found, set the start
on clear floor to correct the floor estimate or place fires manually.

1. In the left overview, choose **Place fire**, then click a room surface. Press Esc
   when finished. Up to 20 fixed fire patches are supported per room.
2. Choose **Start smoke**. **Stop smoke** clears smoke and stops audio while retaining
   visible fire patches; **Clear fires** removes the patches too.
3. Click **Enable sound** on each device where audio is wanted. On the headset,
   enable sound before entering VR; audio stays local to that device.
4. Connect both pages with the same pairing code and align the scan as usual.
   Fire positions and the smoke timeline sync on edits and every observer heartbeat.
   A headset joining later receives the current snapshot. Sample-room effects are
   desktop-only and clear the headset's scan effects.
5. Auto route uses a relaxed demo profile: a radius of 0.8 model units around fire sources (scaled by the
   alignment's model units/metre when available). Placing or clearing fire invalidates
   generated routes. Floor tolerance is 0.30 model units; extra one-cell obstacle
   padding is removed. Actual obstacles and missing floor remain blocked. Fire cells
   include a half-cell diagonal margin to keep route segments outside the radius.
   Replan explicitly; reduced clearance is for preview, not verified safe egress.

The integration reuses the team's renderer through a versioned snapshot documented
in `vendor/README.md`. Fire spread/burn-out is disabled so clients share fixed hazard
positions. Smoke height follows the observer's elapsed time; particles and flicker
are decorative and can differ. No desktop bloom compositor is used in split view.
Effects and non-exit marks reset on refresh; saved exits remain. Voice, Python
backend and DataFeel integration are not enabled by this effects adapter.

## Interfaces and ownership

- `../vite.eileen.config.js`: extends the shared Vite config without modifying it.
- `pose-relay.js`: relays validated custom events over Vite's existing secure
  WebSocket on port 5173. No Python dependency, additional port or new npm package.
- `../eileen-xr.html`, `../src/eileen-xr.js`: user-initiated `immersive-vr` session
  requiring `local-floor`; valid viewer poses sent at up to 20 Hz.
- `../src/eileen-pose-channel.js`: join/heartbeat/disconnect lifecycle.
- `../src/eileen-pose-alignment.js`: yaw + translation + scale transform.
- `../src/eileen-xr-room.js`: textured scan loading and inverse room transform.
- `../src/eileen-xr-annotations.js`: live labels, markers and route arrows.
- `../src/eileen-effects.js`: team effect adapter and opt-in local audio.
- `../src/eileen-effects-state.js`: validated effect snapshot contract and smoke timing.
- `../src/desktop.js`: observer and receiver. Its existing `updateHeadPose()` still
  takes room-space poses; this connection transforms incoming XR poses first.

Custom WebSocket events: `eileen:join`, `eileen:joined`, `eileen:pose`,
`eileen:tracking`, `eileen:error`, `eileen:leave`, `eileen:alignment`, `eileen:annotations`.
`eileen:effects` carries version, roomId, running, elapsed, floorY, ceilingY, center,
size and up to 20 fire positions, only from an observer to its paired headset.
Annotation snapshots contain roomId and up to 500 items (type, position, source),
validated and forwarded only from an observer to its paired headset.
Calibration messages
contain sessionId, origin, target, rotation and scale; only observers in the same
pairing room can send them to the current publisher session. These are Vite custom events, not
a `/ws/pose` endpoint and not the team's `/py/ws/heat` protocol.

```json
{
  "sessionId": "unique-session-id",
  "seq": 42,
  "position": [0.2, 1.6, -0.3],
  "quaternion": [0, 0, 0, 1]
}
```

Position: meters in the sender's `local-floor` space; quaternion: `[x,y,z,w]`.
The relay permits one publisher per pairing code, sends only to matching observers,
checks finite values and quaternion length, rejects duplicate sequence numbers in
the same session, rate limits poses and skips congested sockets. It does not replay
old poses or save them to disk. Pairing codes separate local demos; they are not
account authentication. Use this development server on the team's network.

## Validation and limitations

Auto route uses the latest calibrated headset position when live tracking is active.
The button shows Planning while computing and a highlighted result explains success
or failure (missing exit, unavailable tracking, unclear floor or disconnected path).
Missing calibration or poses older than two seconds block planning. In simulation it
uses the current blue dot, including keyboard movement. Restoring saved scan exits
or importing exits automatically plans after placing fires. Mark known exits first and click Auto route to generate a
geometry-based route; click again after moving to replan. This is a snapshot route,
not continuous navigation. Failed replans remove the previous generated route.
Fire-covered endpoints and disconnected paths produce an explicit failure instead
of a path through hazards. Existing scan annotation sync sends the draft to the
headset. The model cannot determine whether an exit is actually safe or available.

The headset sign reports tracking interruptions and whether poses have been sent.
An observer and publisher can both be connected while no viewer pose is available;
alignment requires fresh poses, not just a WebSocket connection.
Fixed relay session-ID validation to accept the headset's 36-character UUIDs;
the 32-character pairing-code limit does not apply to session IDs. Regression
tests use real UUIDs to verify forwarding.

Run relay and coordinate-transform regression tests from `web`:
`node --test eileen/pose.test.mjs eileen/effects.test.mjs eileen/routes.test.mjs`.

Build both entries: `npm run build -- --config vite.eileen.config.js`.
Static builds show connection unavailable: this relay requires the development server.
The original scan folder `../../10_17_2026/` is required when building; assets are
bundled by Vite. Keep it with the branch when handing off.

Scan scale, floor height and physical alignment need manual verification. This demo
has no shared anchors, automatic relocalization, obstacle collision or certified
escape-route checking. Automatic routes are geometry-based drafts to manually
marked exits; annotations remain separate from the team's main scenario data.
