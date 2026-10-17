import test from 'node:test';
import assert from 'node:assert/strict';
import { validEffectsState, smokeBottom } from '../src/eileen-effects-state.js';

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
