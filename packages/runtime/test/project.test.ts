import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { capturePrompt, commandArgv, disableProject, enableProject, readProjectConfig, sessionSummary } from '../src/project.ts';

const cli = resolve('packages/runtime/src/cli.ts');

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-project-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value) || 0; }\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, 'process.exit(0);\n');
  return { directory, project, checker };
}

const goal = '- R1: parseCount preserves nonnegative integers.\nAcceptance R1: parseCount returns 2 for numeric text.\n- R2: parseCount rejects negative values.\nAcceptance R2: parseCount throws for negative values.\nQuestion human Q1: What should parseCount do for negative values?';

function token(project: string): string {
  const config = readProjectConfig(project);
  assert.ok(config);
  return config.hookToken;
}

test('enable tokenizes checks without a shell, resolves argv[0] and requires --yes for a proposed test script', (t) => {
  const { project, checker } = setup(t);
  assert.throws(() => enableProject(project, { commands: [], timeoutMs: 1000, yes: false }), /--check is required/);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.throws(() => enableProject(project, { commands: [], timeoutMs: 1000, yes: false }), /--check 'npm test'.*--yes/);
  for (const command of ['node a.mjs | tee x', 'node a; rm -rf /', 'echo $HOME', 'node a > out', 'echo `id`', 'a && b']) {
    assert.throws(() => commandArgv(command, project), /metacharacters/);
  }
  assert.throws(() => commandArgv('node "unterminated', project), /Unbalanced quote/);
  assert.throws(() => commandArgv('optimizer-no-such-command-xyz', project), /not found/);
  const argv = commandArgv(`node "${checker}" 'two words' --flag`, project);
  assert.ok(argv[0].startsWith('/'));
  assert.deepEqual(argv.slice(1), [checker, 'two words', '--flag']);
  const enabled = enableProject(project, { commands: [`node ${checker}`], timeoutMs: 1000, yes: false });
  assert.equal(enabled.checks[0]?.argv[1], checker);
  const config = readProjectConfig(project);
  assert.ok(config?.enabled);
  assert.deepEqual(config.checks[0]?.requirementIds, ['*']);
  assert.ok(config.checks[0]?.artifacts.some(item => item.path === checker));
  assert.equal(statSync(join(project, '.optimizer', 'project.json')).mode & 0o777, 0o600);
  const firstToken = config.hookToken;
  enableProject(project, { commands: [], timeoutMs: 1000, yes: true });
  assert.equal(readProjectConfig(project)?.checks[0]?.argv[1], 'test');
  assert.equal(token(project), firstToken);
  disableProject(project);
  assert.equal(readProjectConfig(project)?.enabled, false);
});

test('prompt capture requires the hook token and an enabled project', (t) => {
  const { project, checker } = setup(t);
  assert.throws(() => capturePrompt(project, 'hello', undefined), /not enabled/);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 1000, yes: false });
  assert.throws(() => capturePrompt(project, 'hello', 'wrong'), /hook token/);
  assert.throws(() => capturePrompt(project, '   ', token(project)), /nonempty/);
  const { id } = capturePrompt(project, '  Throw RangeError.\n', token(project));
  const row: unknown = JSON.parse(readFileSync(join(project, '.optimizer', 'prompts.jsonl'), 'utf8'));
  assert.deepEqual({ ...(row as object), timestamp: 'T' }, { id, projectRoot: project, role: 'user', content: '  Throw RangeError.\n', timestamp: 'T', capturedBy: 'hook' });
  const denied = spawnSync(process.execPath, [cli, 'prompt', '--project', project, '--file', checker], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_HOOK_TOKEN: '' } });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /hook token/);
  disableProject(project);
  assert.throws(() => capturePrompt(project, 'hello', token(project)), /not enabled/);
});

test('hook-captured prompts resolve human questions, stay fresh as the log grows and go stale when edited', (t) => {
  const { project, checker } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 1000, yes: false });
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({ request: goal });
  assert.deepEqual(session.checks.map(check => check.requirementIds), [['R1', 'R2']]);
  const log = join(project, '.optimizer', 'prompts.jsonl');
  appendFileSync(log, JSON.stringify({ id: 'agent', projectRoot: project, role: 'user', content: 'Throw RangeError.', timestamp: new Date().toISOString() }) + '\n');
  appendFileSync(log, JSON.stringify({ id: 'assistant', projectRoot: project, role: 'assistant', content: 'Throw RangeError.', timestamp: new Date().toISOString(), capturedBy: 'hook' }) + '\n');
  assert.throws(() => runtime.resolve(session.id, { uncertaintyId: 'Q1', source: 'prompt:agent' }), /hook-captured/);
  assert.throws(() => runtime.resolve(session.id, { uncertaintyId: 'Q1', source: 'prompt:assistant' }), /hook-captured/);
  appendFileSync(log, 'not json\n');
  appendFileSync(log, JSON.stringify({ id: 'elsewhere', projectRoot: tmpdir(), role: 'user', content: 'x', timestamp: new Date().toISOString(), capturedBy: 'hook' }) + '\n');
  assert.throws(() => runtime.resolve(session.id, { uncertaintyId: 'Q1', source: 'prompt:elsewhere' }), /hook-captured/);
  const { id } = capturePrompt(project, 'Negative values must throw RangeError.', token(project));
  const resolved = runtime.resolve(session.id, { uncertaintyId: 'Q1', source: `prompt:${id}` });
  const question = resolved.goal.uncertainties.find(item => item.id === 'Q1');
  assert.deepEqual(question?.resolution, { kind: 'resolved', answer: 'Negative values must throw RangeError.', source: `prompt:${id}` });
  const context = runtime.retrieve(session.id);
  assert.ok(context.items.some(item => item.id === `decision:prompt:${id}` && item.authority === 'user-decision'));
  const itemIds = context.items.map(item => item.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds, rationale: 'The counter source and the captured user decision cover both requirements.' });
  capturePrompt(project, 'A later unrelated prompt.', token(project));
  assert.equal(runtime.next(session.id).kind, 'review');
  const content = readFileSync(log, 'utf8');
  writeFileSync(log, content.replace('Negative values must throw RangeError.', 'Negative values must return zero.'));
  assert.equal(runtime.next(session.id).kind, 'clarify');
});

test('start uses project checks, sets the active session and requires --replace for an unfinished one', (t) => {
  const { project, checker } = setup(t);
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  assert.throws(() => runtime.start({ request: goal }), /--checks is required/);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 1000, yes: false });
  assert.throws(() => runtime.start({ request: goal, checks: [{ id: 'mine', requirementIds: ['R1'], argv: ['/bin/echo'], timeoutMs: 1000 }] }), /only from `optimizer enable`/);
  const first = runtime.start({ request: goal });
  assert.equal(readProjectConfig(project)?.activeSessionId, first.id);
  assert.throws(() => runtime.start({ request: goal }), /--replace/);
  const second = runtime.start({ request: '- R1: parseCount trims input.\nAcceptance R1: parseCount of " 2" returns 2.', replace: true });
  assert.equal(readProjectConfig(project)?.activeSessionId, second.id);
  assert.deepEqual(second.checks.map(check => [check.id, check.requirementIds]), [['check-1', ['R1']]]);
  assert.equal(runtime.events(first.id).at(-1)?.event.payload.kind, 'session.replaced');
  assert.equal(runtime.get(first.id).goal.version, first.goal.version);
  const database = new DatabaseSync(join(project, '.optimizer', 'runtime.sqlite'));
  database.prepare('UPDATE events SET body=? WHERE session_id=?').run('{}', second.id);
  database.close();
  assert.throws(() => runtime.start({ request: goal }), /--replace/);
  const third = runtime.start({ request: goal, replace: true });
  assert.equal(readProjectConfig(project)?.activeSessionId, third.id);
});

test('current reports enablement and a bounded session summary', (t) => {
  const { project, checker } = setup(t);
  const current = () => {
    const result = spawnSync(process.execPath, [cli, 'current', '--project', project], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as unknown;
  };
  assert.deepEqual(current(), { enabled: false, sessionId: null, action: null, summary: '' });
  assert.equal(existsSync(join(project, '.optimizer')), false);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 1000, yes: false });
  assert.deepEqual(current(), { enabled: true, sessionId: null, action: null, summary: 'No active optimizer session.' });
  writeFileSync(join(project, 'goal.md'), goal);
  const started = spawnSync(process.execPath, [cli, 'start', '--project', project, '--request', join(project, 'goal.md')], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const value = current();
  assert.ok(typeof value === 'object' && value !== null && 'summary' in value && typeof value.summary === 'string' && 'action' in value);
  assert.match(value.summary, /goal version 1[\s\S]*R1: parseCount preserves[\s\S]*Q1 \(human\)[\s\S]*Review: pending[\s\S]*Control: running[\s\S]*Last check: none/);
  assert.deepEqual(value.action, { kind: 'clarify', route: 'human', reason: 'Critical human decisions need answers with source references', uncertaintyIds: ['Q1'] });
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const large = runtime.start({ request: Array.from({ length: 80 }, (_, index) => `- R${index}: ${'requirement text '.repeat(10)}`).join('\n'), replace: true });
  const summary = sessionSummary(large, runtime.next(large.id));
  assert.equal(summary.length, 2000);
  assert.ok(summary.endsWith('...'));
});
