import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { clamp } = await load('src/clamp.mjs');
for (const [value, min, max, expected] of [[15, 0, 10, 10], [5, 0, 10, 5], [-3, 0, 10, 0], [10, 0, 10, 10], [0, 0, 10, 0], [-5, -10, -1, -5], [-0.5, -1, -0.75, -0.75], [2.5, 1.25, 2, 2], [7, 7, 7, 7]]) {
  assert.equal(clamp(value, min, max), expected, `clamp(${value}, ${min}, ${max})`);
}
