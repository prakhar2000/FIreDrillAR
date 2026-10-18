import test from 'node:test';
import assert from 'node:assert/strict';
import { validEffectsState, smokeBottom } from '../src/eileen-effects-state.js';
import * as THREE from 'three';
import { chooseFirePositions } from '../src/eileen-auto-fire.js';
import { exitDefaults, readDefaultExits, saveDefaultExits } from '../src/eileen-exit-defaults.js';

const state = { version: 1, roomId: '10_17_2026', running: true, elapsed: 10,
  floorY: -1, ceilingY: 2, center: [1, 2], size: 8, fires: [[0, -1, 0]] };

test('effects snapshots reject malformed geometry, timing and oversized fire lists', () => {
  assert.equal(validEffectsState(state), true);
  for (const patch of [{ elapsed: -1 }, { elapsed: Infinity }, { running: 'true' },
    { floorY: 3 }, { size: 1000 }, { center: [0, NaN] }, { fires: [[0, 0]] },
    { fires: [[Infinity, 0, 0]] }, { fires: Array(21).fill([0, 0, 0]) }, { roomId: 'other' }]) {
    assert.equal(Boolean(validEffectsState({ ...state, ...patch })), false);
  }
  assert.equal(validEffectsState({ ...state, running: false, elapsed: 0, fires: [] }), true);
});

test('smoke level follows common elapsed time and stays above the floor', () => {
  assert.ok(smokeBottom(state, 30) < smokeBottom(state, 10));
  assert.equal(smokeBottom(state, 86400), -0.55);
  assert.equal(smokeBottom(state, 0), 1.95);
});

test('automatic fire placement requires observed floor and avoids start, exits and furniture', () => {
  const surface = new THREE.Group();
  const bounds = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
  const options = { surface, bounds, floorY: 0, start: [-2.5, 0, -2.5], exits: [[2.5, 0, -2.5]] };
  assert.deepEqual(chooseFirePositions(options), []);
  const geometry = new THREE.BoxGeometry(10, 0.1, 10);
  const material = new THREE.MeshBasicMaterial();
  const floor = new THREE.Mesh(geometry, material); floor.position.y = -0.05; surface.add(floor);
  const positions = chooseFirePositions(options);
  assert.equal(positions.length, 6);
  for (const p of positions) for (const q of [options.start, ...options.exits]) {
    assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) >= 1.8);
  }
  const furniture = new THREE.Mesh(geometry, material); furniture.position.y = 0.8; surface.add(furniture);
  assert.deepEqual(chooseFirePositions(options), []);
  geometry.dispose(); material.dispose();
});

test('default exits survive reload, stay room-specific, and clear without restoring old marks', () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const items = [{ type: 'exit', position: [2, 0, 3] }, { type: 'waypoint', position: [1, 0, 2] }];
  saveDefaultExits(storage, '10_17_2026', items);
  assert.deepEqual(readDefaultExits(storage, '10_17_2026'), [{ ...items[0], source: 'manual' }]);
  assert.deepEqual(readDefaultExits(storage, 'sample-room'), []);
  assert.throws(() => exitDefaults({ version: 1, roomId: 'sample-room', items }, '10_17_2026'));
  assert.throws(() => exitDefaults({ version: 1, roomId: '10_17_2026',
    items: [{ type: 'exit', position: [null, 0, 1] }] }, '10_17_2026'));
  saveDefaultExits(storage, '10_17_2026', []);
  assert.deepEqual(readDefaultExits(storage, '10_17_2026'), []);
});
