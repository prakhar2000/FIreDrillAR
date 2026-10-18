import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planRoomRoute } from '../src/eileen-route-planner.js';

function room() {
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), new THREE.MeshBasicMaterial());
  surface.rotation.x = -Math.PI / 2;
  return { surface, bounds: new THREE.Box3(new THREE.Vector3(-6, 0, -5), new THREE.Vector3(6, 3, 5)),
    floorY: 0, start: [-4, 0, 0], exits: [[4, 0, 0]], hazards: [[0, 0, 0]], hazardRadius: 1.5 };
}

test('relaxed preview opens tighter fire gaps while retaining solid barriers and missing floor', () => {
  const options = room();
  try {
    const hazards = [-4.8, -2.4, 0, 2.4, 4.8].map((z) => [0, 0, z]);
    assert.ok(planRoomRoute({ ...options, hazards }).error);
    const relaxed = { ...options, hazards, relaxed: true, hazardRadius: 0.8 };
    const route = planRoomRoute(relaxed);
    assert.ok(route.points, route.error);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i];
      for (let t = 0; t <= 1; t += 0.01) for (const h of hazards) {
        assert.ok(Math.hypot(a[0] + (b[0] - a[0]) * t - h[0], a[2] + (b[2] - a[2]) * t - h[2]) >= 0.8);
      }
    }
    assert.ok(planRoomRoute({ ...relaxed, surface: new THREE.Group() }).error);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 10), new THREE.MeshBasicMaterial());
    wall.position.y = 1;
    const group = new THREE.Group(); group.add(options.surface, wall);
    assert.ok(planRoomRoute({ ...relaxed, surface: group }).error);
    wall.geometry.dispose(); wall.material.dispose();
  } finally { options.surface.geometry.dispose(); options.surface.material.dispose(); }
});

test('route detours around fire and every drawn segment stays outside its exclusion radius', () => {
  const options = room();
  try {
    const result = planRoomRoute(options);
    assert.ok(result.points, result.error);
    assert.ok(result.points.some((p) => Math.abs(p[2]) > 1.5));
    for (let i = 1; i < result.points.length; i++) {
      const a = result.points[i - 1], b = result.points[i];
      for (let t = 0; t <= 1; t += 0.01) {
        assert.ok(Math.hypot(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t) >= 1.5);
      }
    }
  } finally { options.surface.geometry.dispose(); options.surface.material.dispose(); }
});

test('planner rejects a fire barrier and fire-covered endpoints instead of drawing through hazards', () => {
  const options = room();
  try {
    assert.match(planRoomRoute({ ...options, start: [0, 0, 0] }).error, /Current position/);
    assert.match(planRoomRoute({ ...options, exits: [[0, 0, 0]] }).error, /All marked exits/);
    const blocked = planRoomRoute({ ...options, hazards: [-4, -2, 0, 2, 4].map((z) => [0, 0, z]) });
    assert.match(blocked.error, /No route to EXIT/);
    assert.equal(blocked.points, undefined);
    const missingFloor = planRoomRoute({ ...options, surface: new THREE.Group() });
    assert.equal(missingFloor.points, undefined);
  } finally { options.surface.geometry.dispose(); options.surface.material.dispose(); }
});
