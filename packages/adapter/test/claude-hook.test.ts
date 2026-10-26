import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hookScript = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const runtimeCli = fileURLToPath(new URL('../../runtime/src/cli.ts', import.meta.url));

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-hook-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = () => "hello";\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, 'process.exit(0);\n');
  const bin = join(directory, 'optimizer');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runtimeCli)} "$@"\n`);
  chmodSync(bin, 0o755);
  function optimizer(...args: string[]): unknown {
    const result = spawnSync(bin, [...args, '--project', project], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  function hook(input: Record<string, unknown>, cwd = project) {
    const result = spawnSync(process.execPath, [hookScript], {
      encoding: 'utf8', input: JSON.stringify({ session_id: 'claude-1', cwd, ...input }), env: { ...process.env, OPTIMIZER_BIN: bin },
    });
    assert.equal(result.status, 0, result.stderr);
    return { output: result.stdout.trim() ? JSON.parse(result.stdout) as unknown : undefined, stderr: result.stderr };
  }
  return { directory, project, checker, bin, optimizer, hook };
}

function field(value: unknown, ...names: string[]): unknown {
  let current = value;
  for (const name of names) {
    assert.ok(typeof current === 'object' && current !== null && name in current, `missing ${name}`);
    current = Reflect.get(current, name);
  }
  return current;
}

const edit = (file: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

test('disabled or unconfigured projects get no output and no runtime state', t => {
  const { project, checker, optimizer, hook } = setup(t);
  for (const event of [{ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, edit(join(project, 'greeting.mjs')), { hook_event_name: 'Stop' }]) {
    assert.deepEqual(hook(event), { output: undefined, stderr: '' });
  }
  assert.equal(existsSync(join(project, '.optimizer')), false);
  optimizer('enable', '--check', `node ${checker}`);
  optimizer('disable');
  assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, join(project)), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer', 'prompts.jsonl')), false);
});

test('hooks capture prompts, gate edits by contract action and guard Stop without looping', t => {
  const { project, checker, optimizer, hook } = setup(t);
  optimizer('enable', '--check', `node ${checker}`);
  const first = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'greeting should greet by name' }).output;
  const context = field(first, 'hookSpecificOutput', 'additionalContext');
  assert.equal(field(first, 'hookSpecificOutput', 'hookEventName'), 'UserPromptSubmit');
  assert.ok(typeof context === 'string');
  const promptId = /prompt:([0-9a-f-]{36})/.exec(context)?.[1];
  assert.ok(promptId);
  assert.match(context, /no open goal contract[\s\S]*\.optimizer\/drafts\/NAME\.md[\s\S]*Acceptance R1:/);
  assert.match(readFileSync(join(project, '.optimizer', 'prompts.jsonl'), 'utf8'), /"content":"greeting should greet by name".*"capturedBy":"hook"/);

  assert.deepEqual(hook(edit(join(project, 'greeting.mjs'))).output, deny('No approved goal contract; draft it and get user approval first.'));
  assert.equal(hook(edit(join(project, '.optimizer', 'drafts', 'goal.md'))).output, undefined);
  assert.equal(hook(edit('/somewhere/else.txt')).output, undefined);
  assert.deepEqual(hook(edit('.optimizer/prompts.jsonl')).output, deny('optimizer: runtime state is written only by the optimizer runtime and hook.'));
  assert.deepEqual(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'optimizer prompt --file x' } }).output, deny('optimizer: prompt capture, project enablement and runtime state belong to the user and the Claude Code hook.'));
  const bash = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }).output;
  for (const command of [
    'optimizer enable --check true', '/x/optimizer  disable', 'optimizer --project . enable --check true',
    'node packages/runtime/src/cli.ts enable --check true', 'node cli.ts prompt --project . --file x',
    'printf x >> .optimizer/prompts.jsonl', 'cd .optimizer && echo x >> prompts.jsonl', 'cat .optimizer/project.json',
  ]) {
    assert.equal(field(bash(command), 'hookSpecificOutput', 'permissionDecision'), 'deny', command);
  }
  for (const command of [
    `optimizer next --project ${project} --session S`, 'optimizer check --project . --session S --check check-1',
    'optimizer resolve --project . --session S --question Q1 --source prompt:abc',
    'cat .optimizer/drafts/goal.md', "printf '- R1: x' > .optimizer/drafts/goal.md", 'npm test',
  ]) {
    assert.equal(bash(command), undefined, command);
  }
  mkdirSync(join(project, 'sub', '.optimizer'), { recursive: true });
  assert.deepEqual(hook(edit(join(project, 'greeting.mjs')), join(project, 'sub')).output, deny('No approved goal contract; draft it and get user approval first.'));
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).output, undefined);
  assert.equal(hook({ hook_event_name: 'Stop' }).output, undefined);

  const draft = join(project, '.optimizer', 'drafts', 'goal.md');
  mkdirSync(join(project, '.optimizer', 'drafts'));
  writeFileSync(draft, '- R1: greeting returns a personalized greeting.\nAcceptance R1: greeting of Ada returns Hello Ada.\nQuestion human Q1: Which greeting language is required?\n');
  const sessionId = field(optimizer('start', '--request', draft), 'id');
  assert.ok(typeof sessionId === 'string');
  const clarifyReason = 'Critical human decisions need answers with source references';
  const denied = hook(edit(join(project, 'greeting.mjs'))).output;
  assert.match(String(field(denied, 'hookSpecificOutput', 'permissionDecisionReason')), new RegExp(`^optimizer: clarify: ${clarifyReason}`));
  assert.deepEqual(hook({ hook_event_name: 'Stop' }).output, { systemMessage: `optimizer: waiting on the user (Q1): ${clarifyReason}` });

  const answer = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'English: Hello NAME.' }).output;
  const answerContext = String(field(answer, 'hookSpecificOutput', 'additionalContext'));
  const answerId = /prompt:([0-9a-f-]{36})/.exec(answerContext)?.[1];
  assert.ok(answerId);
  assert.match(answerContext, new RegExp(`Active optimizer session ${sessionId}[\\s\\S]*Q1 \\(human\\)[\\s\\S]*Checkpoint for clarify[\\s\\S]*--source prompt:${answerId}`));
  optimizer('resolve', '--session', sessionId, '--question', 'Q1', '--source', `prompt:${answerId}`);
  assert.match(String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason')), /^optimizer: retrieve: /);

  const items = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(items));
  const ids = items.map(item => String(field(item, 'id'))).join(',');
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', ids, '--rationale', 'The greeting source and captured user decision cover R1.');
  const version = field(optimizer('status', '--session', sessionId), 'state', 'goal', 'version');
  optimizer('review', '--session', sessionId, '--kind', 'accept', '--version', String(version), '--items', ids, '--rationale', 'R1 and its acceptance preserve the request.');
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined);

  const blocked = hook({ hook_event_name: 'Stop', stop_hook_active: false }).output;
  assert.equal(field(blocked, 'decision'), 'block');
  assert.match(String(field(blocked, 'reason')), /^optimizer: next action execute: /);
  const unverified = { systemMessage: 'optimizer: task unverified, stopping' };
  assert.deepEqual(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, unverified);
  writeFileSync(join(project, '.optimizer', 'hook-state.json'), '{corrupt');
  assert.equal(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, 'decision'), 'block');
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = name => `Hello ${name}`;\n');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'reason')), /^optimizer: next action retrieve: /);
  const refreshed = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(refreshed));
  const refreshedIds = refreshed.map(item => String(field(item, 'id'))).join(',');
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', refreshedIds, '--rationale', 'The updated greeting source still covers R1.');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'reason')), /^optimizer: next action execute: /);
  writeFileSync(join(project, 'other.mjs'), 'export {};\n');
  assert.deepEqual(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, unverified, 'at most three consecutive blocks');
  const final = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(final));
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', final.map(item => String(field(item, 'id'))).join(','), '--rationale', 'The greeting source still covers R1.');
  assert.equal(field(optimizer('verify', '--session', sessionId), 'action', 'kind'), 'complete');
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, undefined);
  assert.match(String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next task' }).output, 'hookSpecificOutput', 'additionalContext')), /no open goal contract/);
});

test('hook infrastructure errors fail open with one stderr line', t => {
  const { project, checker, optimizer } = setup(t);
  optimizer('enable', '--check', `node ${checker}`);
  const result = spawnSync(process.execPath, [hookScript], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Edit', tool_input: { file_path: join(project, 'a') } }),
    env: { ...process.env, OPTIMIZER_BIN: '/optimizer-does-not-exist' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^optimizer-claude-hook: .+\n$/);
  const malformed = spawnSync(process.execPath, [hookScript], { encoding: 'utf8', input: 'not json' });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
});

test('installer merges idempotently, keeps unrelated settings and uninstalls only its entries', t => {
  const { directory, bin } = setup(t);
  const settings = join(directory, 'claude', 'settings.json');
  mkdirSync(join(directory, 'claude'));
  const original = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk check' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'headroom start' }] }],
    },
  };
  writeFileSync(settings, JSON.stringify(original));
  const install = () => {
    const result = spawnSync(process.execPath, [hookScript, 'install', '--settings', settings], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(settings, 'utf8')) as unknown;
  };
  const command = `OPTIMIZER_BIN='${bin}' '${process.execPath}' '${hookScript}'`;
  const ours = { hooks: [{ type: 'command', command }] };
  const expected = {
    model: 'opus',
    hooks: {
      PreToolUse: [original.hooks.PreToolUse[0], { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', ...ours }],
      SessionStart: original.hooks.SessionStart,
      UserPromptSubmit: [ours],
      Stop: [ours],
    },
  };
  assert.deepEqual(install(), expected);
  assert.deepEqual(install(), expected);
  assert.deepEqual(JSON.parse(readFileSync(`${settings}.optimizer-backup`, 'utf8')), original);
  const uninstalled = spawnSync(process.execPath, [hookScript, 'uninstall', '--settings', settings], { encoding: 'utf8' });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), original);
  const missing = join(directory, 'absent', 'settings.json');
  const noFile = spawnSync(process.execPath, [hookScript, 'uninstall', '--settings', missing], { encoding: 'utf8' });
  assert.equal(noFile.status, 0, noFile.stderr);
  assert.equal(existsSync(join(directory, 'absent')), false);
  writeFileSync(settings, '[]');
  const invalid = spawnSync(process.execPath, [hookScript, 'install', '--settings', settings], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin } });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /JSON object/);
});
