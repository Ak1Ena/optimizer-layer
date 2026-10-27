import assert from 'node:assert/strict';
import { toCsvRow } from '../src/csv.mjs';

assert.equal(toCsvRow(['a', 'b,c']), 'a,"b,c"');
console.log('ok');
