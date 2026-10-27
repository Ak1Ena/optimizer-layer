import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { toCsvRow } = await load('src/csv.mjs');
assert.equal(toCsvRow(['a', 'b,c']), 'a,"b,c"');
assert.equal(toCsvRow(['say "hi"', 'x']), '"say ""hi""",x');
assert.equal(toCsvRow(['line1\nline2', 'cr\rhere']), '"line1\nline2","cr\rhere"');
assert.equal(toCsvRow(['plain', 42, '']), 'plain,42,');
assert.equal(toCsvRow(['"']), '""""');
