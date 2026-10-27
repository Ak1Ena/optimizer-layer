import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// Enabling and disabling need user proof (an interactive terminal or an approval prompt); fixtures act as the user in-process.
import { disableProject, enableProject } from '../../runtime/src/project.ts';
import { optimizerHookOnly } from '../../runtime/src/bash.ts';
import { hookOnly } from '../src/bash-guard.ts';

const hookScript = fileURLToPath(new URL('../src/claude-hook.ts', import.meta.url));
const runtimeCli = fileURLToPath(new URL('../../runtime/src/cli.ts', import.meta.url));
// Hooks and the runtime write a global project registry; keep it, and ~/.claude, away from the real home.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-hook-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_DISABLED;
delete process.env.OPTIMIZER_MODE;
delete process.env.CLAUDE_PROJECT_DIR;
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
  const { project, hook } = setup(t);
  for (const event of events(project)) assert.deepEqual(hook(event, project, { OPTIMIZER_DISABLED: '1' }), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer')), false);
  disableProject(project);
  for (const event of events(project)) assert.deepEqual(hook(event), { output: undefined, stderr: '' });
  assert.equal(existsSync(join(project, '.optimizer', 'prompts.jsonl')), false);
  const enableAttempt = hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'optimizer enable --project .' } }).output;
  assert.equal(field(enableAttempt, 'hookSpecificOutput', 'permissionDecision'), 'deny', 'the agent cannot re-enable an opted-out project');
});

test('an unrecognised install mode marker fails closed to opt-in', t => {
  const { project, hook } = setup(t);
  for (const event of events(project)) assert.equal(hook(event, project, { OPTIMIZER_MODE: 'opt_in' }).output, undefined);
  assert.equal(existsSync(join(project, '.optimizer')), false, 'a typo in the marker must not capture everywhere');
});

test('opt-in mode leaves a folder the user has not enabled untouched, then runs end to end once enabled', t => {
  const { project, checker, optimizer, hook } = setup(t);
  mkdirSync(join(project, '.git', 'info'), { recursive: true });
  const optIn = { OPTIMIZER_MODE: 'opt-in' };
  const unspawnable = { ...optIn, OPTIMIZER_BIN: '/optimizer-does-not-exist' };
  const record = join(home, 'config', 'optimizer-layer', 'projects', `${createHash('sha256').update(project).digest('hex')}.json`);
  const registry = join(home, 'config', 'optimizer-layer', 'projects.json');
  const untouched = () => {
    assert.equal(existsSync(join(project, '.optimizer')), false);
    assert.equal(existsSync(record), false);
    assert.equal(existsSync(join(project, '.git', 'info', 'exclude')), false);
    assert.doesNotMatch(existsSync(registry) ? readFileSync(registry, 'utf8') : '', new RegExp(project));
  };
  for (const event of [...events(project), { hook_event_name: 'SubagentStart', agent_id: 'a0', agent_type: 'Explore' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }]) {
    assert.deepEqual(hook(event, project, unspawnable), { output: undefined, stderr: '' }, String(event.hook_event_name));
  }
  untouched();
  const bash = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, project, unspawnable).output;
  assert.equal(field(bash('optimizer enable --project .'), 'hookSpecificOutput', 'permissionDecision'), 'deny', 'the agent cannot enable a folder itself');
  for (const spliced of ['optimizer ena""ble --project .', "optimizer 'dis'able", 'optimizer pro\\mpt --file f']) {
    assert.equal(field(bash(spliced), 'hookSpecificOutput', 'permissionDecision'), 'deny', spliced);
  }
  untouched();

  enableProject(project, { commands: [], timeoutMs: 30_000, yes: false });
  const prompt = (cwd = project) => hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, cwd, optIn).output;
  assert.equal(prompt(), undefined, 'an idle project injects nothing');
  mkdirSync(join(project, 'src'));
  assert.equal(prompt(join(project, 'src')), undefined);
  assert.equal(readFileSync(join(project, '.optimizer', 'prompts.jsonl'), 'utf8').trim().split('\n').length, 2, 'a subfolder session captures into the enabled root');
  assert.equal(existsSync(join(project, 'src', '.optimizer')), false);
  const code = String(field(optimizer('propose-check', '--check', `node ${checker}`), 'code'));
  const approved = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: `approve check ${code}` }, project, optIn).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(approved, /user approved the proposed check commands/);
  // An agent-started contract in a managed project keeps the latest captured prompt ('hi') verbatim.
  writeFileSync(join(project, 'goal.md'), '- R1: hi\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(project, 'goal.md'));
  assert.equal(field(hook(edit(join(project, 'greeting.mjs')), project, optIn).output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.match(String(field(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, project, optIn).output, 'hookSpecificOutput', 'additionalContext')), /active optimizer session/);
  assert.equal(field(hook({ hook_event_name: 'Stop' }, project, optIn).output, 'decision'), 'block');
});

test('opt-in mode ignores a record that always-on hooks created on first use', t => {
  const { project, hook } = setup(t);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, project, { OPTIMIZER_MODE: 'opt-in' }).output, undefined);
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

test('the hook Bash guard and the runtime classifier agree on hook-only subcommands', () => {
  assert.deepEqual([...hookOnly].sort(), [...optimizerHookOnly].sort());
});

test('the spawn-free Bash guard denies optimizer hook-only invocations and state access, not ordinary commands', t => {
  const { project, hook } = setup(t);
  const bash = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, project, { OPTIMIZER_BIN: '/optimizer-does-not-exist' }).output;
  // False positives of the old substring guard: repo paths, prompt files, $PATH, $? and unrelated dynamic commands.
  for (const command of [
    'echo $?', 'npm test; echo "exit $?"', 'env PATH=/opt/node/bin:$PATH npm test', 'printf x > prompt.txt',
    'cd /home/u/code/optimizer-layer && cat prompt.txt', 'node /home/u/optimizer-layer/scripts/demo.mjs --prompt-file prompt.txt',
    'grep -rn enable /home/u/optimizer-layer/packages/runtime/src/cli.ts', 'cat packages/runtime/src/cli.ts | grep prompt',
    'optimizer status --project /p --session S', 'cat packages/adapter/src/claude-hook.ts',
    'for f in *.ts; do wc -l "$f"; done', 'X=$(git rev-parse HEAD); echo "$X"', 'bash -c "$CMD"', 'ls | xargs grep -l TODO',
    '[ -f prompt.txt ] && cat prompt.txt', 'sh -c "npm test && echo ok"', 'bash scripts/setup.sh', 'ls ~/code/optimizer-layer/packages',
    // Here-document bodies fed to a non-interpreter are data; `npm run` beside a permitted optimizer call is fine.
    "git commit -m \"$(cat <<'EOF'\nfix optimizer prompt handling\nEOF\n)\"", "cat <<'EOF' > notes.md\nrun optimizer prompt docs\nEOF\nnpm test",
    'cat .optimizer/drafts/*.md', 'rm -rf dist/*', 'optimizer check --project . --session S --check c1 && npm run build',
    'optimizer resolve --project . --session S --question Q1 --source prompt:abc',
  ]) {
    assert.equal(bash(command), undefined, command);
  }
  // Bypasses: wrappers, separators, splices, escapes, variables, substitutions, eval, piped shells, xargs, globs, the hook itself.
  for (const command of [
    'optimizer run --project . --prompt-file p', 'optimizer start-from-prompt --prompt 1', 'optimizer blocked --reason x',
    'npx optimizer enable', 'npx @optimizer-layer/runtime enable', 'env -i optimizer disable', 'command optimizer enable', 'timeout 5 optimizer enable',
    'node node_modules/@optimizer-layer/runtime/dist/cli.js disable', 'true || optimizer enable', 'echo | optimizer enable', 'true\noptimizer enable',
    '(optimizer enable)', 'sh -c "optimizer enable"', "bash -lc 'optimizer disable'", 'env -S "optimizer enable"', 'eval "optimizer enable"',
    'o""ptimizer enable', 'optim\\izer enable', "$'\\x6fptimizer' enable", '$(which optimizer) enable', '`which optimizer` enable', '$X enable',
    'X=optim; Y=izer; Z=ena; W=ble; $X$Y $Z$W', 'X="optimizer enable"; $X', 'X=enable; optimizer "$X"', '$(printf optimizer) status',
    'echo b3B0aW1pemVyIGVuYWJsZQ== | base64 -d | sh', 'echo enable | xargs optimizer', "echo 'optimizer enable' | xargs sh -c",
    '/usr/local/bin/o?timizer enable', 'find . -exec optimizer enable \\;', 'echo "$(optimizer enable)"',
    'cat ~/.config/optimizer-layer/projects/x.json', "cat $'\\x2eoptimizer/project.json'", 'node packages/adapter/src/claude-hook.ts',
    // Interpreter program strings, renames and aliases, script files: an optimizer name plus a hook-only word anywhere.
    `python3 -c "import subprocess;subprocess.run(['optimizer','enable'])"`, `perl -e 'system("optimizer enable")'`,
    `node -e "require('child_process').execSync('optimizer enable')"`, `python3 -c "import os;os.system('optimizer enable')"`,
    'ln -s $(command -v optimizer) /tmp/o; /tmp/o enable', 'cp $(which optimizer) /tmp/o && /tmp/o disable', 'alias o=optimizer; o enable',
    'printf %s optimizer | xargs -I{} {} enable', "printf 'optimizer enable' > x.sh; sh x.sh", "echo 'optimizer enable' > x.sh && bash x.sh",
    // Here-documents fed to a shell or interpreter are still read.
    'sh <<EOF\noptimizer enable\nEOF', "bash <<'EOF'\nX=optim; Y=izer; $X$Y disable\nEOF", 'python3 - <<EOF\nimport os; os.system("optimizer enable")\nEOF',
    // Globs and brace lists that can expand to optimizer state.
    'cat .opt*/project.json', 'cat .{opti,x}mizer/project.json', 'rm -rf $HOME/.opt*', 'cat ~/.config/optimizer-*/projects/x.json', 'cat .optimizer/dr*/x',
  ]) {
    assert.deepEqual(bash(command), deny('optimizer: prompt capture, project enablement and runtime state belong to the user and the Claude Code hook.'), command);
  }
});

test('a committed .optimizer/project.json neither disables the hooks nor supplies checks', t => {
  const { project, hook } = setup(t);
  mkdirSync(join(project, '.optimizer'));
  writeFileSync(join(project, '.optimizer', 'project.json'), JSON.stringify({
    projectRoot: project, enabled: false, hookToken: 'a'.repeat(64), activeSessionId: null, pendingChecks: null,
    checks: [{ id: 'check-1', requirementIds: ['*'], argv: ['/bin/sh', '-c', 'echo pwned'], timeoutMs: 1000, artifacts: [] }],
  }));
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }).output, undefined, 'the planted record supplies no checks, so nothing is injected');
  const store = join(home, 'config', 'optimizer-layer', 'projects', 'x.json');
  assert.equal(field(hook(edit(store)).output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.equal(field(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${store}` } }).output, 'hookSpecificOutput', 'permissionDecision'), 'deny');
});

test('any folder is a project: the nearest .optimizer ancestor, else cwd, never the filesystem root', t => {
  const { project, hook } = setup(t);
  const deep = join(project, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  // Idle prompts inject nothing, so the root shows in where the prompt was captured.
  const rows = (root: string) => existsSync(join(root, '.optimizer', 'prompts.jsonl')) ? readFileSync(join(root, '.optimizer', 'prompts.jsonl'), 'utf8').trim().split('\n').length : 0;
  const prompt = (cwd: string) => assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, cwd).output, undefined);
  prompt(deep);
  assert.equal(rows(deep), 1);
  prompt(join(project, 'src'));
  assert.deepEqual([rows(join(project, 'src')), rows(deep)], [1, 1], 'a parent without .optimizer/ is not an ancestor match');
  prompt(join(deep, 'x', '..'));
  assert.equal(rows(deep), 2);
  mkdirSync(join(deep, '.optimizer', 'drafts'), { recursive: true });
  prompt(join(deep, '.optimizer', 'drafts'));
  assert.equal(rows(deep), 3, 'never a path inside .optimizer/');
  mkdirSync(join(deep, 'child'));
  prompt(join(deep, 'child'));
  assert.equal(rows(deep), 4);
  assert.equal(existsSync(join(deep, 'child', '.optimizer')), false);
  assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, '/'), { output: undefined, stderr: '' });
});

test('hooks capture prompts, approve checks by code, gate edits by contract action and guard Stop without looping', t => {
  const { project, checker, optimizer, hook } = setup(t);
  const first = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'greeting should greet by name' }).output;
  assert.equal(first, undefined, 'no session, proposal or checkpoint: the prompt is captured silently');
  assert.match(readFileSync(join(project, '.optimizer', 'prompts.jsonl'), 'utf8'), /"content":"greeting should greet by name".*"capturedBy":"hook"/);
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined, 'no task started, so edits go through');
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


  const proposal = optimizer('propose-check', '--check', `node ${checker}`);
  const code = String(field(proposal, 'code'));
  const argv = field(proposal, 'checks');
  assert.ok(Array.isArray(argv));
  const pending = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'greeting returns a personalized greeting.' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.ok(pending.includes(`Pending check proposal (argv, run without a shell):\n  ${JSON.stringify(field(argv[0], 'argv'))}\nThe user approves it by replying with \`approve check ${code}\``), pending);
  assert.doesNotMatch(pending, /approved the proposed check/);
  const approved = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: `approve check ${code}` }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(approved, /user approved the proposed check commands/);
  assert.doesNotMatch(approved, /Pending check proposal/);
  assert.equal(hook(edit(join(project, '.optimizer', 'drafts', 'goal.md'))).output, undefined, 'drafts never start a contract');
  assert.equal(hook(edit('/somewhere/else.txt')).output, undefined, 'edits outside the project are not gated');
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).output, undefined);
  assert.equal(hook({ hook_event_name: 'Stop' }).output, undefined);
  assert.equal(hook({ hook_event_name: 'SubagentStart', agent_id: 'a0', agent_type: 'Explore' }).output, undefined, 'no session, no subagent context');

  const draft = join(project, '.optimizer', 'drafts', 'goal.md');
  mkdirSync(join(project, '.optimizer', 'drafts'));
  writeFileSync(draft, '- R1: greeting returns a personalized greeting.\nAcceptance R1: greeting of Ada returns Hello Ada.\nQuestion human Q1: Which greeting language is required?\n');
  const sessionId = field(optimizer('start', '--request', draft), 'id');
  assert.ok(typeof sessionId === 'string');
  const subagent = String(field(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(subagent, new RegExp(`active optimizer session ${sessionId}[\\s\\S]*phase contract-proposed[\\s\\S]*R1[\\s\\S]*Current decision: ASK_HUMAN[\\s\\S]*not user decisions`));
  const clarifyReason = 'Critical human decisions need answers with source references';
  const denied = hook(edit(join(project, 'greeting.mjs'))).output;
  assert.match(String(field(denied, 'hookSpecificOutput', 'permissionDecisionReason')), new RegExp(`^optimizer: ASK_HUMAN: ${clarifyReason}`), 'implementation before the contract is settled is denied (§10 case 1)');
  assert.deepEqual(hook({ hook_event_name: 'Stop' }).output, { systemMessage: `optimizer: waiting on the user (Q1): ${clarifyReason}` });

  const answer = hook({ hook_event_name: 'UserPromptSubmit', prompt: 'English: Hello NAME.' }).output;
  const answerContext = String(field(answer, 'hookSpecificOutput', 'additionalContext'));
  const answerId = /prompt:([0-9a-f-]{36})/.exec(answerContext)?.[1];
  assert.ok(answerId);
  assert.match(answerContext, new RegExp(`Active optimizer session ${sessionId}, phase contract-proposed[\\s\\S]*Q1 \\(human\\)[\\s\\S]*Decision ASK_HUMAN \\(required by human\\)[\\s\\S]*--source prompt:${answerId}`));
  optimizer('resolve', '--session', sessionId, '--question', 'Q1', '--source', `prompt:${answerId}`);
  assert.match(String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason')), /^optimizer: RETRIEVE_CONTEXT: [\s\S]*Phase context-check\. Next checkpoint \(RETRIEVE_CONTEXT\): Run `optimizer retrieve`/);

  const items = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(items));
  const ids = items.map(item => String(field(item, 'id'))).join(',');
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', ids, '--rationale', 'The greeting source and captured user decision cover R1.');
  const version = field(optimizer('status', '--session', sessionId), 'state', 'goal', 'version');
  optimizer('review', '--session', sessionId, '--kind', 'accept', '--version', String(version), '--items', ids, '--rationale', 'R1 and its acceptance preserve the request.');
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined);

  const blocked = hook({ hook_event_name: 'Stop', stop_hook_active: false }).output;
  assert.equal(field(blocked, 'decision'), 'block');
  assert.match(String(field(blocked, 'reason')), /^optimizer: task not verified \(phase executing\)\. Decision PROCEED: /);
  writeFileSync(join(project, '.optimizer', 'hook-state.json'), '{corrupt');
  assert.equal(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, 'decision'), 'block', 'corrupt loop-guard state starts a fresh count');
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = name => `Hello ${name}`;\n');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'reason')), /Decision (RETRIEVE_CONTEXT|INVESTIGATE): /, 'changed state blocks again');
  const refreshed = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(refreshed));
  const refreshedIds = refreshed.map(item => String(field(item, 'id'))).join(',');
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', refreshedIds, '--rationale', 'The updated greeting source still covers R1.');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'reason')), /Decision PROCEED: /);
  writeFileSync(join(project, 'other.mjs'), 'export {};\n');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'systemMessage')), /is BLOCKED and unverified, not complete/, 'at most three consecutive blocks');
  assert.equal(field(optimizer('decide', '--session', sessionId), 'phase'), 'blocked');
  const final = field(optimizer('retrieve', '--session', sessionId), 'items');
  assert.ok(Array.isArray(final));
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--items', final.map(item => String(field(item, 'id'))).join(','), '--rationale', 'The greeting source still covers R1.');
  const verified = optimizer('verify', '--session', sessionId);
  assert.equal(field(verified, 'outcome'), 'VERIFIED');
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, undefined);
  const unspawnable = { OPTIMIZER_BIN: '/optimizer-does-not-exist' };
  const released = hook(edit(join(project, 'greeting.mjs')), project, unspawnable);
  assert.equal(field(released.output, 'hookSpecificOutput', 'permissionDecision'), 'deny', 'a managed project fails closed even after its pointer is released');
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next task' }).output, undefined, 'idle again: nothing injected');
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined, 'the next task gets its own light-tier contract, so the edit is allowed at once');
  assert.match(String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and?' }).output, 'hookSpecificOutput', 'additionalContext')), /^optimizer: light-tier session session-\S+ is open\. Edit with normal tools, then run `optimizer verify`/);
});

test('a Stop budget that cannot be recorded as blocked blocks once more with the reason, then stops unverified', t => {
  const { directory, project, checker, optimizer, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
  writeFileSync(join(directory, 'goal.md'), '- R1: greeting works.\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(directory, 'goal.md'));
  // Every runtime command works except recording the block.
  const failing = join(directory, 'optimizer-failing');
  writeFileSync(failing, `#!/bin/sh\n[ "$1" = blocked ] && exit 3\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runtimeCli)} "$@"\n`);
  chmodSync(failing, 0o755);
  const env = { OPTIMIZER_BIN: failing };
  assert.equal(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }, project, env).output, 'decision'), 'block');
  const retried = hook({ hook_event_name: 'Stop', stop_hook_active: true }, project, env).output;
  assert.equal(field(retried, 'decision'), 'block');
  assert.match(String(field(retried, 'reason')), /could not record it as blocked[\s\S]*BLOCKED and unverified/);
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }, project, env).output, 'systemMessage')), /BLOCKED and unverified, not complete; the optimizer could not record the block/);
});

test('V2: a nested bare .optimizer cannot shadow a tracked root, and a managed project denies when the runtime fails', t => {
  const { directory, project, checker, optimizer, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
  writeFileSync(join(directory, 'goal.md'), '- R1: greeting works.\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(directory, 'goal.md'));
  const sub = join(project, 'sub');
  mkdirSync(join(sub, '.optimizer'), { recursive: true });
  for (const target of [join(project, 'greeting.mjs'), join(sub, 'x.mjs')]) {
    assert.equal(field(hook(edit(target), sub).output, 'hookSpecificOutput', 'permissionDecision'), 'deny', target);
  }
  const bash = (command: string, cwd = project) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, cwd).output;
  assert.equal(field(bash(`optimizer init --project ${sub}`), 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.equal(field(bash('a=dis; b=able; optimizer $a$b'), 'hookSpecificOutput', 'permissionDecision'), 'deny');
  assert.equal(field(bash('git status', sub), 'hookSpecificOutput', 'permissionDecision'), 'deny', 'git runs only at the root');
  assert.equal(bash('git status'), undefined);
});

test('final pass: the cwd cannot leave a managed project, and an approve-enable prompt reaches the runtime before opt-in', t => {
  const { directory, project, checker, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
  const outsideDir = join(directory, 'outside');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(project, 'link'));
  const env = { CLAUDE_PROJECT_DIR: project };
  for (const event of [edit(join(outsideDir, 'x.txt')), edit(join(project, 'greeting.mjs')), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch x' } }]) {
    const reason = String(field(hook(event, join(project, 'link'), env).output, 'hookSpecificOutput', 'permissionDecisionReason'));
    assert.match(reason, /outside the managed project/);
  }
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(outsideDir, 'x') } }, outsideDir, env).output, undefined, 'reads are never gated');

  const other = join(directory, 'fresh');
  mkdirSync(other);
  const requested = spawnSync(process.execPath, [runtimeCli, 'enable', '--project', other], { encoding: 'utf8' });
  assert.equal(requested.status, 0, requested.stderr);
  const approval = String(field(JSON.parse(requested.stdout), 'approval'));
  const optIn = { OPTIMIZER_MODE: 'opt-in' };
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'approve enable 0000' === approval ? 'approve enable 0001' : 'approve enable 0000' }, other, optIn).output, undefined);
  const applied = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: approval }, other, optIn).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(applied, /approved `optimizer enable`/);
});

test('Stop never writes loop-guard state through a planted symlink', t => {
  const { directory, project, checker, optimizer, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
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

test('runtime unavailable inside a managed task denies protected actions and passes reads; outside a task it fails open (§10 case 7)', t => {
  const { project, checker, optimizer, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
  const unspawnable = { OPTIMIZER_BIN: '/optimizer-does-not-exist' };
  const outside = hook(edit(join(project, 'greeting.mjs')), project, unspawnable);
  assert.equal(field(outside.output, 'hookSpecificOutput', 'permissionDecision'), 'deny', 'a managed project fails closed even before a task starts');
  writeFileSync(join(project, 'goal.md'), '- R1: greeting works.\nAcceptance R1: greeting returns hello.\n');
  optimizer('start', '--request', join(project, 'goal.md'));
  for (const event of [edit(join(project, 'a')), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm greeting.mjs' } }]) {
    assert.match(String(field(hook(event, project, unspawnable).output, 'hookSpecificOutput', 'permissionDecisionReason')), /^optimizer unavailable: a managed task is active/);
  }
  for (const tool of ['Read', 'Grep', 'Glob']) {
    assert.deepEqual(hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: join(project, 'greeting.mjs'), pattern: 'x' } }, project, unspawnable), { output: undefined, stderr: '' }, tool);
  }
  const stopped = hook({ hook_event_name: 'Stop' }, project, unspawnable);
  assert.equal(stopped.output, undefined, 'Stop is not a protected action, so it fails open');
  assert.match(stopped.stderr, /^optimizer-claude-hook: .+\n$/);
  const malformed = spawnSync(process.execPath, [hookScript], { encoding: 'utf8', input: 'not json' });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
});

test('an agent that never calls the optimizer is held to an auto-started contract; read-only work is never blocked (§10 cases 2, 9, 10)', t => {
  const { project, checker, optimizer, hook } = setup(t);
  // A check timeout over the 60 s light-tier bound keeps this contract on the standard tier.
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 120_000, yes: false });
  const record = () => JSON.parse(readFileSync(join(home, 'config', 'optimizer-layer', 'projects', `${createHash('sha256').update(project).digest('hex')}.json`), 'utf8')) as Record<string, unknown>;
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'make greeting greet by name' }).output, undefined, 'an idle managed project injects nothing');

  // Case 10: reads and read-only commands start nothing and are never denied.
  const bash = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }).output;
  for (const command of ['ls', 'git status', 'cat greeting.mjs', 'rg greeting', `node ${checker}`]) assert.equal(bash(command), undefined, command);
  assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(project, 'greeting.mjs') } }).output, undefined);
  assert.equal(hook({ hook_event_name: 'Stop' }).output, undefined, 'no task, nothing to verify');
  assert.equal(record().activeSessionId, null, 'read-only work starts no session');
  assert.equal(field(optimizer('decide'), 'sessionId'), null);

  // Case 2: the first protected action auto-starts the contract from the captured prompt and is denied.
  const first = String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason'));
  const sessionId = String(record().activeSessionId);
  assert.match(sessionId, /^session-/);
  assert.match(first, new RegExp(`^optimizer: [A-Z_]+: [\\s\\S]*started goal contract ${sessionId} from the latest user prompt[\\s\\S]*Next checkpoint`));
  const status = optimizer('status', '--session', sessionId);
  assert.equal(field(status, 'state', 'goal', 'requirements', '0', 'statement'), 'make greeting greet by name', 'R1 is the prompt verbatim');
  assert.match(String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason')), /^optimizer: /);
  assert.doesNotMatch(String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason')), /started goal contract/, 'the contract starts once per prompt');
  assert.equal(record().activeSessionId, sessionId);
  assert.equal(field(bash('echo x > f'), 'hookSpecificOutput', 'permissionDecision'), 'deny', 'shell writes are protected');
  assert.equal(existsSync(join(project, 'f')), false);
  assert.equal(bash('ls'), undefined, 'reads still pass inside the task');

  // Case 9: the Stop budget ends as a recorded block, never as completion.
  assert.equal(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, 'decision'), 'block');
  const exhausted = String(field(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, 'systemMessage'));
  assert.match(exhausted, new RegExp(`task ${sessionId} is BLOCKED and unverified, not complete`));
  const decision = optimizer('decide');
  assert.equal(field(decision, 'phase'), 'blocked');
  assert.equal(field(decision, 'decision'), 'BLOCK_ACTION');
  const events = optimizer('events', '--session', sessionId);
  assert.ok(Array.isArray(events) && events.some(event => JSON.stringify(event).includes('"to":"blocked"')), 'the block is a recorded event');
  assert.match(String(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, 'systemMessage')), /BLOCKED and unverified/, 'a recorded block does not loop');
  assert.match(String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason')), /BLOCK_ACTION/);
  assert.match(String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'status?' }).output, 'hookSpecificOutput', 'additionalContext')), new RegExp(`Active optimizer session ${sessionId}, phase blocked[\\s\\S]*Decision BLOCK_ACTION`));
});

test('light tier: idle prompts inject nothing, the first edit is allowed, and the agent is asked only to verify', t => {
  const { project, checker, optimizer, hook } = setup(t);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 30_000, yes: false });
  // The goal dialect appears only when the agent must draft a contract itself.
  const noPrompt = String(field(hook(edit(join(project, 'greeting.mjs'))).output, 'hookSpecificOutput', 'permissionDecisionReason'));
  assert.match(noPrompt, /without a captured user prompt[\s\S]*\.optimizer\/drafts\/NAME\.md[\s\S]*Goal dialect/);
  assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'make greeting say hi' }), { output: undefined, stderr: '' });
  assert.equal(hook(edit(join(project, 'greeting.mjs'))).output, undefined, 'zero optimizer steps before the first edit');
  const sessionId = String(field(optimizer('current'), 'sessionId'));
  const context = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.equal(context, `optimizer: light-tier session ${sessionId} is open. Edit with normal tools, then run \`optimizer verify\` (or \`optimizer check --check CHECK_ID\`); only outcome VERIFIED completes the task. Commands take --project ${project} --session ${sessionId}.`);
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = () => "hi";\n');
  const stop = String(field(hook({ hook_event_name: 'Stop', stop_hook_active: false }).output, 'reason'));
  assert.match(stop, /Decision PROCEED: [\s\S]*Edit with normal tools, then run `optimizer verify`/);
  assert.doesNotMatch(stop, /optimizer (retrieve|assess|review)/);
  assert.equal(field(optimizer('verify', '--session', sessionId), 'outcome'), 'VERIFIED', 'stale context after the edit does not block light verification');
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: true }).output, undefined);
  assert.deepEqual(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' }), { output: undefined, stderr: '' }, 'verified: idle again');
});

test('an idle prompt is silent, but a pending check proposal is still shown', t => {
  const { checker, optimizer, hook } = setup(t);
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }).output, undefined);
  const code = String(field(optimizer('propose-check', '--check', `node ${checker}`), 'code'));
  const context = String(field(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi again' }).output, 'hookSpecificOutput', 'additionalContext'));
  assert.match(context, new RegExp(`^Pending check proposal[\\s\\S]*approve check ${code}`));
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
  const install = (...flags: string[]) => {
    const result = spawnSync(process.execPath, [hookScript, 'install', ...flags, '--settings', settings], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(settings, 'utf8')) as unknown;
  };
  const entriesFor = (command: string) => {
    const ours = { hooks: [{ type: 'command', command, timeout: 60 }] };
    return {
      model: 'opus',
      hooks: {
        PreToolUse: [original.hooks.PreToolUse[0], { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', ...ours }],
        SessionStart: [...original.hooks.SessionStart, { matcher: 'startup|resume', hooks: [{ type: 'command', command: `${command} ensure --settings '${settings}'`, timeout: 60 }] }],
        UserPromptSubmit: [ours],
        Stop: [ours],
        SubagentStart: [ours],
      },
    };
  };
  const preMode = `OPTIMIZER_BIN='${bin}' '${process.execPath}' '${hookScript}'`;
  const expected = entriesFor(`OPTIMIZER_MODE='opt-in' ${preMode}`);
  const alwaysOn = entriesFor(`OPTIMIZER_MODE='always-on' ${preMode}`);
  assert.deepEqual(install('--always-on'), alwaysOn);
  assert.deepEqual(install(), expected, 'install without --always-on switches back to opt-in');
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
  writeFileSync(settings, JSON.stringify({ ...alwaysOn, hooks: { ...alwaysOn.hooks, Stop: [] } }));
  assert.match(ensure(), /repaired/);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), alwaysOn, 'repair keeps an always-on install always-on');
  writeFileSync(settings, JSON.stringify(alwaysOn).replaceAll(`OPTIMIZER_MODE='always-on' `, `OPTIMIZER_MODE='opt_in' `));
  assert.match(ensure(), /repaired/);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), expected, 'an unknown marker repairs as opt-in');
  writeFileSync(settings, installed.replaceAll(`OPTIMIZER_MODE='opt-in' `, ''));
  assert.match(ensure(), /repaired/);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), alwaysOn, 'an install from before modes existed behaved always-on and stays so');
  const fresh = join(directory, 'fresh', 'settings.json');
  const created = spawnSync(process.execPath, [hookScript, 'ensure', '--settings', fresh], { encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin } });
  assert.equal(created.status, 0, created.stderr);
  assert.match(readFileSync(fresh, 'utf8'), /"command": "OPTIMIZER_MODE='opt-in' OPTIMIZER_BIN=/, 'a fresh install defaults to opt-in');
  writeFileSync(settings, installed);
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
  const noRuntime = join(dirname(settings), 'no-runtime.json');
  const { OPTIMIZER_BIN: _unusedBin, ...withoutBin } = process.env;
  const emptyPath = mkdtempSync(join(tmpdir(), 'optimizer-no-path-'));
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
  const withoutRuntime = spawnSync(process.execPath, [hookScript, 'install', '--settings', noRuntime], { encoding: 'utf8', env: { ...withoutBin, PATH: emptyPath } });
  assert.equal(withoutRuntime.status, 1, 'install refuses without a runtime to call');
  assert.match(withoutRuntime.stderr, /npm install -g @optimizer-layer\/runtime/);
  assert.equal(existsSync(noRuntime), false, 'a refused install writes no settings');
});
