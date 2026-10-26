import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type OptimizerCommand =
  | 'init' | 'enable' | 'disable' | 'prompt' | 'current' | 'start' | 'history' | 'retrieve' | 'assess' | 'review' | 'resolve' | 'next'
  | 'check' | 'reconsider' | 'claim' | 'verify' | 'status' | 'events' | 'metrics';

export interface OptimizerInput {
  executable: string;
  args?: string[];
  projectRoot: string;
  sessionId?: string;
  command: OptimizerCommand;
  options?: Record<string, string | number>;
  timeoutMs?: number;
}

export type OptimizerResult =
  | { kind: 'response'; exitCode: number; value: unknown; stderr: string }
  | { kind: 'runtime-error'; exitCode: number; stderr: string }
  | { kind: 'protocol-error'; exitCode: number; reason: string; stderr: string }
  | { kind: 'transport-error'; exitCode: number | null; reason: string; stderr: string };

/** Invoke the runtime without a shell. The runtime owns response semantics and policy. */
export function runOptimizer(input: OptimizerInput): OptimizerResult {
  if (!isAbsolute(input.executable) || !isAbsolute(input.projectRoot)) {
    throw new TypeError('executable and projectRoot must be absolute paths');
  }
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  const argv = [...(input.args ?? []), input.command, '--project', input.projectRoot];
  if (input.sessionId !== undefined) argv.push('--session', input.sessionId);
  for (const [name, value] of Object.entries(input.options ?? {})) {
    if (name === 'project' || name === 'session') throw new TypeError(`Reserved routing option: ${name}`);
    if (!/^[a-z][a-z-]*$/.test(name)) throw new TypeError(`Invalid option name: ${name}`);
    argv.push(`--${name}`, String(value));
  }
  const result = spawnSync(input.executable, argv, {
    cwd: input.projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 1_048_576,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = result.stderr ?? '';
  if (result.error || result.status === null) {
    return {
      kind: 'transport-error', exitCode: result.status, stderr,
      reason: result.error?.message ?? `Runtime terminated by ${result.signal ?? 'unknown signal'}`,
    };
  }
  if (result.status !== 0 && !result.stdout.trim()) {
    return { kind: 'runtime-error', exitCode: result.status, stderr };
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== 'object' || value === null) {
      return { kind: 'protocol-error', exitCode: result.status, stderr, reason: 'Runtime must return a JSON object or array' };
    }
    return { kind: 'response', exitCode: result.status, value, stderr };
  } catch {
    return { kind: 'protocol-error', exitCode: result.status, stderr, reason: 'Runtime did not return one valid JSON document' };
  }
}
