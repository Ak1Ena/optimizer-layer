import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const benchmark = resolve('examples/benchmark');
const runner = resolve('scripts/benchmark-run.mjs');
const reporter = resolve('scripts/benchmark-report.mjs');
const tasks = JSON.parse(readFileSync(join(benchmark, 'tasks.json'), 'utf8')) as { name: string; class: string }[];

const scratch = (t: test.TestContext, prefix: string) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const passes = (argv: string[], cwd: string) => spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 30_000 }).status === 0;

test('benchmark tasks: the pristine repo fails, the reference solution passes the check and the hidden test, a decoy fails the hidden test', (t) => {
  assert.equal(tasks.length, 8);
  assert.deepEqual(tasks.slice(0, 4).map(task => task.class), ['straightforward', 'ambiguous', 'multi-file', 'misleading'], 'the first four are one per class');
  for (const { name } of tasks) {
    const task = join(benchmark, 'tasks', name);
    const check = readFileSync(join(task, 'check'), 'utf8').trim().split(/\s+/);
    assert.equal(check[0], 'node');
    const hidden = join(task, 'hidden', 'acceptance.mjs');
    assert.doesNotMatch(readFileSync(join(task, 'task.txt'), 'utf8'), /hidden|acceptance/i, `${name}: the request does not reveal the hidden test`);
    const variant = (overlay: string | null) => {
      const copy = join(scratch(t, `bench-${name}-`), 'repo');
      cpSync(join(task, 'repo'), copy, { recursive: true });
      if (overlay) cpSync(join(task, overlay), copy, { recursive: true });
      return { visible: passes(check.slice(1), copy), hidden: passes([hidden, copy], copy) };
    };
    assert.deepEqual(variant(null), { visible: false, hidden: false }, `${name}: pristine`);
    assert.deepEqual(variant('solution'), { visible: true, hidden: true }, `${name}: solution`);
    if (existsSync(join(task, 'decoy'))) assert.equal(variant('decoy').hidden, false, `${name}: decoy`);
  }
});

test('benchmark runner and report on the fake claude: plan gate, A/B/C rows from real sources, resume, AC verdicts', (t) => {
  const directory = scratch(t, 'bench-run-');
  const out = join(directory, 'out');
  // Isolated optimizer state: the runner enables each fresh copy through the runtime's own API.
  const { OPTIMIZER_MODE: _, ...inherited } = process.env;
  const env = { ...inherited, HOME: directory, XDG_CONFIG_HOME: join(directory, 'config') };
  const run = (...extra: string[]) => spawnSync(process.execPath, [runner, '--claude', 'fake', '--tasks', '4', '--reps', '1', '--out', out, ...extra], { encoding: 'utf8', env, timeout: 300_000 });

  const plan = run();
  assert.equal(plan.status, 2, plan.stderr);
  assert.match(plan.stdout, /4 tasks x 3 arms x 1 reps = 12 runs/);
  assert.equal(existsSync(join(out, 'results.jsonl')), false, 'nothing runs without --yes');

  const first = run('--yes');
  assert.equal(first.status, 0, first.stderr);
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 12);
  const row = (id: string) => rows.find(item => item.id === id);
  for (const name of ['parse-count', 'user-nickname']) {
    for (const arm of ['A', 'B', 'C']) assert.equal(row(`${name}:${arm}:0`).hiddenPassed, true, `${name} ${arm}`);
  }
  // The fake writes a decoy that passes the visible check: every arm claims done and the hidden test catches it.
  for (const arm of ['A', 'B', 'C']) assert.deepEqual([row(`invoice-total:${arm}:0`).visiblePassed, row(`invoice-total:${arm}:0`).falseDone], [true, true]);
  // The misleading decoy fails the visible check: only the plain agent claims done.
  assert.equal(row('week-of:A:0').falseDone, true);
  for (const arm of ['B', 'C']) assert.deepEqual([row(`week-of:${arm}:0`).optimizer.outcome, row(`week-of:${arm}:0`).falseDone], ['FAILED', false]);
  for (const item of rows) {
    assert.equal(typeof item.wallMs, 'number');
    assert.equal(item.tokens.total, item.tokens.input + item.tokens.cacheRead + item.tokens.cacheWrite + item.tokens.output, 'tokens come from the reported usage');
    assert.equal(typeof item.totalCostUsd, 'number');
    if (item.arm === 'A') assert.equal(item.optimizer, null);
    if (item.arm === 'B') assert.deepEqual([item.optimizer.tier.initial.tier, item.optimizer.tier.initial.trigger], ['standard', 'forced by run option (optimizer run --tier standard)']);
    if (item.arm === 'C') assert.equal(item.optimizer.tier.initial.tier, 'light');
    if (item.arm !== 'A') assert.ok(item.optimizer.overheadShare > 0 && item.optimizer.overheadShare < 1);
  }

  const again = run('--yes');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /12 already in .*, 0 to run/);
  assert.equal(readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').length, 12, 'resume skips completed rows');

  const report = spawnSync(process.execPath, [reporter, join(out, 'results.jsonl'), '--json'], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  const summary = JSON.parse(report.stdout);
  assert.deepEqual(Object.keys(summary.byArm), ['A', 'B', 'C']);
  assert.deepEqual([summary.byArm.A.falseDone, summary.byArm.B.falseDone, summary.byArm.C.falseDone], [2, 1, 1]);
  assert.equal(summary.ac2.pass, true, 'the fake C is as accurate as A and cheaper per success than B');
  assert.equal(summary.ac1.pass, false, 'the fake C spends more turns than A on straightforward tasks');
  const text = spawnSync(process.execPath, [reporter, join(out, 'results.jsonl')], { encoding: 'utf8' }).stdout;
  assert.match(text, /AC1 FAIL/);
  assert.match(text, /AC2 PASS/);

  // A run without a usage report stays n/a: never estimated.
  const partial = join(directory, 'partial.jsonl');
  writeFileSync(partial, JSON.stringify({ ...rows[0], totalCostUsd: null, tokens: { input: null, cacheRead: null, cacheWrite: null, output: null, total: null } }) + '\n');
  const empty = JSON.parse(spawnSync(process.execPath, [reporter, partial, '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(empty.byArm.A.tokens.total.median, null);
  assert.equal(empty.byArm.A.costPerVerified, null);
  assert.equal(empty.ac1.pass, null);
});

test('benchmark runner refuses to start, before any arm runs, when a Claude Code hook would run another optimizer build', (t) => {
  const directory = scratch(t, 'bench-refuse-');
  const out = join(directory, 'out');
  // An installed runtime too old to report its build (run1: a 0.3.0 dist without the tier.decided event).
  const stale = join(directory, 'optimizer');
  writeFileSync(stale, `#!/bin/sh\necho '{"error":"Unknown command: build"}'\nexit 1\n`, { mode: 0o755 });
  mkdirSync(join(directory, '.claude'));
  const settings = join(directory, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `OPTIMIZER_MODE='always-on' OPTIMIZER_BIN='${stale}' node '/x/claude-hook.js'` }] }] } }));
  const { OPTIMIZER_MODE: _, CLAUDE_CONFIG_DIR: __, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [runner, '--claude', 'fake', '--tasks', '4', '--reps', '1', '--out', out, '--yes'], {
    encoding: 'utf8', env: { ...inherited, HOME: directory, XDG_CONFIG_HOME: join(directory, 'config') }, timeout: 300_000,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /benchmark refused: another optimizer build would also run/);
  assert.ok(result.stderr.includes(`${stale} (set in ${settings}) is a build that cannot report its identity`), result.stderr);
  assert.equal(existsSync(join(out, 'results.jsonl')), false, 'no arm ran');
});
