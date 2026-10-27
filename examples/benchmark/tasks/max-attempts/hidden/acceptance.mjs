import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(join(process.argv[2], path)).href);

const { loadConfig } = await load('src/config.mjs');
const { parseArgs } = await load('src/cli.mjs');
const { withRetries } = await load('src/client.mjs');
assert.equal(loadConfig().maxAttempts, 3);
assert.equal(loadConfig({ maxAttempts: 1 }).maxAttempts, 1);
assert.equal(loadConfig({ retries: 4 }).maxAttempts, 5);
assert.equal(loadConfig({ retries: 0 }).maxAttempts, 1);
assert.equal(parseArgs(['--max-attempts', '4']).maxAttempts, 4);
assert.equal(parseArgs(['--timeout-ms', '50']).timeoutMs, 50);
for (const maxAttempts of [1, 3, 5]) {
  let calls = 0;
  await assert.rejects(withRetries(loadConfig({ maxAttempts }), async () => { calls += 1; throw new Error('down'); }), /down/);
  assert.equal(calls, maxAttempts);
}
assert.equal(await withRetries(loadConfig({ maxAttempts: 3 }), async attempt => { if (attempt < 2) throw new Error('flaky'); return 'ok'; }), 'ok');
