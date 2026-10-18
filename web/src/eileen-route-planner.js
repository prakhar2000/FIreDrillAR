import * as THREE from 'three';

/** Geometry-only draft planning; requires user-supplied exit positions.
 * Missing floor and geometry in the standing-height band are impassable.
 * Four-neighbor search never cuts diagonally between occupied cells.
 */
export function planRoomRoute({ surface, bounds, floorY, start, exits, blocked = [], hazards = [], hazardRadius = 1.5, relaxed = false }) {
  if (!exits.length) return { error: 'Mark at least one known exit first.' };
  const nearFire = (p) => hazards.some((h) => Math.hypot(p[0] - h[0], p[2] - h[2]) < hazardRadius + (relaxed ? 0.15 : 0.3));
  if (nearFire(start)) return { error: 'Current position is inside a fire exclusion zone. Choose a clear simulation start or adjust demo fire placement.' };
  const availableExits = exits.filter((p) => !nearFire(p));
  if (!availableExits.length) return { error: 'All marked exits are inside fire exclusion zones. No route can be generated to these exits.' };
  const step = 0.2;
  const floorTolerance = relaxed ? 0.3 : 0.18;
  const width = Math.ceil((bounds.max.x - bounds.min.x) / step);
  const depth = Math.ceil((bounds.max.z - bounds.min.z) / step);
  const total = width * depth;
  if (!total || total > 40000) return { error: 'Room scale is too large for this demo. Verify model units first.' };
  const floor = new Uint8Array(total), obstacles = new Uint8Array(total);
  const minX = bounds.min.x, minZ = bounds.min.z;
  const point = (id) => new THREE.Vector3(minX + (id % width + 0.5) * step,
    floorY + 0.02, minZ + (Math.floor(id / width) + 0.5) * step);
  const cell = (p) => {
    const x = Math.floor((p[0] - minX) / step), z = Math.floor((p[2] - minZ) / step);
    return x < 0 || z < 0 || x >= width || z >= depth ? -1 : z * width + x;
  };
  const edgeDistanceSq = (x, z, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  surface.updateWorldMatrix(true, true);
  surface.traverse((object) => {
    if (!object.isMesh) return;
    const attr = object.geometry.attributes.position, index = object.geometry.index;
    const count = index ? index.count : attr.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(attr, index ? index.getX(i) : i).applyMatrix4(object.matrixWorld);
      b.fromBufferAttribute(attr, index ? index.getX(i + 1) : i + 1).applyMatrix4(object.matrixWorld);
      c.fromBufferAttribute(attr, index ? index.getX(i + 2) : i + 2).applyMatrix4(object.matrixWorld);
      const low = Math.min(a.y, b.y, c.y), high = Math.max(a.y, b.y, c.y);
      const body = high > floorY + 0.22 && low < floorY + 1.9;
      normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
      const ground = Math.abs(normal.y) > (relaxed ? 0.65 : 0.75)
        && low <= floorY + floorTolerance && high >= floorY - floorTolerance;
      if (!ground && !body) continue;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - minX) / step));
      const x1 = Math.min(width - 1, Math.floor((Math.max(a.x, b.x, c.x) - minX) / step));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - minZ) / step));
      const z1 = Math.min(depth - 1, Math.floor((Math.max(a.z, b.z, c.z) - minZ) / step));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const px = minX + (x + 0.5) * step, pz = minZ + (z + 0.5) * step;
        const u = denominator ? ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / denominator : -1;
        const v = denominator ? ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / denominator : -1;
        const inside = u >= -1e-6 && v >= -1e-6 && u + v <= 1.000001;
        const id = z * width + x;
        const y = u * a.y + v * b.y + (1 - u - v) * c.y;
        if (ground && inside && Math.abs(y - floorY) <= floorTolerance) floor[id] = 1;
        if (body && !(relaxed && ground && high <= floorY + floorTolerance) && (inside || Math.min(edgeDistanceSq(px, pz, a, b), edgeDistanceSq(px, pz, b, c),
          edgeDistanceSq(px, pz, c, a)) <= step * step / 2)) obstacles[id] = 1;
      }
    }
  });
  for (let id = 0; id < total; id++) {
    const p = point(id);
    if (blocked.some((b) => Math.hypot(p.x - b[0], p.z - b[2]) < 0.6)) obstacles[id] = 1;
    // Cover the whole cell so drawn segments cannot clip a fire's exclusion circle.
    if (hazards.some((h) => Math.hypot(p.x - h[0], p.z - h[2]) < hazardRadius + (relaxed ? step / Math.SQRT2 : 0))) obstacles[id] = 1;
  }
  // Relaxed preview removes extra padding, but never invents floor or removes obstacles.
  const padding = relaxed ? 0 : 1;
  const walkable = new Uint8Array(total);
  for (let z = 1; z < depth - 1; z++) for (let x = 1; x < width - 1; x++) {
    let clear = true;
    for (let dz = -padding; dz <= padding; dz++) for (let dx = -padding; dx <= padding; dx++) {
      const id = (z + dz) * width + x + dx;
      if (!floor[id] || obstacles[id]) clear = false;
    }
    walkable[z * width + x] = Number(clear);
  }
  const from = cell(start);
  if (from < 0 || !walkable[from]) return { error: 'Start is not on clear scanned floor. Use Set start on floor on a clear area; verify floor height.' };
  const targets = new Set(availableExits.map(cell).filter((id) => id >= 0 && walkable[id]));
  if (!targets.size) return { error: 'Marked exits are outside clear floor. Mark the approach area just inside a known exit.' };
  const previous = new Int32Array(total).fill(-1), queue = new Int32Array(total);
  previous[from] = from;
  queue[0] = from;
  let head = 0, tail = 1, found = -1;
  while (head < tail) {
    const id = queue[head++];
    if (targets.has(id)) { found = id; break; }
    const x = id % width, z = Math.floor(id / width);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, next = nz * width + nx;
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth || !walkable[next] || previous[next] !== -1) continue;
      previous[next] = id; queue[tail++] = next;
    }
  }
  if (found < 0) return { error: 'No route to EXIT avoids all fire zones, obstacles and scan gaps. Check exit placement or adjust the demo fires; no route is drawn through hazards.' };
  const cells = [found];
  while (cells[cells.length - 1] !== from) cells.push(previous[cells[cells.length - 1]]);
  cells.reverse();
  if (cells.length < 2) return { error: 'Start is already at the marked exit. Choose a different start to draw a route.' };
  const turns = cells.filter((id, i) => i === 0 || i === cells.length - 1 || id - cells[i - 1] !== cells[i + 1] - id);
  return { points: turns.map((id) => point(id).toArray()), cells: cells.length, step };
}
