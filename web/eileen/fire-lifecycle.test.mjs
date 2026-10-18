import test from 'node:test';
import assert from 'node:assert/strict';
import { drill } from '../src/drill.js';
import { createFireLifecycle, placeDrillFire, undoAnnotation, hasGuidancePose } from '../src/eileen-fire-lifecycle.js';

test('one fire replaces its predecessor; undo restores it without disturbing ordinary marks', () => {
  const items = [{ type: 'exit', position: [5, 0, 0] }];
  assert.equal(placeDrillFire(items, [0, 0, 0]), true);
  assert.equal(placeDrillFire(items, [0, 0, 0]), false);
  items.push({ type: 'blocked', position: [2, 0, 0] });
  placeDrillFire(items, [1, 0, 0]);
  assert.equal(items.filter((i) => i.type === 'fire').length, 1);
  undoAnnotation(items);
  assert.deepEqual(items.map((i) => i.type), ['exit', 'fire', 'blocked']);
  assert.deepEqual(items[1].position, [0, 0, 0]);
  undoAnnotation(items); undoAnnotation(items);
  assert.deepEqual(items.map((i) => i.type), ['exit']);
  assert.equal(placeDrillFire(items, [NaN, 0, 0]), false);
});

test('repeated snapshots preserve the real drill timer; removal freezes it and replacement restarts once', () => {
  let ignitions = 0, stops = 0;
  const lifecycle = createFireLifecycle({ ignite() { ignitions++; drill.start(); }, stop(reason) { stops++; drill.stop(reason); } });
  const fire = { type: 'fire', position: [1, 0, 2] };
  lifecycle.apply([fire]);
  drill.update(5, {});
  lifecycle.apply(structuredClone([fire, { type: 'exit', position: [3, 0, 2] }]));
  assert.equal(drill.stats().time, 5); assert.equal(ignitions, 1);
  lifecycle.apply([]);
  drill.update(2, {});
  assert.equal(drill.stats().time, 5); assert.equal(stops, 1);
  lifecycle.apply([{ ...fire, position: [2, 0, 2] }]);
  assert.equal(drill.stats().time, 0); assert.equal(ignitions, 2);
  lifecycle.apply([{ ...fire, position: [3, 0, 2] }]);
  assert.equal(ignitions, 3); assert.equal(stops, 2);
  lifecycle.stop('session-ended'); lifecycle.stop('session-ended');
  assert.equal(stops, 3);
});

test('automatic guidance requires fresh matching calibration and never substitutes simulation', () => {
  const state = { mode: 'live', alignment: { sessionId: 'a' }, rawPose: { sessionId: 'a' }, lastPose: 100, rawPoseAt: 100 };
  assert.equal(hasGuidancePose(state, 200), true);
  for (const patch of [{ mode: 'simulation' }, { alignment: null }, { rawPose: null },
    { rawPose: { sessionId: 'b' } }, { lastPose: null }]) assert.equal(hasGuidancePose({ ...state, ...patch }, 200), false);
  assert.equal(hasGuidancePose(state, 2200), false);
});
