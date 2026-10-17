// Run: node web/src/heat.check.js   (no output = pass)
import assert from 'node:assert/strict';
import { heatFrom } from './heat.js';

const head = { x: 0, y: 1.6, z: 0 };
const facingFwd = { x: 0, y: 0, z: 0, w: 1 };                          // looking down -Z, right = +X
const turnedLeft = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };   // yaw +90°, right = -Z
const near = (a, b) => Math.abs(a - b) < 1e-9;

let h = heatFrom(head, facingFwd, [{ x: 2, y: 1, z: 0 }]);             // fire on the right
assert.ok(h.right > 0 && near(h.left, 0), JSON.stringify(h));

h = heatFrom(head, facingFwd, [{ x: -2, y: 1, z: 0 }]);                // fire on the left
assert.ok(h.left > 0 && near(h.right, 0), JSON.stringify(h));

h = heatFrom(head, facingFwd, [{ x: 0, y: 1, z: -2 }]);                // dead ahead → even split
assert.ok(near(h.left, h.right), JSON.stringify(h));

h = heatFrom(head, turnedLeft, [{ x: 0, y: 1, z: -2 }]);               // turned left, fire now on the right
assert.ok(h.right > h.left, JSON.stringify(h));

assert.ok(near(heatFrom(head, facingFwd, [{ x: 0.5, y: 0, z: 0 }]).right, 1));   // max at 0.5 m
assert.deepEqual(heatFrom(head, facingFwd, [{ x: 5, y: 0, z: 0 }]), { left: 0, right: 0 }); // beyond 4.5 m
assert.deepEqual(heatFrom(head, facingFwd, []), { left: 0, right: 0 });

// nearest fire wins
h = heatFrom(head, facingFwd, [{ x: -4, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
assert.ok(h.right > h.left, JSON.stringify(h));
