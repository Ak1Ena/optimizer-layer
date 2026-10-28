#!/usr/bin/env node
// A/B/C benchmark (docs/superpowers/specs/2026-10-27-adaptive-execution-design.md). Spends real model quota
// unless --claude points at a fake; it prints the run count and does nothing without --yes.
//   A: plain `claude -p` with OPTIMIZER_DISABLED=1.  B: `optimizer run --tier standard`.  C: `optimizer run`.
// Each run gets a fresh git copy of the task repo; B/C enable it with the task's check through the runtime's own
// enableProject (operator code: this script runs in the user's terminal). The hidden test runs after the agent
// exits, from outside the copy. One JSONL row per run; completed rows are skipped on re-run.
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildConflicts, claudeArgs, findExecutable } from '../packages/runtime/src/managed.ts';
import { commandArgv, enableProject } from '../packages/runtime/src/project.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const benchmark = join(repoRoot, 'examples/benchmark');
const cli = join(repoRoot, 'packages/runtime/src/cli.ts');
const hook = join(repoRoot, 'packages/adapter/src/claude-hook.ts');
const arms = ['A', 'B', 'C'];

const { values } = parseArgs({ options: {
  tasks: { type: 'string', default: '4' }, reps: { type: 'string', default: '1' }, claude: { type: 'string' }, model: { type: 'string' },
  'max-turns': { type: 'string', default: '30' }, 'timeout-ms': { type: 'string', default: '900000' },
  'claude-args': { type: 'string', default: '--permission-mode acceptEdits --allowedTools Bash' },
  out: { type: 'string', default: 'benchmark-results' }, yes: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false },
} });
const positive = (name, max) => {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return value;
};
if (values.tasks !== '4' && values.tasks !== '8') throw new Error('--tasks must be 4 or 8');
const reps = positive('reps', 50);
const maxTurns = positive('max-turns', 1000);
const timeoutMs = positive('timeout-ms', 4 * 60 * 60 * 1000);
const tasks = JSON.parse(readFileSync(join(benchmark, 'tasks.json'), 'utf8')).slice(0, Number(values.tasks));
const claude = values.claude === 'fake' ? join(benchmark, 'fake-claude.mjs') : values.claude ? resolve(values.claude) : findExecutable('claude');
if (!claude) throw new Error('claude not found on PATH; pass --claude PATH');
// Same whitespace-only rules as `optimizer run --claude-args`, so all arms get identical arguments.
const extra = [...claudeArgs(values['claude-args']), ...(values.model ? ['--model', ...claudeArgs(values.model)] : [])];

const out = resolve(values.out);
const results = join(out, 'results.jsonl');
const previous = (existsSync(results) ? readFileSync(results, 'utf8').split('\n') : []).flatMap(line => {
  try {
    return [JSON.parse(line)];
  } catch {
    return []; // a half-written last line from an interrupted run
  }
});
const mismatch = previous.find(row => row.claude !== claude || row.maxTurns !== maxTurns || row.claudeArgs.join(' ') !== extra.join(' '));
if (mismatch) throw new Error(`${results} holds runs with another claude, model, --claude-args or --max-turns (${mismatch.id}); use a new --out`);
// Infrastructure failures (no agent report, spawn error) are retried; a later row with the same id wins in the report.
const done = new Set(previous.filter(row => row.output !== null && !row.spawnError).map(row => row.id));
// Rotating the arm order per rep spreads any warm-cache or time-of-day effect across arms.
const plan = Array.from({ length: reps }, (_, rep) => tasks.flatMap(task => arms.map((_, index) => arms[(index + rep) % arms.length]).map(arm => ({ task, arm, rep, id: `${task.name}:${arm}:${rep}` })))).flat();
const todo = plan.filter(run => !done.has(run.id));
process.stdout.write(`benchmark: ${tasks.length} tasks x ${arms.length} arms x ${reps} reps = ${plan.length} runs (${plan.length - todo.length} already in ${results}, ${todo.length} to run)\n`
  + `claude: ${claude}\nclaude args: ${extra.join(' ') || '(none)'}; max turns ${maxTurns}; timeout ${timeoutMs} ms per run\n`);
if (!values.yes) {
  process.stdout.write('Nothing run. Re-run with --yes to start (each run with a real claude spends model quota).\n');
  process.exit(todo.length ? 2 : 0);
}

mkdirSync(out, { recursive: true });
// The hooks and `optimizer run` call the runtime through this executable.
const bin = join(out, 'optimizer');
writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
chmodSync(bin, 0o755);
// `optimizer run` refuses this per run too; checking once here keeps arm A from spending quota first.
const conflicts = buildConflicts(bin);
if (conflicts.length) {
  process.stderr.write(`benchmark refused: another optimizer build would also run:\n  ${conflicts.join('\n  ')}\nPoint those hooks at this checkout's build (or remove them) and retry.\n`);
  process.exit(1);
}

const parse = text => {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const tail = text => (text ?? '').slice(-2000);
const tokens = usage => {
  const parts = { input: num(usage?.input_tokens), cacheRead: num(usage?.cache_read_input_tokens), cacheWrite: num(usage?.cache_creation_input_tokens), output: num(usage?.output_tokens) };
  const all = Object.values(parts);
  return { ...parts, total: all.every(value => value !== null) ? all.reduce((sum, value) => sum + value, 0) : null };
};

function fresh(task, work) {
  const copy = join(work, 'repo');
  cpSync(join(benchmark, 'tasks', task.name, 'repo'), copy, { recursive: true });
  const git = (...rest) => {
    const result = spawnSync('git', ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', ...rest], { cwd: copy, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${rest[0]} failed: ${result.stderr}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'task snapshot');
  return copy;
}

function runArm(arm, task, copy, promptFile, prompt) {
  if (arm === 'A') {
    const child = spawnSync(claude, ['-p', '--output-format', 'json', '--max-turns', String(maxTurns), ...extra], {
      cwd: copy, input: prompt, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OPTIMIZER_DISABLED: '1' },
    });
    const report = parse(child.stdout);
    return {
      child, raw: report,
      agent: { turns: num(report?.num_turns), totalCostUsd: num(report?.total_cost_usd), usage: report?.usage ?? null, reportedSuccess: typeof report?.is_error === 'boolean' ? !report.is_error : null },
      // A plain agent that ends without error has presented its work as done.
      claimedDone: report?.is_error === false,
      optimizer: null,
    };
  }
  const child = spawnSync(process.execPath, [
    cli, 'run', '--project', copy, '--prompt-file', promptFile, '--max-turns', String(maxTurns), '--timeout-ms', String(timeoutMs),
    '--claude', claude, '--hook', hook, ...(extra.length ? [`--claude-args=${extra.join(' ')}`] : []), ...(arm === 'B' ? ['--tier', 'standard'] : []),
  ], { cwd: copy, encoding: 'utf8', timeout: timeoutMs + 300_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, OPTIMIZER_BIN: bin } });
  const report = parse(child.stdout);
  const timings = report?.timings ?? null;
  // No hook traces read means hook time was not measured, not zero.
  const hookMs = report?.cost?.hooks?.invocations > 0 ? num(report.cost.hooks.elapsedMs) : null;
  const parts = [num(timings?.startMs), num(timings?.verifyMs), hookMs];
  const overheadMs = parts.includes(null) ? null : parts.reduce((sum, value) => sum + value, 0);
  return {
    child, raw: report,
    agent: {
      turns: num(report?.turns), totalCostUsd: num(report?.cost?.agent?.totalCostUsd), usage: report?.usage ?? null,
      reportedSuccess: typeof report?.agentReportedError === 'boolean' ? !report.agentReportedError : null,
    },
    // The controller reports done only for VERIFIED (and exits 0 only then).
    claimedDone: report?.outcome === 'VERIFIED',
    optimizer: {
      outcome: report?.outcome ?? null, sessionId: report?.sessionId ?? null, tier: report?.cost?.tier ?? null, rework: report?.cost?.rework ?? null,
      injected: report?.cost?.injected ?? null, timings, hookMs, overheadMs,
      overheadShare: overheadMs !== null && num(timings?.totalMs) ? overheadMs / timings.totalMs : null,
    },
  };
}

function check(copy, command) {
  const [file, ...rest] = commandArgv(command, copy);
  return spawnSync(file, rest, { cwd: copy, encoding: 'utf8', timeout: 60_000 }).status === 0;
}

for (const [index, run] of todo.entries()) {
  const { task, arm, rep, id } = run;
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-bench-')));
  try {
    const copy = fresh(task, work);
    const prompt = readFileSync(join(benchmark, 'tasks', task.name, 'task.txt'), 'utf8');
    const promptFile = join(work, 'prompt.txt');
    writeFileSync(promptFile, prompt);
    // Setup stays outside the timed region so A and B/C wall clocks cover the same thing.
    if (arm !== 'A') enableProject(copy, { commands: [readFileSync(join(benchmark, 'tasks', task.name, 'check'), 'utf8').trim()], timeoutMs: 30_000, yes: false });
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = runArm(arm, task, copy, promptFile, prompt);
    const wallMs = performance.now() - started;
    const hidden = spawnSync(process.execPath, [join(benchmark, 'tasks', task.name, 'hidden', 'acceptance.mjs'), copy], { cwd: copy, encoding: 'utf8', timeout: 60_000 });
    const hiddenPassed = hidden.status === 0;
    const row = {
      id, task: task.name, class: task.class, arm, rep, startedAt, wallMs, claude, claudeArgs: extra, maxTurns,
      exitCode: result.child.status, timedOut: result.child.error?.code === 'ETIMEDOUT', spawnError: result.child.error && result.child.error.code !== 'ETIMEDOUT' ? result.child.error.message : null,
      hiddenPassed, hiddenStderr: hiddenPassed ? '' : tail(hidden.stderr), visiblePassed: check(copy, readFileSync(join(benchmark, 'tasks', task.name, 'check'), 'utf8').trim()),
      claimedDone: result.claimedDone, falseDone: result.claimedDone && !hiddenPassed, agentReportedSuccess: result.agent.reportedSuccess,
      turns: result.agent.turns, totalCostUsd: result.agent.totalCostUsd, tokens: tokens(result.agent.usage),
      optimizer: result.optimizer, stderr: tail(result.child.stderr), output: result.raw,
    };
    appendFileSync(results, JSON.stringify(row) + '\n');
    process.stdout.write(`[${index + 1}/${todo.length}] ${id}: hidden ${hiddenPassed ? 'PASS' : 'FAIL'}${row.falseDone ? ' (false done)' : ''}, ${Math.round(wallMs / 1000)} s, tokens ${row.tokens.total ?? 'n/a'}${arm === 'A' ? '' : `, outcome ${row.optimizer.outcome ?? 'n/a'}, tier ${row.optimizer.tier?.initial?.tier ?? 'n/a'}`}\n`);
  } finally {
    if (values.keep) process.stdout.write(`  kept ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
}
process.stdout.write(`results: ${results}\nreport: node scripts/benchmark-report.mjs ${results}\n`);
