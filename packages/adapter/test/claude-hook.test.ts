import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hookScript = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const runtimeCli = fileURLToPath(new URL('../../runtime/src/cli.ts', import.meta.url));
// Hooks and the runtime write a global project registry; keep it, and ~/.claude, away from the real home.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-hook-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_DISABLED;
test.after(() => rmSync(home, { recursive: true, force: true }));

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
  function hook(input: Record<string, unknown>, cwd = project, env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [hookScript], {
      encoding: 'utf8', input: JSON.stringify({ session_id: 'claude-1', cwd, ...input }), env: { ...process.env, OPTIMIZER_BIN: bin, ...env },
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

const events = (project: string) => [{ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, edit(join(project, 'greeting.mjs')), { hook_event_name: 'Stop' }];

test('OPTIMIZER_DISABLED and per-project opt-out make every hook silent', t => {
  const { project, optimizer, hook } = setup(t);
  for (const event of events(project)) assert.deepEqual(hook(event, project, { OPTIMIZER_DISABLED: '1' }), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer')), false);
  optimizer('disable');
  for (const event of events(project)) assert.deepEqual(hook(event), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer', 'prompts.jsonl')), false);
});

test('without an active session PreToolUse and Stop stay silent and never spawn the runtime', t => {
  const { project, hook } = setup(t);
  const unspawnable = { OPTIMIZER_BIN: '/optimizer-does-not-exist' };
  assert.deepEqual(hook(edit(join(project, 'greeting.mjs')), project, unspawnable), { output: undefined, stderr: '' });
  assert.deepEqual(hook({ hook_event_name: 'Stop' }, project, unspawnable), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer')), false);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.ok(existsSync(join(project, '.optimizer', 'prompts.jsonl')));
  assert.equal(existsSync(join(project, '.optimizer', 'project.json')), false);
  assert.deepEqual(hook(edit(join(project, 'greeting.mjs')), project, unspawnable), { output: undefined, stderr: '' });
  assert.deepEqual(hook({ hook_event_name: 'Stop', stop_hook_active: false }, project, unspawnable), { output: undefined, stderr: '' });
  assert.deepEqual(hook(edit(join(project, '.optimizer', 'project.json')), project, unspawnable).output, deny('optimizer: runtime state is written only by the optimizer runtime and hook.'));
  assert.deepEqual(hook(edit(join(project, 'sub', '.optimizer', 'project.json')), project, unspawnable).output, deny('optimizer: runtime state is written only by the optimizer runtime and hook.'), 'nested project state is protected too');
});

test('a committed .optimizer/project.json neither disables the hooks nor supplies checks', t => {
  const { project, hook } = setup(t);
  mkdirSync(join(project, '.optimizer'));
  writeFileSync(join(project, '.optimizer', 'project.json'), JSON.stringify({
    projectRoot: project, enabled: false, hookToken: 'a'.repeat(64), activeSessionId: null, pendingChecks: null,
    checks: [{ id: 'check-1', requirementIds: ['*'], argv: ['/bin/sh', '-c', 'echo pwned'], timeoutMs: 1000, artifacts: [] }],
  }));
  const context = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(context, /no approved check commands yet/);
  assert.doesNotMatch(context, /pwned/);
  const store = join(home, 'config', 'optimizer-layer', 'projects', 'x.json');
  assert.equal(field(hook(edit(store)).output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.equal(field(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${store}` } }).output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
});

test('any folder is a project: the nearest .optimizer ancestor, else cwd, never the filesystem root', t => {
  const { project, hook } = setup(t);
  const deep = join(project, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  const context = (cwd: string) => String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, cwd).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(context(deep), new RegExp(`Project ${deep} has no open optimizer goal contract`));
  assert.match(context(join(project, 'src')), new RegExp(`Project ${join(project, 'src')} has`), 'a parent without .optimizer/ is not an ancestor match');
  assert.match(context(join(deep, 'x', '..')), new RegExp(`Project ${deep} has`));
  mkdirSync(join(deep, '.optimizer', 'drafts'), { recursive: true });
  assert.match(context(join(deep, '.optimizer', 'drafts')), new RegExp(`Project ${deep} has`), 'never a path inside .optimizer/');
  mkdirSync(join(deep, 'child'));
  assert.match(context(join(deep, 'child')), new RegExp(`Project ${deep} has`));
  assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, '/'), { output: undefined, stderr: '' });
});

test('hooks capture prompts, approve checks by code, gate edits by contract action and guard Stop without looping', t => {
  const { project, checker, optimizer, hook } = setup(t);
  const first = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'greeting should greet by name' }).output;
  const context = field(first, 'hookSpecificOutput', 'additionalContext');
  assert.equal(field(first, 'hookSpecificOutput', 'hookEventName'), 'UserPromptSubmit');
  assert.ok(typeof context === 'string');
  const promptId = /prompt:([0-9a-f-]{36})/.exec(context)?.[1];
  assert.ok(promptId);
  assert.match(context, /no open optimizer goal contract; file edits are not gated[\s\S]*\.optimizer\/drafts\/NAME\.md[\s\S]*no approved check commands yet[\s\S]*optimizer propose-check --project [\s\S]*Acceptance R1:/);
  assert.match(readFileSync(join(project, '.optimizer', 'prompts.jsonl'), 'utf8'), /"content":"greeting should greet by name".*"capturedBy":"hook"/);
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined, 'no task started, so edits go through');

  const proposal = optimizer('propose-check', '--check', `node ${checker}`);
  const code = String(field(proposal, 'code'));
  const argv = field(proposal, 'checks');
  assert.ok(Array.isArray(argv));
  const pending = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'what will run?' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.ok(pending.includes(`Pending check proposal (argv, run without a shell):\n  ${JSON.stringify(field(argv[0], 'argv'))}\nThe user approves it by replying with \`approve check ${code}\``), pending);
  assert.doesNotMatch(pending, /approved the proposed check/);
  const approved = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: `approve check ${code}` }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(approved, /user approved the proposed check commands[\s\S]*Approved project checks:/);
  assert.doesNotMatch(approved, /Pending check proposal/);
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
    `optimizer propose-check --project ${project} --check 'npm test'`, 'node packages/runtime/src/cli.ts propose-check --project . --check "node t.mjs"',
  ]) {
    assert.equal(bash(command), undefined, command);
  }
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).output, undefined);
  assert.equal(hook({ hook_event_name: 'Stop' }).output, undefined);
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'a0', agent_type: 'Explore' }).output, undefined, 'no session, no subagent context');

  const draft = join(project, '.optimizer', 'drafts', 'goal.md');
  mkdirSync(join(project, '.optimizer', 'drafts'));
  writeFileSync(draft, '- R1: greeting returns a personalized greeting.\nAcceptance R1: greeting of Ada returns Hello Ada.\nQuestion human Q1: Which greeting language is required?\n');
  const sessionId = field(optimizer('start', '--request', draft), 'id');
  assert.ok(typeof sessionId === 'string');
  const subagent = String(field(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(subagent, new RegExp(`active optimizer session ${sessionId}[\\s\\S]*R1[\\s\\S]*Current next action: clarify[\\s\\S]*not user decisions`));
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
  const unspawnable = { OPTIMIZER_BIN: '/optimizer-does-not-exist' };
  assert.deepEqual(hook(edit(join(project, 'greeting.mjs')), project, unspawnable), { output: undefined, stderr: '' }, 'verified completion released the active pointer');
  assert.match(String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next task' }).output, 'hookSpecificOutput', 'additionalContext')), /no open optimizer goal contract/);
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined, 'a completed session no longer gates edits');
});

test('Stop never writes loop-guard state through a planted symlink', t => {
  const { directory, project, checker, optimizer, hook } = setup(t);
  optimizer('enable', '--check', `node ${checker}`);
  writeFileSync(join(project, 'goal.md'), '- R1: greeting works.\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(project, 'goal.md'));
  const victim = join(directory, 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(project, '.optimizer', 'hook-state.json'));
  const result = hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(result.output, undefined);
  assert.match(result.stderr, /^optimizer-claude-hook: .+\n$/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});

test('hook infrastructure errors fail open with one stderr line', t => {
  const { project, checker, optimizer } = setup(t);
  optimizer('enable', '--check', `node ${checker}`);
  writeFileSync(join(project, 'goal.md'), '- R1: greeting works.\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(project, 'goal.md'));
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
      SessionStart: [...original.hooks.SessionStart, { matcher: 'startup|resume', hooks: [{ type: 'command', command: `${command} ensure --settings '${settings}'` }] }],
      UserPromptSubmit: [ours],
      Stop: [ours],
      SubagentStart: [ours],
    },
  };
  assert.deepEqual(install(), expected);
  assert.deepEqual(install(), expected);
  const ensure = () => {
    const result = spawnSync(process.execPath, [hookScript, 'ensure', '--settings', settings], { encoding: 'utf8', input: '{"hook_event_name":"SessionStart"}', env: { ...process.env, OPTIMIZER_BIN: bin } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'SessionStart stdout would become session context');
    return result.stderr;
  };
  const installed = readFileSync(settings, 'utf8');
  assert.equal(ensure(), '');
  assert.equal(readFileSync(settings, 'utf8'), installed, 'intact entries are left byte-for-byte');
  writeFileSync(settings, JSON.stringify({ ...expected, hooks: { ...expected.hooks, Stop: [] } }));
  assert.match(ensure(), /repaired/);
  const { SubagentStart: _, ...olderInstall } = expected.hooks;
  writeFileSync(settings, JSON.stringify({ ...expected, hooks: olderInstall }));
  assert.match(ensure(), /repaired/, 'an install from before SubagentStart existed is upgraded');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), expected);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), expected);
  const moved = JSON.parse(installed.replaceAll(hookScript, '/old/place/dist/claude-hook.js')) as unknown;
  writeFileSync(settings, JSON.stringify(moved));
  assert.match(ensure(), /repaired/);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), expected, 'entries pointing to a moved path are replaced, not duplicated');
  assert.deepEqual(JSON.parse(readFileSync(`${settings}.optimizer-backup`, 'utf8')), original);
  const uninstalled = spawnSync(process.execPath, [hookScript, 'uninstall', '--settings', settings], { encoding: 'utf8' });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), original);
  const missing = join(directory, 'absent', 'settings.json');
  const noFile = spawnSync(process.execPath, [hookScript, 'uninstall', '--settings', missing], { encoding: 'utf8' });
  assert.equal(noFile.status, 0, noFile.stderr);
  assert.equal(existsSync(join(directory, 'absent')), false);
  writeFileSync(settings, '[]');
  assert.match(ensure(), /^optimizer-claude-hook: ensure: .*JSON object\n$/);
  const invalid = spawnSync(process.execPath, [hookScript, 'install', '--settings', settings], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin } });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /JSON object/);
});
