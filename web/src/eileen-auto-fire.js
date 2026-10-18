import * as THREE from 'three';

// Deterministic demo placement on observed floor, never on a scan hole.
export function chooseFirePositions({ surface, bounds, floorY, start, exits = [], scale = 1 }) {
  const ray = new THREE.Raycaster();
  const normal = new THREE.Vector3();
  const points = [];
  surface.updateWorldMatrix(true, true);
  for (const z of [0.25, 0.75, 0.4, 0.6, 0.5, 0.15, 0.85]) {
    for (const x of [0.25, 0.75, 0.4, 0.6, 0.5, 0.15, 0.85]) {
      ray.set(new THREE.Vector3(THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, x),
        bounds.max.y + 1, THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, z)), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(surface, true).filter((h) => h.object.isMesh);
      if (hits.some((h) => h.point.y > floorY + 0.22 * scale && h.point.y < floorY + 1.9 * scale)) continue;
      const floor = hits.find((h) => Math.abs(h.point.y - floorY) < 0.3 * scale && h.face
        && Math.abs(normal.copy(h.face.normal).transformDirection(h.object.matrixWorld).y) > 0.75);
      if (!floor) continue;
      const p = floor.point.toArray();
      const excluded = [start, ...exits, ...points];
      if (excluded.some((q) => Math.hypot(p[0] - q[0], p[2] - q[2]) < 1.8 * scale)) continue;
      points.push(p);
      if (points.length === 6) return points;
    }
  }
  return points;
}
