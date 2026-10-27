import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

assert.equal(clamp(15, 0, 10), 10);
console.log('ok');
