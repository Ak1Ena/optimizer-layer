import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/process.ts';

test('records real process exit, argv and bounded output without a shell', () => {
  const result = runCommand({ argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1]); process.exitCode=3', '$(echo unintended)'], cwd: process.cwd(), timeoutMs: 1000 });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.output, '$(echo unintended)');
  assert.equal(result.outputDigest.length, 64);
  assert.ok(result.durationMs > 0);
});

test('terminates a timed out check and rejects an unbounded output producer', () => {
  const timeout = runCommand({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 30 });
  assert.equal(timeout.outcome, 'timeout');
  const overflow = runCommand({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(500000))"], cwd: process.cwd(), timeoutMs: 1000 });
  assert.equal(overflow.outcome, 'output-limit');
  assert.ok(overflow.output.length <= 65536);
});
