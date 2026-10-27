import assert from 'node:assert/strict';
import { parseCount } from '../src/parseCount.mjs';

assert.equal(parseCount('12'), 12);
assert.equal(parseCount(3), 3);
assert.throws(() => parseCount('-1'), RangeError);
assert.throws(() => parseCount('abc'), RangeError);
console.log('ok');
