import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runOptimizer } from '../src/index.ts';

test('passes checkpoint arguments literally and retains a failed command response', t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'optimizer-adapter-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const result = runOptimizer({
    executable: process.execPath,
    args: ['-e', 'console.error("check failed"); console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = 1', '--'],
    projectRoot,
    sessionId: 'session-1',
    command: 'check',
    options: { check: 'acceptance; $(touch NEVER)', limit: 3 },
  });
  assert.equal(result.kind, 'response');
  if (result.kind !== 'response') return;
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr.trim(), 'check failed');
  assert.deepEqual(result.value, [
    'check', '--project', projectRoot, '--session', 'session-1',
    '--check', 'acceptance; $(touch NEVER)', '--limit', '3',
  ]);
});

test('distinguishes malformed or scalar JSON from an execution failure', () => {
  for (const output of ['not json', 'null', '"scalar"']) {
    const result = runOptimizer({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(output)}); process.exitCode = 2`, '--'],
      projectRoot: tmpdir(), command: 'status',
    });
    assert.equal(result.kind, 'protocol-error');
    assert.equal(result.exitCode, 2);
  }
});

test('reports missing runtime executable as a transport failure', () => {
  const result = runOptimizer({ executable: '/optimizer-does-not-exist', projectRoot: tmpdir(), command: 'status' });
  assert.equal(result.kind, 'transport-error');
  assert.equal(result.exitCode, null);
});

test('bounds runtime output instead of accepting a truncated response', () => {
  const result = runOptimizer({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({text:"x".repeat(2_000_000)}))', '--'],
    projectRoot: tmpdir(), command: 'events',
  });
  assert.equal(result.kind, 'transport-error');
});

test('stops a runtime that exceeds its transport deadline', () => {
  const result = runOptimizer({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)', '--'],
    projectRoot: tmpdir(), command: 'status', timeoutMs: 100,
  });
  assert.equal(result.kind, 'transport-error');
  assert.equal(result.exitCode, null);
});

test('rejects relative paths and reserved routing options before spawning', () => {
  const input = { executable: process.execPath, projectRoot: tmpdir(), command: 'status' } satisfies Parameters<typeof runOptimizer>[0];
  assert.throws(() => runOptimizer({ ...input, executable: 'optimizer' }), /absolute/);
  assert.throws(() => runOptimizer({ ...input, projectRoot: '.' }), /absolute/);
  assert.throws(() => runOptimizer({ ...input, options: { project: '/another-project' } }), /reserved/i);
  assert.throws(() => runOptimizer({ ...input, options: { 'invalid option': 'x' } }), /option/);
  assert.throws(() => runOptimizer({ ...input, timeoutMs: 0 }), /timeoutMs/);
});


test('reports runtime command rejection without calling it a failed check', () => {
  const result = runOptimizer({
    executable: process.execPath,
    args: ['-e', 'console.error(JSON.stringify({error:"Session is paused"})); process.exitCode = 1', '--'],
    projectRoot: tmpdir(), command: 'check',
  });
  assert.equal(result.kind, 'runtime-error');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Session is paused/);
});
