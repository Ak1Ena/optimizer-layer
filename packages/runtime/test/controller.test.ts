import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBash, decide, evaluate } from '../src/controller.ts';
import { gate, Runtime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { capturePrompt, enableProject, readProjectConfig, writeProjectConfig } from '../src/project.ts';
import { configPath } from '../src/user-store.ts';

const cli = resolve('packages/runtime/src/cli.ts');
// Per-user state must never reach the real ~/.config; spawned CLIs inherit this.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_MODE;
test.after(() => rmSync(home, { recursive: true, force: true }));

const request = 'Make parseCount throw RangeError for negative values and keep returning numbers otherwise.';
const fixed = 'export function parseCount(value) { const count = Number(value); if (count < 0) throw new RangeError("negative"); return count; }\n';

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-controller-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value) || 0; }\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { parseCount } = await import(pathToFileURL(process.argv[2] + '/counter.mjs'));
assert.equal(parseCount('2'), 2);
assert.throws(() => parseCount('-1'), RangeError);
`);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const token = readProjectConfig(project)?.hookToken ?? '';
  const promptId = `prompt:${capturePrompt(project, request, token).id}`;
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--project', project], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { status: result.status, stderr: result.stderr, value: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : null };
  };
  const accept = (id: string) => {
    const context = runtime.retrieve(id);
    const itemIds = context.items.map(item => item.id);
    runtime.assess(id, { kind: 'sufficient', itemIds, rationale: 'counter.mjs owns parseCount and the captured prompt states the requested negative-value behavior.' });
    runtime.review(id, { kind: 'accept', goalVersion: runtime.get(id).goal.version, itemIds, rationale: 'R1 is the user prompt verbatim and the approved check observes it.' });
  };
  const edit = () => gate(project, 'Edit', { file_path: join(project, 'counter.mjs') });
  return { directory, project, checker, token, promptId, runtime, run, accept, edit };
}

function transitions(runtime: Runtime, id: string) {
  return runtime.events(id).flatMap(({ event }) => event.payload.kind === 'workflow.transitioned' ? [event.payload] : []);
}

test('Bash classifier allows a deterministic read-only allowlist and protects everything else', () => {
  const check = ['/usr/local/bin/npm', 'test'];
  const cases: [string, string][] = [
    ['ls -la', 'read'], ['cat a.txt | grep x | wc -l', 'read'], ['head -n 5 a && tail b', 'read'], ['rg parseCount src 2>/dev/null', 'read'],
    ['find . -name "*.ts"', 'read'], ['git status', 'read'], ['git --no-pager diff HEAD~1', 'read'], ['git -C sub log --oneline', 'protected'],
    ['git show HEAD', 'read'], ['git branch -a', 'read'], ['pwd; which node', 'read'], ['sed -n 1,20p file.ts', 'read'],
    ['cd src && ls', 'read'], ['grep -r foo . 2>&1', 'read'], ['optimizer status --session S', 'read'], ['optimizer gate --tool Edit', 'read'],
    ['npm test', 'verification'], ['optimizer retrieve --session S', 'control'], ['optimizer verify --session S', 'control'],
    ['echo hi > out.txt', 'protected'], ['cat a >> b', 'protected'], ['ls | tee out', 'protected'], ['sed -i s/a/b/ f', 'protected'],
    ['sed s/a/b/w out f', 'protected'], ['rm -rf build', 'protected'], ['mv a b', 'protected'], ['cp a b', 'protected'],
    ['npm install left-pad', 'protected'], ['find . -delete', 'protected'], ['find . -exec rm {} ;', 'protected'],
    ['git commit -m x', 'protected'], ['git branch new-feature', 'protected'], ['git branch -D old', 'protected'], ['git diff --output=x', 'protected'],
    ['rg --pre ./evil x', 'protected'], ['echo $(rm x)', 'protected'], ['cat `x`', 'protected'], ['ls && node script.js', 'protected'],
    ['./ls', 'protected'], ['/tmp/x/cat a', 'protected'], ['python3 -c "print(1)"', 'protected'], ['some-unknown-tool', 'protected'],
    ['npm test --watch', 'protected'], ['ls & touch x', 'protected'], ['optimizer disable', 'protected'], ['optimizer prompt --file f', 'protected'],
  ];
  for (const [command, kind] of cases) assert.equal(classifyBash(command, [check]).kind, kind, command);
  assert.equal(classifyBash('optimizer enable --check x').reserved, true);
  // Reads of runtime state, the per-user store or the hook installer, and every spelling of a hook-only runtime command, are reserved.
  for (const command of [
    'cat .optimizer/runtime.sqlite', 'ls .optimizer', 'cat ~/.config/optimizer-layer/projects/abc.json', 'grep hookToken /h/.config/optimizer-layer/projects.json',
    'optimizer-claude-hook uninstall', 'node packages/runtime/src/cli.ts enable --project x', 'node /x/dist/cli.js disable', '/usr/local/bin/optimizer prompt --file f',
    'npx optimizer start-from-prompt --prompt p', 'ls; optimizer blocked --reason r', 'optimizer run --prompt-file f',
  ]) assert.deepEqual(classifyBash(command), { kind: 'protected', reserved: true }, command);
  assert.deepEqual(classifyBash('cat .optimizer/drafts/goal.md'), { kind: 'read' });
  assert.deepEqual(classifyBash('node packages/runtime/src/cli.ts status'), { kind: 'protected' });
  assert.equal(classifyBash('rm x').reserved, undefined);
});

test('Bash classifier tokenizes shell words, fails closed on splices and redirections, and allowlists flags per program', () => {
  const cases: [string, string][] = [
    // S1: quote splicing and quoted spaces inside flags.
    ['git diff --out""put=x', 'protected'], ['git diff "--output=a b"', 'protected'], ['git diff --output=x', 'protected'],
    ['find . -fpr""int x', 'protected'], ['find . -fprint x', 'protected'], ['rg --pr""e=sh foo', 'protected'], ['rg --pre=sh foo', 'protected'],
    ['rg --pre sh foo', 'protected'], ['git diff --ext-diff', 'protected'], ['git -c core.pager=sh log', 'protected'], ['git log --textconv', 'protected'],
    ['g\\it status', 'protected'], ["git sta'tus'", 'protected'], ['echo "a"b', 'protected'], ['cat "unterminated', 'protected'], ['echo "$HOME"', 'protected'],
    ['find . -name *.ts', 'protected'], ['rg foo *', 'protected'], ['ls *.ts', 'protected'], ['grep -r foo *', 'protected'],
    // S2: only exact fd duplications and /dev/null redirections are harmless.
    ['echo hi >&1evil.txt', 'protected'], ['echo hi >&2out', 'protected'], ['ls 2>&1>out', 'protected'], ['ls &>out', 'protected'], ['ls >|out', 'protected'],
    ['ls >/dev/nullx', 'protected'], ['cat <>file', 'protected'], ['cat < file', 'protected'],
    ['ls 2>&1', 'read'], ['ls >&2', 'read'], ['ls 1>&2 | wc -l', 'read'], ['ls >/dev/null', 'read'], ['ls 2>/dev/null; pwd', 'read'], ['ls 2> /dev/null', 'read'],
    // S4: sed only as `sed -n ADDRp FILE`, and no tree or file (both have output flags).
    ['sed -n 1p -i f', 'protected'], ['sed -n 1p --in-place f', 'protected'], ['sed -n 1,5p f.ts', 'read'], ['sed -n 1p', 'read'],
    ['tree -o out', 'protected'], ['tree', 'protected'], ['file -C -m x', 'protected'],
    // Allowed reads with flags, quoted separators and quoted patterns.
    ['git diff --stat HEAD~1 -- src', 'read'], ['git log -n5 --oneline --format=%h', 'read'], ['git log -5', 'read'], ['git show --name-only HEAD', 'read'],
    ['git status --porcelain=v1 -uno', 'read'], ['rg -n -g "*.ts" --type ts parseCount src', 'read'], ['rg -A3 -e foo', 'read'],
    ['find . -name "*.ts" -type f -maxdepth 2', 'read'], ['grep "a|b;c" file', 'read'], ["rg 'x$' src", 'read'], ['cat "two words.txt"', 'read'],
  ];
  for (const [command, kind] of cases) assert.equal(classifyBash(command).kind, kind, command);
  // Reserved words survive any quoting, and spliced words never reach a read classification.
  for (const command of ['optimizer ru""n --prompt-file f', "optimizer 'en'able", 'optimizer dis\\able', 'node cli.ts "prompt" --file f', 'cat .opti""mizer/runtime.sqlite']) {
    assert.deepEqual(classifyBash(command), { kind: 'protected', reserved: true }, command);
  }
});

test('V1, V2, V3, N2, N4: prototype names, nested roots, foreign git repositories and variable spellings fail closed', () => {
  const root = '/work/project';
  const at = { root, cwd: root };
  const cases: [string, string, typeof at | { root: string; cwd: string; gitSafe?: boolean }][] = [
    // V1: Object.prototype member names are not programs on the allowlist.
    ['constructor foo', 'protected', at], ['toString --x; touch pwned', 'protected', at], ['__proto__ x', 'protected', at],
    ['valueOf', 'protected', at], ['hasOwnProperty x', 'protected', at],
    // V2: optimizer commands must target the tracked root; cd stays inside it.
    ['optimizer init --project sub', 'protected', at], [`optimizer init --project=${root}/sub`, 'protected', at], ['optimizer status --session S', 'protected', at],
    [`optimizer retrieve --project ${root} --session S`, 'control', at], ['optimizer status --project . --session S', 'read', at],
    ['cd ..', 'protected', at], ['cd /tmp', 'protected', at], ['cd', 'protected', at], ['cd ~', 'protected', at], ['pushd ../x', 'protected', at],
    // V3: git only in the root's own repository.
    ['git -C evil diff', 'protected', at], ['cd evil && git log -p', 'protected', at], ['git --git-dir=evil show', 'protected', at],
    ['git --work-tree=x status', 'protected', at], ['git status', 'protected', { root, cwd: `${root}/evil` }], ['git status', 'protected', { ...at, gitSafe: false }],
    ['git status', 'read', at], ['git rev-parse --git-dir=x', 'protected', at],
    // N4 additions.
    ['grep "foo$" file', 'read', at], ['sort -n -k2 f', 'read', at], ['sort -o out f', 'protected', at], ['sort --output=out f', 'protected', at],
    ['uniq -c f', 'protected', at], ['uniq in out', 'protected', at], ['echo a | uniq - out', 'protected', at], ['uniq -- - out', 'protected', at], ['cut -d, -f1 f', 'read', at], ['tr a-z A-Z', 'read', at],
    ['git ls-files --others --exclude-standard', 'read', at], ['git rev-parse --show-toplevel', 'read', at], ['git rev-parse --abbrev-ref HEAD', 'read', at],
    ['git blame -L 1,5 f.ts', 'read', at], ['git blame --output x f', 'protected', at], ['echo "a$b"', 'protected', at],
  ];
  for (const [command, kind, context] of cases) assert.equal(classifyBash(command, [], context).kind, kind, command);
  // N2: runtime mentions the tokenizer cannot read exactly are reserved.
  for (const command of ['a=dis; b=able; optimizer $a$b', 'optimizer $(echo enable)', 'node cli.ts `x`', 'x=1 optimizer-claude-hook']) {
    assert.deepEqual(classifyBash(command, [], at), { kind: 'protected', reserved: true }, command);
  }
});

test('final pass: globs fail closed and in command position are reserved; cd follows symlinks; one --project only', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-cd-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(directory, 'outside'));
  symlinkSync(join(directory, 'outside'), join(root, 'link'));
  const at = { root, cwd: root };
  for (const command of ['/usr/bin/o?timizer disable', 'node ./c?i.ts disable', '/x/optimizer[a] enable --check true', 'X=1 /bin/{a,b}', 'ls; /x/opt*', '/p/o?timizer disable $x']) {
    assert.deepEqual(classifyBash(command, [], at), { kind: 'protected', reserved: true }, command);
  }
  for (const command of ['cat ~/.config/optimizer-la*/proj*/*.json', 'ls {a,b}', 'cat a?', 'ls [ab]', 'echo {1..3}']) {
    assert.equal(classifyBash(command, [], at).kind, 'protected', command);
  }
  for (const command of ['rg -g "*.ts" x', "find . -name '*.md'", 'git log HEAD@{1}', 'echo {x}']) {
    assert.notEqual(classifyBash(command, [], at).kind, 'protected', command);
  }
  assert.equal(classifyBash('cd src', [], at).kind, 'read');
  assert.equal(classifyBash('cd link', [], at).kind, 'protected', 'a symlink out of the project is not inside it');
  assert.equal(classifyBash('cd missing', [], at).kind, 'protected');
  assert.equal(classifyBash(`optimizer status --project ${root} --project /tmp`, [], at).kind, 'protected');
  assert.equal(classifyBash(`cd src && optimizer status --project ${root}`, [], at).kind, 'protected', 'optimizer after a cd');
  assert.equal(classifyBash(`optimizer status --project ${root}`, [], at).kind, 'read');
});

test('V1: a classifier-hostile Bash command in a managed project without a session is denied, never thrown', (t) => {
  const { project } = setup(t);
  for (const command of ['toString --x; touch pwned', 'constructor foo', '__proto__ --x']) {
    const verdict = gate(project, 'Bash', { command, cwd: project });
    assert.equal(verdict.allow, false, command);
  }
  assert.equal(gate(project, 'Bash', { command: 'git status', cwd: join(project, 'sub') }).allow, false, 'git outside the root is protected');
});

test('N1: after the contract is accepted, several edits in a row are allowed; verification still needs fresh context', (t) => {
  const { project, runtime, accept, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  for (const [file, content] of [['counter.mjs', fixed], ['helper.mjs', 'export const helper = 1;\n'], ['notes.md', 'notes\n']] as const) {
    const verdict = gate(project, 'Write', { file_path: join(project, file) });
    assert.equal(verdict.allow, true, file);
    writeFileSync(join(project, file), content);
  }
  assert.equal(gate(project, 'Bash', { command: 'rm notes.md', cwd: project }).allow, true);
  assert.equal(runtime.verify(id).outcome, 'INCONCLUSIVE', 'stale context is caught at verification');
  accept(id);
  assert.equal(runtime.verify(id).outcome, 'VERIFIED');
});

test('N3: an agent-started contract in a managed project must keep the latest captured prompt verbatim', (t) => {
  const { directory, project, run } = setup(t);
  writeFileSync(join(directory, 'own.md'), '- R1: parseCount may do anything.\nAcceptance R1: anything');
  const own = run(['start', '--request', join(directory, 'own.md')]);
  assert.equal(own.status, 1);
  assert.match(own.stderr, /keep it verbatim/);
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  writeFileSync(join(directory, 'verbatim.md'), `- R1: ${request}\nAcceptance R1: the approved checks pass.`);
  assert.equal(run(['start', '--request', join(directory, 'verbatim.md')]).status, 0);
});

test('R1: an agent-initiated start --replace cannot drop the R1 of a controller-started contract', (t) => {
  const { project, directory, runtime, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  writeFileSync(join(directory, 'weaker.md'), '- R1: parseCount may do anything.\nAcceptance R1: nothing');
  const weaker = run(['start', '--request', join(directory, 'weaker.md'), '--replace']);
  assert.equal(weaker.status, 1);
  assert.match(weaker.stderr, /keep its R1 verbatim/);
  assert.equal(readProjectConfig(project)?.activeSessionId, id);
  assert.equal(runtime.events(id).some(({ event }) => event.payload.kind === 'session.replaced'), false);
  // A replacement that keeps R1 verbatim and adds a requirement is accepted, and stays protected itself.
  writeFileSync(join(directory, 'stronger.md'), `- R1: ${request}\nAcceptance R1: the approved checks pass.\n- R2: parseCount returns 0 for an empty string.\nAcceptance R2: the approved checks pass.`);
  const stronger = run(['start', '--request', join(directory, 'stronger.md'), '--replace']);
  assert.equal(stronger.status, 0, stronger.stderr);
  const replacement = String(stronger.value?.id);
  assert.equal(runtime.get(replacement).goal.requirements[0]?.statement, request);
  assert.deepEqual(runtime.get(replacement).origin, runtime.get(id).origin);
  assert.match(run(['start', '--request', join(directory, 'weaker.md'), '--replace']).stderr, /keep its R1 verbatim/);
  assert.equal(edit().sessionId, replacement, 'the gate follows the replacement, not the replaced session');
});

test('R2: a verified session is closed: later work never reopens it and starts a new session', (t) => {
  const { project, promptId, runtime, accept, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  writeFileSync(join(project, 'counter.mjs'), fixed);
  accept(id);
  assert.equal(runtime.verify(id).outcome, 'VERIFIED');
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  const history = runtime.events(id).length;
  // A stale hook read of the old pointer must not reopen it either.
  const stale = runtime.gate({ kind: 'protected', tool: 'Edit', target: join(project, 'counter.mjs') }, id);
  const after = edit();
  assert.equal(stale.sessionId, after.sessionId);
  assert.equal(after.allow, false, 'the new session needs its own context and review');
  assert.ok(after.sessionId && after.sessionId !== id);
  assert.deepEqual(runtime.get(after.sessionId).origin, { promptId });
  assert.equal(readProjectConfig(project)?.activeSessionId, after.sessionId);
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount() { return 0; }\n');
  assert.equal(runtime.get(id).phase, 'verified');
  assert.equal(runtime.next(id).kind, 'complete');
  const closed = runtime.verify(id);
  assert.equal(closed.outcome, 'VERIFIED', 'the historical result is immutable');
  assert.deepEqual(closed.verifiedRequirementIds, ['R1']);
  assert.throws(() => runtime.runCheck(id, runtime.get(id).checks[0]?.id ?? ''), /verified and closed/);
  assert.throws(() => runtime.retrieve(id), /verified and closed/);
  assert.equal(runtime.claim(id).phase, 'verified', 'a late claim is a no-op');
  // A Stop budget or the blocked command with a stale pointer cannot move it out of verified.
  assert.equal(runtime.block(id, 'Stop budget exhausted').decision, 'COMPLETE');
  assert.equal(runtime.get(id).phase, 'verified');
  assert.equal(transitions(runtime, id).at(-1)?.to, 'verified');
  assert.equal(runtime.events(id).length, history, 'nothing is appended to a closed session; its history is preserved');
  assert.equal(run(['current']).value?.sessionId, after.sessionId);
});

test('R2: a pointer to a complete session stored as executing (older databases) is closed and released, not reused', (t) => {
  const { project, runtime, accept, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  writeFileSync(join(project, 'counter.mjs'), fixed);
  accept(id);
  assert.equal(runtime.verify(id).outcome, 'VERIFIED');
  // What the removed reopen path left behind: verified, then moved back to executing with the pointer restored.
  const store = new Store(project);
  store.update(id, () => ({ kind: 'workflow.transitioned', from: 'verified', to: 'executing', cause: 'tool-after-verification:Edit' }));
  store.close();
  const config = readProjectConfig(project);
  assert.ok(config);
  writeProjectConfig(project, { ...config, activeSessionId: id });
  const after = edit();
  assert.ok(after.sessionId && after.sessionId !== id, 'the gate starts a new session instead of reusing it');
  assert.equal(runtime.get(id).phase, 'verified');
  assert.equal(readProjectConfig(project)?.activeSessionId, after.sessionId);
});

test('§10.10 read-only work in a managed project is never denied and starts no session', (t) => {
  const { project, checker } = setup(t);
  for (const [tool, input] of [
    ['Read', { file_path: join(project, 'counter.mjs') }], ['Grep', { pattern: 'x' }], ['Glob', { pattern: '*' }], ['WebFetch', { url: 'https://example.com' }],
    ['Bash', { command: 'ls -la && git status' }], ['Bash', { command: 'rg parseCount | head' }], ['Bash', { command: `node ${checker} ${project}` }],
    ['Bash', { command: `optimizer status --project ${project} --session S` }],
  ] as const) {
    const verdict = gate(project, tool, input);
    assert.equal(verdict.allow, true, `${tool} ${JSON.stringify(input)}`);
    assert.equal(verdict.started, false);
  }
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  assert.deepEqual(new Runtime(project, { readOnly: true }).sessions(), []);
});

test('§10.2 and §10.1: the first protected action starts the contract from the captured prompt and is denied until review', (t) => {
  const { project, promptId, runtime, accept, edit } = setup(t);
  const first = edit();
  assert.equal(first.allow, false);
  assert.equal(first.started, true);
  assert.equal(first.decision, 'BLOCK_ACTION');
  assert.ok(first.sessionId);
  const id = first.sessionId;
  assert.equal(readProjectConfig(project)?.activeSessionId, id);
  const state = runtime.get(id);
  assert.deepEqual(state.origin, { promptId });
  assert.deepEqual(state.goal.requirements, [{ id: 'R1', statement: request, acceptance: 'Every user-approved project check passes against the final source.', acceptanceSource: 'project-checks', sourceLine: 1 }]);
  assert.deepEqual(state.checks.map(check => check.requirementIds), [['R1']]);
  assert.ok(state.context, 'context retrieval ran automatically');
  assert.ok(state.decisions.some(item => item.id === promptId), 'the prompt keeps its provenance');
  // Idempotent per prompt: the same session comes back, with no second start.
  const again = edit();
  assert.equal(again.started, false);
  assert.equal(again.sessionId, id);
  assert.equal(runtime.startFromPrompt(promptId).created, false);
  assert.equal(runtime.sessions().length, 1);
  assert.equal(gate(project, 'Bash', { command: "sed -i 's/0/1/' counter.mjs" }).allow, false);
  const phases = transitions(runtime, id);
  assert.deepEqual(phases[0], { kind: 'workflow.transitioned', from: null, to: 'requested', cause: 'controller-started' });
  assert.equal(runtime.get(id).phase, phases.at(-1)?.to, 'the current phase replays from events');
  // §10.1: assessed context but no accepted review still denies implementation.
  const context = runtime.retrieve(id);
  runtime.assess(id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'counter.mjs owns parseCount and the prompt states the behavior.' });
  const beforeReview = edit();
  assert.equal(beforeReview.allow, false);
  assert.match(beforeReview.reason, /^REVIEW_CONTRACT/);
  assert.equal(runtime.decide(id).phase, 'under-review');
  accept(id);
  const allowed = edit();
  assert.equal(allowed.allow, true);
  assert.equal(allowed.decision, 'PROCEED');
  assert.deepEqual(transitions(runtime, id).at(-1), { kind: 'workflow.transitioned', from: 'ready', to: 'executing', cause: 'tool:Edit' });
});

test('§10.3 a completion claim without passing verification is never VERIFIED', (t) => {
  const { project, runtime, accept, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  runtime.claim(id);
  const failed = runtime.verify(id);
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.phase, 'recovery');
  writeFileSync(join(project, 'counter.mjs'), fixed);
  const stale = run(['verify', '--session', id]);
  assert.equal(stale.status, 1);
  assert.equal(stale.value?.outcome, 'INCONCLUSIVE', 'edits after the reviewed context need a fresh checkpoint');
  accept(id);
  const verified = runtime.verify(id);
  assert.equal(verified.outcome, 'VERIFIED');
  assert.equal(verified.phase, 'verified');
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  const human = runtime.start({ request: '- R1: parseCount handles negatives.\nAcceptance R1: the check passes.\nQuestion human Q1: Throw or clamp?' });
  runtime.claim(human.id);
  assert.equal(runtime.verify(human.id).outcome, 'NEEDS_HUMAN_REVIEW');
});

test('§10.4 and §10.9: repeated failures pause, reconsideration resumes, exhausted budgets block instead of completing', (t) => {
  const { runtime, accept, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  const failThrice = () => { for (let attempt = 0; attempt < 3; attempt++) runtime.runCheck(id, 'check-1'); };
  failThrice();
  assert.deepEqual([runtime.decide(id).decision, runtime.decide(id).phase], ['REQUEST_RECONSIDERATION', 'reconsidering']);
  assert.equal(edit().allow, false);
  runtime.reconsider(id, { strategy: 'revise', rationale: 'The check shows the negative guard is missing; add a RangeError branch.' });
  assert.deepEqual([runtime.decide(id).decision, runtime.decide(id).phase], ['PROCEED', 'executing']);
  failThrice();
  runtime.reconsider(id, { strategy: 'retain', rationale: 'Retain the approach; the guard is still the missing piece.' });
  failThrice();
  const blocked = runtime.decide(id);
  assert.deepEqual([blocked.decision, blocked.phase, blocked.needsHuman], ['ASK_HUMAN', 'blocked', true]);
  assert.equal(runtime.get(id).phase, 'blocked');
  assert.notEqual(runtime.verify(id).outcome, 'VERIFIED');
  assert.equal(edit().allow, false);
});

test('§10.9 an exhausted Stop budget is recorded as blocked by the hook only and resumes through a checkpoint', (t) => {
  const { runtime, token, accept, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  assert.match(run(['blocked', '--reason', 'Stop budget exhausted']).stderr, /hook token/);
  const blocked = run(['blocked', '--reason', 'Stop budget exhausted'], { OPTIMIZER_HOOK_TOKEN: token });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.deepEqual([blocked.value?.decision, blocked.value?.phase], ['BLOCK_ACTION', 'blocked']);
  assert.deepEqual(transitions(runtime, id).at(-1), { kind: 'workflow.transitioned', from: 'ready', to: 'blocked', cause: 'Stop budget exhausted' });
  assert.equal(edit().allow, false);
  assert.equal(run(['decide']).value?.decision, 'BLOCK_ACTION');
  runtime.runCheck(id, 'check-1');
  assert.equal(runtime.decide(id).phase, 'recovery');
  assert.equal(edit().allow, true);
});

test('§10.5 a valid technical challenge advances the contract version and preserves R1', (t) => {
  const { runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const before = runtime.get(id);
  const context = runtime.retrieve(id);
  const itemIds = context.items.map(item => item.id);
  runtime.assess(id, { kind: 'sufficient', itemIds, rationale: 'counter.mjs owns parseCount.' });
  const challenged = runtime.review(id, { kind: 'challenge', goalVersion: runtime.get(id).goal.version, itemIds, requirementId: 'R1', owner: 'local', rationale: 'Number("") is 0; does an empty string count as a nonnegative number?' });
  assert.ok(challenged.goal.version > before.goal.version);
  assert.deepEqual(challenged.goal.requirements, before.goal.requirements);
  assert.ok(challenged.goal.uncertainties.some(item => item.id === 'review:1' && item.resolution.kind === 'open'));
  assert.equal(runtime.decide(id).decision, 'INVESTIGATE');
});

test('§10.6 agent-reachable CLI paths and file edits cannot change goal or verification records', (t) => {
  const { directory, project, runtime, accept, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  const requirements = runtime.get(id).goal.requirements;
  assert.match(run(['resolve', '--session', id, '--question', 'acceptance:R1', '--source', 'x', '--answer', 'anything']).stderr, /Unknown uncertainty/);
  // Inputs live outside the project: any project file change makes the reviewed context stale.
  writeFileSync(join(directory, 'checks.json'), JSON.stringify([{ id: 'mine', requirementIds: ['R1'], argv: ['/usr/bin/true'], timeoutMs: 1000 }]));
  writeFileSync(join(directory, 'goal.md'), '- R1: nothing\nAcceptance R1: true exits 0');
  assert.match(run(['start', '--request', join(directory, 'goal.md'), '--checks', join(directory, 'checks.json'), '--replace']).stderr, /only from user approval/);
  assert.match(run(['start-from-prompt', '--prompt', 'prompt:x']).stderr, /hook token/);
  assert.match(run(['blocked', '--reason', 'x']).stderr, /hook token/);
  for (const [tool, input] of [
    ['Edit', { file_path: join(project, '.optimizer', 'runtime.sqlite') }],
    ['Write', { file_path: join(project, '.optimizer', 'prompts.jsonl') }],
    ['Write', { file_path: configPath(project) }],
    ['Bash', { command: 'rm .optimizer/runtime.sqlite' }],
    ['Bash', { command: `optimizer disable --project ${project}` }],
  ] as const) {
    const verdict = gate(project, tool, input);
    assert.equal(verdict.allow, false, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(edit().allow, true, 'ordinary source edits stay allowed while executing');
  assert.equal(gate(project, 'Write', { file_path: join(project, '.optimizer', 'drafts', 'goal.md') }).allow, true);
  assert.deepEqual(runtime.get(id).goal.requirements, requirements);
  assert.equal(readProjectConfig(project)?.activeSessionId, id);
});

test('§10.8 concurrent projects keep independent sessions, phases and blocks', (t) => {
  const a = setup(t);
  const b = setup(t);
  const sessionA = a.edit().sessionId;
  assert.ok(sessionA);
  assert.equal(readProjectConfig(b.project)?.activeSessionId, null);
  a.runtime.block(sessionA, 'Stop budget exhausted');
  const sessionB = b.edit().sessionId;
  assert.ok(sessionB && sessionB !== sessionA);
  assert.notEqual(b.runtime.decide(sessionB).phase, 'blocked');
  assert.deepEqual(a.runtime.sessions(), [sessionA]);
  assert.deepEqual(b.runtime.sessions(), [sessionB]);
  assert.throws(() => a.runtime.get(sessionB), /Unknown session/);
});

test('§10.7 a runtime failure inside a managed task fails closed for protected actions only', (t) => {
  const { project, edit } = setup(t);
  assert.ok(edit().sessionId);
  const database = join(project, '.optimizer', 'runtime.sqlite');
  renameSync(database, `${database}.moved`);
  symlinkSync(`${database}.moved`, database);
  const denied = edit();
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /optimizer unavailable/);
  assert.equal(gate(project, 'Read', { file_path: join(project, 'counter.mjs') }).allow, true);
  assert.equal(gate(project, 'Bash', { command: 'git status' }).allow, true);
  const config = readProjectConfig(project);
  assert.ok(config);
  writeFileSync(configPath(project), JSON.stringify({ ...config, activeSessionId: null }));
  assert.equal(edit().allow, false, 'a managed project fails closed even before a task starts');
  writeFileSync(configPath(project), JSON.stringify({ ...config, activeSessionId: null, checks: [] }));
  assert.equal(edit().allow, true, 'an unmanaged project fails open');
  t.after(() => rmSync(database, { force: true }));
});

test('sessions persisted before workflow phases replay and record their first transition', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-legacy-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new Runtime(directory).close();
  const body = JSON.stringify({ version: 1, id: 'start', sessionId: 'legacy', producer: 'runtime', at: '2026-10-26T00:00:00Z', payload: {
    kind: 'session.started', state: {
      id: 'legacy', goal: { request: 'greeting returns Hello', requirements: [{ id: 'R1', statement: 'greeting returns Hello', acceptance: 'greeting() is Hello', sourceLine: 1 }], uncertainties: [] },
      checks: [], decisions: [], context: null, assessment: null, control: { kind: 'running', rounds: 0 }, evidence: [], failureStreak: { signature: '', count: 0 }, completionClaimed: false,
    },
  } });
  const database = new DatabaseSync(join(directory, '.optimizer', 'runtime.sqlite'));
  database.prepare('INSERT INTO events(session_id, producer, event_id, digest, body) VALUES(?,?,?,?,?)').run('legacy', 'runtime', 'start', createHash('sha256').update(body).digest('hex'), body);
  database.close();
  const runtime = new Runtime(directory);
  t.after(() => runtime.close());
  assert.equal(runtime.get('legacy').phase, undefined);
  assert.deepEqual([runtime.decide('legacy').decision, runtime.decide('legacy').phase], ['RETRIEVE_CONTEXT', 'context-check']);
  runtime.claim('legacy');
  assert.deepEqual(transitions(runtime, 'legacy'), [{ kind: 'workflow.transitioned', from: null, to: 'context-check', cause: 'completion.claimed' }]);
  assert.equal(runtime.next('legacy').kind, 'retrieve', 'nextAction stays backward compatible');
});

test('gate and decide overhead is measured and in-process evaluation is sub-millisecond', (t) => {
  const { directory, project, runtime, accept, edit, run } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  const state = runtime.get(id);
  const action = { kind: 'protected' as const, tool: 'Edit', target: join(project, 'counter.mjs') };
  const iterations = 10_000;
  let started = performance.now();
  for (let index = 0; index < iterations; index++) evaluate(state, action, { managed: true, available: true });
  const evaluateMs = (performance.now() - started) / iterations;
  started = performance.now();
  for (let index = 0; index < iterations; index++) classifyBash('cat a.txt | grep x | wc -l && git status');
  const classifyMs = (performance.now() - started) / iterations;
  assert.equal(decide(state).decision, 'PROCEED');
  started = performance.now();
  const cliRead = run(['gate', '--tool', 'Read']);
  const cliReadMs = performance.now() - started;
  const input = join(directory, 'edit.json');
  writeFileSync(input, JSON.stringify({ file_path: join(project, 'counter.mjs') }));
  started = performance.now();
  const cliEdit = run(['gate', '--tool', 'Edit', '--input-file', input]);
  const cliEditMs = performance.now() - started;
  assert.equal(cliRead.value?.allow, true);
  assert.equal(cliEdit.value?.allow, true, cliEdit.stderr);
  run(['decide']);
  const measured = runtime.measurements(id);
  const gateMs = measured.filter(item => item.operation === 'gate').map(item => item.elapsedMs);
  assert.ok(gateMs.length > 0 && measured.some(item => item.operation === 'decide'));
  t.diagnostic(`evaluate ${evaluateMs.toFixed(4)} ms/call; classifyBash ${classifyMs.toFixed(4)} ms/call; recorded gate ${Math.max(...gateMs).toFixed(2)} ms max over ${gateMs.length}; CLI gate Read ${cliReadMs.toFixed(0)} ms, Edit ${cliEditMs.toFixed(0)} ms wall`);
  assert.ok(evaluateMs < 1, `evaluate took ${evaluateMs} ms`);
  assert.ok(classifyMs < 1, `classifyBash took ${classifyMs} ms`);
  assert.equal(existsSync(join(project, '.optimizer', 'runtime.sqlite')), true);
});
