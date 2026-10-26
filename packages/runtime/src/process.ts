import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CommandResult } from './types.ts';

export function runCommand(input: { argv: [string, ...string[]]; cwd: string; timeoutMs: number }): CommandResult {
  const started = performance.now();
  const [command, ...args] = input.argv;
  const child = spawnSync(command, args, {
    cwd: input.cwd, encoding: 'utf8', shell: false, timeout: input.timeoutMs,
    maxBuffer: 65_536, killSignal: 'SIGKILL', windowsHide: true,
    env: { ...process.env, OPTIMIZER_CHECK: '1' },
  });
  const raw = (child.stdout ?? '') + (child.stderr ?? '');
  const output = raw.slice(0, 65_536);
  let outcome: CommandResult['outcome'] = child.status === 0 ? 'passed' : 'failed';
  if (child.error) {
    if ('code' in child.error && child.error.code === 'ETIMEDOUT') outcome = 'timeout';
    else if ('code' in child.error && child.error.code === 'ENOBUFS') outcome = 'output-limit';
    else outcome = 'spawn-error';
  }
  return {
    argv: input.argv, outcome, exitCode: child.status, output: output || child.error?.message || '',
    outputDigest: createHash('sha256').update(raw || child.error?.message || '').digest('hex'), durationMs: performance.now() - started,
  };
}
