// Haptics link: browser → Devaj's server (/py/ws/heat) → DataFeel Dots.
// Message contract (README section 7): { left: 0..1, right: 0..1, buzz: bool, cool: bool }
//
// Per frame, the app loop calls:
//   send({ ...heatFrom(headPos, headQuat, firePositions), buzz, cool });
// Positions/quaternions are anything with x/y/z(/w): three.js Vector3/Quaternion work as-is.

const NEAR_M = 0.5;      // proximity 1 at this distance from the nearest fire
const FAR_M = 4.5;       // proximity 0 at this distance
const SEND_MS = 250;     // at most 4 messages per second
const RETRY_MS = 3000;

let ws = null;
let latest = null;
let lastSent = 0;
let timer = null;

export function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/py/ws/heat`);
  ws.onopen = () => latest && flush();
  ws.onclose = () => setTimeout(connect, RETRY_MS);
  ws.onerror = () => ws.close();
}

// Keeps only the newest message and sends it on the next 250 ms slot, so a final
// { cool: true } is never dropped by the rate limit.
export function send(msg) {
  latest = msg;
  if (!timer) timer = setTimeout(flush, Math.max(0, SEND_MS - (performance.now() - lastSent)));
}

function flush() {
  timer = null;
  if (!latest || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(latest));
  lastSent = performance.now();
  latest = null;
}

export function heatFrom(head, quat, fires) {
  let nearest = null;
  let best = Infinity;
  for (const f of fires) {
    // ponytail: horizontal distance only, so crouching doesn't change which wrist is warm
    const d = Math.hypot(f.x - head.x, f.z - head.z);
    if (d < best) { best = d; nearest = f; }
  }
  if (!nearest) return { left: 0, right: 0 };

  const proximity = Math.min(1, Math.max(0, (FAR_M - best) / (FAR_M - NEAR_M)));

  // Head's right vector = quat applied to (1, 0, 0), flattened to the floor plane.
  const { x, y, z, w } = quat;
  const rx = 1 - 2 * (y * y + z * z);
  const rz = 2 * (x * z - w * y);
  const rLen = Math.hypot(rx, rz) || 1;
  const side = best > 1e-6
    ? ((nearest.x - head.x) * rx + (nearest.z - head.z) * rz) / (best * rLen)
    : 0;

  return {
    left: proximity * (0.5 - 0.5 * side),
    right: proximity * (0.5 + 0.5 * side),
  };
}
