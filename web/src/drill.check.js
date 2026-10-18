// Run: node web/src/drill.check.js   (no output = pass)
import assert from 'node:assert/strict';
import { drill, OXYGEN_EMPTY_SECONDS, OXYGEN_RECOVER_SECONDS } from './drill.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const head = (y, x = 0, z = 0) => ({ x, y, z });

drill.start();
let s = drill.update(OXYGEN_EMPTY_SECONDS, { smokeDepth: 1, head: head(1.6), exits: [] });
assert.ok(near(s.oxygen, 0), s.oxygen);
assert.equal(s.timedOut, true);
assert.equal(s.escaped, false);

drill.start();
s = drill.update(10, { smokeDepth: 0.5, head: head(1.6), exits: [] });
assert.ok(near(s.oxygen, 1 - (10 * 0.5) / OXYGEN_EMPTY_SECONDS), s.oxygen);
assert.equal(s.timedOut, false);

drill.start();
drill.update(OXYGEN_EMPTY_SECONDS, { smokeDepth: 1, head: head(1.6), exits: [] });
s = drill.update(OXYGEN_RECOVER_SECONDS / 2, { smokeDepth: 0, head: head(1.6), exits: [] });
assert.ok(near(s.oxygen, 0.5), s.oxygen);

drill.start();
s = drill.update(1, { smokeDepth: 0, head: head(1.6, 0, 0), exits: [head(0, 0, 0.5)] });
assert.equal(s.escaped, true);
s = drill.update(1, { smokeDepth: 0, head: head(1.6, 0, 0), exits: [head(9, 0, 0.4)] });
assert.equal(s.escaped, true);
s = drill.update(1, { smokeDepth: 0, head: head(1.6, 0, 0), exits: [head(0, 0, 1.5)] });
assert.equal(s.escaped, false);

drill.start();
drill.update(181, { smokeDepth: 0, head: head(1.6), exits: [] });
s = drill.update(0, { smokeDepth: 0, head: head(1.6), exits: [] });
assert.equal(s.timedOut, true);

drill.start();
drill.update(10, { smokeDepth: 0, head: head(1.0), exits: [] });
drill.update(10, { smokeDepth: 0, head: head(1.6), exits: [] });
assert.ok(near(drill.stats().pctLow, 0.5), drill.stats().pctLow);

drill.start();
drill.update(5, { smokeDepth: 0.4, head: head(1.0), exits: [] });
drill.update(5, { smokeDepth: 0.2, head: head(1.0), exits: [] });
assert.ok(near(drill.stats().smokeTime, 5), drill.stats().smokeTime);
assert.equal(drill.stats().checkedBlocked, false);

drill.start();
drill.update(3, { smokeDepth: 0, head: head(1.6), exits: [] });
drill.stop('escaped');
drill.update(50, { smokeDepth: 1, head: head(0.5), exits: [] });
assert.ok(near(drill.stats().time, 3), drill.stats().time);
assert.ok(near(drill.stats().oxygen, 1), drill.stats().oxygen);
