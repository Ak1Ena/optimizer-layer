import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { parseCount } = await load('src/parseCount.mjs');
const valid = [0, 1, 12, Number.MAX_SAFE_INTEGER, '0', '12', '00012', String(Number.MAX_SAFE_INTEGER)];
for (const input of valid) assert.equal(parseCount(input), Number(input), `valid ${String(input)}`);
const invalid = [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 1', '1 ', '-1', '+1', '1.5', '1e2', 'hello', String(Number.MAX_SAFE_INTEGER + 1), null, undefined, true, false, {}, [], [1]];
for (const input of invalid) assert.throws(() => parseCount(input), RangeError, `invalid ${String(input)}`);
