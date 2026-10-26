import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const project = process.argv[2];
if (!project) throw new Error('Project directory is required');
const { parseCount } = await import(pathToFileURL(join(project, 'parseCount.mjs')).href);
const valid = [0, 1, 12, Number.MAX_SAFE_INTEGER, '0', '12', '00012', String(Number.MAX_SAFE_INTEGER)];
for (const input of valid) assert.equal(parseCount(input), Number(input), `valid count ${String(input)}`);
const invalid = [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 1', '1 ', '-1', '+1', '1.5', '1e2', 'hello', String(Number.MAX_SAFE_INTEGER + 1), null, undefined, true, false, {}, [], [1]];
for (const input of invalid) assert.throws(() => parseCount(input), RangeError, `invalid count ${String(input)}`);
process.stdout.write(JSON.stringify({ verified: ['R1', 'R2', 'R3'], validCases: valid.length, invalidCases: invalid.length }) + '\n');
