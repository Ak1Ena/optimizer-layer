import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('packages/runtime/src/cli.ts');

test('CLI creates durable sessions and refuses malformed input without executing it', (t) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-cli-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, 'goal.md'), '- R1: parseCount handles numbers\nAcceptance R1: parseCount returns 2 for 2');
  writeFileSync(join(project, 'checks.json'), '[]');
  const started = spawnSync(process.execPath, [cli, 'start', '--project', project, '--request', join(project, 'goal.md'), '--checks', join(project, 'checks.json')], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const session: unknown = JSON.parse(started.stdout);
  assert.ok(typeof session === 'object' && session !== null && 'id' in session && typeof session.id === 'string');
  const status = spawnSync(process.execPath, [cli, 'status', '--project', project, '--session', session.id], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /"kind":"retrieve"/);
  const malformed = spawnSync(process.execPath, [cli, 'start', '--project', project, '--request', join(project, 'goal.md'), '--checks', join(project, 'goal.md')], { encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /error/);
  const unknown = spawnSync(process.execPath, [cli, 'invented', '--project', project], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
});
