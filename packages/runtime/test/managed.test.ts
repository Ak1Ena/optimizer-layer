import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gate, Runtime } from '../src/runtime.ts';
import { appendCapturedPrompt, capturedPrompts, promptLogPath } from '../src/context.ts';
import { enableProject, readProjectConfig, writeProjectConfig } from '../src/project.ts';

const cli = resolve('packages/runtime/src/cli.ts');
const hookScript = resolve('packages/adapter/src/claude-hook.ts');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_MODE;
test.after(() => rmSync(home, { recursive: true, force: true }));

const request = 'Make parseCount throw RangeError for negative values and keep returning numbers otherwise.';
const fixed = 'export function parseCount(value) { const count = Number(value); if (count < 0) throw new RangeError("negative"); return count; }\n';

/**
 * Stands in for `claude -p`: it runs the hook commands from --settings through /bin/sh exactly as Claude Code
 * does, honours their deny verdicts, and reports usage in Claude Code's JSON shape. It never contacts a model.
 */
function fakeClaude(directory: string, bin: string): string {
  const path = join(directory, 'fake-claude.mjs');
  writeFileSync(path, `#!${process.execPath}
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const settingsPath = args[args.indexOf('--settings') + 1];
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const cwd = process.cwd();
const record = { args, prompt: readFileSync(0, 'utf8'), settings, settingsPath, mode: statSync(settingsPath).mode & 0o777, steps: [] };
const optimizer = (...rest) => JSON.parse(spawnSync(${JSON.stringify(bin)}, [...rest, '--project', cwd], { encoding: 'utf8' }).stdout);
const hook = (event, extra) => {
  const result = spawnSync('/bin/sh', ['-c', settings.hooks[event][0].hooks[0].command], { encoding: 'utf8', input: JSON.stringify({ session_id: 'fake', cwd, hook_event_name: event, ...extra }) });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const tool = (tool_name, tool_input, apply) => {
  const verdict = hook('PreToolUse', { tool_name, tool_input })?.hookSpecificOutput;
  const denied = verdict?.permissionDecision === 'deny';
  if (!denied) apply();
  record.steps.push({ tool: tool_name, denied, reason: verdict?.permissionDecisionReason ?? null });
};
record.current = optimizer('current');
const sessionId = record.current.sessionId;
const accept = () => {
  const items = optimizer('retrieve', '--session', sessionId).items.map(item => item.id).join(',');
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--rationale', 'counter.mjs owns parseCount.', '--items', items);
  const version = optimizer('status', '--session', sessionId).state.goal.version;
  optimizer('review', '--session', sessionId, '--kind', 'accept', '--version', String(version), '--rationale', 'R1 is the request verbatim.', '--items', items);
};
const mode = process.env.FAKE_MODE;
if (mode === 'sleep') await new Promise(done => setTimeout(done, 20_000));
if (mode === 'cooperate') accept();
const content = process.env.FAKE_FIX === '1' ? ${JSON.stringify(fixed)} : 'export function parseCount(value) { return Number(value); }\\n';
tool('Edit', { file_path: cwd + '/counter.mjs', old_string: 'x', new_string: 'y' }, () => writeFileSync(cwd + '/counter.mjs', content));
if (mode === 'ignore') tool('Bash', { command: 'echo hacked > counter.mjs' }, () => writeFileSync(cwd + '/counter.mjs', 'hacked'));
tool('Bash', { command: 'cat ~/.config/optimizer-layer/projects/x.json' }, () => {});
if (mode === 'cooperate') { accept(); optimizer('claim', '--session', sessionId); }
record.stop = hook('Stop', { stop_hook_active: false });
// Light tier: the agent answers the Stop block with the single optimizer step it names.
if (mode === 'light' && record.stop?.decision === 'block') { record.verify = optimizer('verify', '--session', sessionId); record.stopAfterVerify = hook('Stop', { stop_hook_active: true }); }
writeFileSync(process.env.FAKE_LOG, JSON.stringify(record));
process.stdout.write(process.env.FAKE_REPORT ?? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Finished.', num_turns: 4, usage: { input_tokens: 120, output_tokens: 30 } }));
`);
  chmodSync(path, 0o755);
  return path;
}

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-managed-')));
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
  const bin = join(directory, 'optimizer');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(bin, 0o755);
  const promptFile = join(directory, 'prompt.txt');
  writeFileSync(promptFile, request);
  const claude = fakeClaude(directory, bin);
  const log = join(directory, 'fake.json');
  const run = (env: Record<string, string>, extra: string[] = []) => {
    const result = spawnSync(process.execPath, [cli, 'run', '--project', project, '--prompt-file', promptFile, '--claude', claude, '--hook', hookScript, '--max-turns', '7', ...extra], {
      encoding: 'utf8', env: { ...process.env, OPTIMIZER_BIN: bin, FAKE_LOG: log, ...env },
    });
    return { status: result.status, stderr: result.stderr, value: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : null };
  };
  const fake = () => JSON.parse(readFileSync(log, 'utf8')) as {
    args: string[]; prompt: string; mode: number; settingsPath: string; settings: { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    current: { sessionId: string | null; phase: string | null; checkpoint: { decision: string } | null };
    steps: { tool: string; denied: boolean; reason: string | null }[]; stop: { decision?: string; reason?: string } | null;
    verify?: { outcome: string }; stopAfterVerify?: unknown;
  };
  return { directory, project, checker, run, fake, log };
}

test('managed run refuses a project without an approved check and never launches the agent', (t) => {
  const { run, log } = setup(t);
  const result = run({ FAKE_MODE: 'ignore' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed project/);
  assert.equal(existsSync(log), false);
});

test('managed run starts the contract before launch and enforces hooks on an agent that ignores the optimizer', (t) => {
  const { project, checker, run, fake } = setup(t);
  // Standard tier (timeout over the light-tier bound): edits wait for the agent's checkpoints.
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 120_000, yes: false });
  // Managed settings enforce whatever the user's global mode is: drop the opt-in flag the opt-in hooks would require.
  const { optedIn: _, ...config } = readProjectConfig(project) ?? (() => { throw new Error('missing config'); })();
  writeProjectConfig(project, config);
  const result = run({ FAKE_MODE: 'ignore', OPTIMIZER_MODE: 'opt-in' });
  assert.equal(result.status, 1, 'an unverified run is not success');
  const value = result.value;
  assert.ok(value);
  assert.equal(value.outcome, 'INCONCLUSIVE');
  assert.equal(value.agentExitCode, 0);
  assert.equal(value.turns, 4);
  assert.deepEqual(value.usage, { input_tokens: 120, output_tokens: 30 }, 'usage is what the agent reported');
  assert.equal(value.finalMessage, 'Finished.');
  const record = fake();
  // Prompt capture and session start happened before the agent ran.
  assert.equal(record.current.sessionId, value.sessionId);
  assert.ok(record.current.phase);
  assert.ok(record.current.checkpoint && record.current.checkpoint.decision !== 'PROCEED');
  assert.equal(record.prompt, request);
  assert.deepEqual(record.args.slice(0, 2), ['-p', '--settings']);
  for (const flag of ['--append-system-prompt', '--max-turns', '--output-format']) assert.ok(record.args.includes(flag), flag);
  assert.equal(record.args[record.args.indexOf('--max-turns') + 1], '7');
  assert.equal(record.mode, 0o600);
  assert.equal(existsSync(record.settingsPath), false, 'private settings are removed after the run');
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SubagentStart']) {
    assert.match(record.settings.hooks[event]?.[0]?.hooks[0]?.command ?? '', /^OPTIMIZER_MODE='managed' OPTIMIZER_BIN=/, event);
  }
  assert.match(record.settings.hooks.PreToolUse?.[0]?.matcher ?? '', /Bash/);
  assert.deepEqual(record.steps.map(step => [step.tool, step.denied]), [['Edit', true], ['Bash', true], ['Bash', true]]);
  assert.equal(record.stop?.decision, 'block', 'Stop is blocked while the task is unverified');
  assert.equal(readFileSync(join(project, 'counter.mjs'), 'utf8'), 'export function parseCount(value) { return Number(value) || 0; }\n');
  const runtime = new Runtime(project, { readOnly: true });
  t.after(() => runtime.close());
  const state = runtime.get(String(value.sessionId));
  assert.equal(state.goal.requirements[0]?.statement, request);
  assert.equal(state.origin?.promptId, value.promptId);
});

test('managed run reports FAILED with a non-zero exit, and VERIFIED with exit 0 only when checks pass', (t) => {
  const { project, checker, run, fake } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const failed = run({ FAKE_MODE: 'cooperate', FAKE_FIX: '0' });
  assert.equal(failed.status, 1);
  assert.equal(failed.value?.outcome, 'FAILED');
  assert.deepEqual(fake().steps.map(step => [step.tool, step.denied]), [['Edit', false], ['Bash', true]], 'reading the per-user store is denied in every phase');
  assert.equal(readFileSync(join(project, 'counter.mjs'), 'utf8'), 'export function parseCount(value) { return Number(value); }\n');
  // The failed task stays active, so a second run must not silently start over it.
  assert.match(run({ FAKE_MODE: 'cooperate', FAKE_FIX: '1' }).stderr, /unfinished active session/);
  const config = readProjectConfig(project);
  assert.ok(config);
  writeProjectConfig(project, { ...config, activeSessionId: null });
  const verified = run({ FAKE_MODE: 'cooperate', FAKE_FIX: '1' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.value?.outcome, 'VERIFIED');
  assert.equal(verified.value?.phase, 'verified');
  assert.deepEqual(verified.value?.verifiedRequirementIds, ['R1']);
  assert.notEqual(verified.value?.sessionId, failed.value?.sessionId);
  const timings = verified.value?.timings as { agentMs: number; verifyMs: number; totalMs: number };
  assert.ok(timings.agentMs > 0 && timings.verifyMs > 0 && timings.totalMs >= timings.agentMs);
});

test('a verified run stays closed: later protected work does not block the next run, which gets a new session', (t) => {
  const { project, checker, run } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const first = run({ FAKE_MODE: 'cooperate', FAKE_FIX: '1' });
  assert.equal(first.value?.outcome, 'VERIFIED', first.stderr);
  const id = String(first.value?.sessionId);
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  // A late hook gate still holding the old pointer, then an edit outside any session.
  const runtime = new Runtime(project);
  runtime.gate({ kind: 'protected', tool: 'Edit', target: join(project, 'counter.mjs') }, id);
  runtime.close();
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value); }\n');
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  const second = run({ FAKE_MODE: 'cooperate', FAKE_FIX: '1' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.value?.outcome, 'VERIFIED');
  assert.notEqual(second.value?.sessionId, id);
  const history = new Runtime(project, { readOnly: true });
  t.after(() => history.close());
  assert.equal(history.get(id).phase, 'verified', 'the first result is kept');
  assert.ok(history.events(id).some(({ event }) => event.payload.kind === 'command.observed'));
});

test('light tier managed run: the agent edits at once and its only optimizer step is verify', (t) => {
  const { project, checker, run, fake } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const result = run({ FAKE_MODE: 'light', FAKE_FIX: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.value?.outcome, 'VERIFIED');
  const record = fake();
  assert.equal(record.current.checkpoint?.decision, 'PROCEED', 'no retrieve, assess or review before the first edit');
  assert.deepEqual(record.steps.map(step => [step.tool, step.denied]), [['Edit', false], ['Bash', true]]);
  assert.equal(record.stop?.decision, 'block');
  assert.match(String(record.stop?.reason), /Edit with normal tools, then run `optimizer verify`/);
  assert.equal(record.verify?.outcome, 'VERIFIED');
  assert.equal(record.stopAfterVerify, null, 'a verified task stops silently');
});

test('managed run kills an agent that exceeds its time budget and reports it unverified', (t) => {
  const { project, checker, run } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const started = Date.now();
  const result = run({ FAKE_MODE: 'sleep' }, ['--timeout-ms', '3000']);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(result.status, 1);
  assert.equal(result.value?.timedOut, true);
  assert.equal(result.value?.agentExitCode, null);
  assert.equal(result.value?.usage, null, 'no usage is invented when the agent reported none');
  assert.notEqual(result.value?.outcome, 'VERIFIED');
  const agent = (result.value?.cost as { agent: Record<string, unknown> }).agent;
  for (const name of ['turns', 'totalCostUsd', 'durationMs', 'durationApiMs', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'iterations', 'modelUsage']) {
    assert.equal(agent[name], null, `${name} stays null without a report`);
  }
});

test('instrumentation: malformed or absent usage fields in the agent report become null, never numbers', (t) => {
  const { project, checker, run } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 120_000, yes: false });
  // duration_ms is absent; every other field has the wrong type or sign.
  const report = { type: 'result', result: 'Finished.', num_turns: -1, total_cost_usd: '0.42', duration_api_ms: -3, usage: 'lots', modelUsage: [1] };
  const value = run({ FAKE_MODE: 'ignore', FAKE_REPORT: JSON.stringify(report) }).value;
  assert.ok(value);
  assert.equal(value.usage, null);
  assert.equal(value.turns, null);
  assert.deepEqual((value.cost as { agent: unknown }).agent, {
    source: 'claude-code-json', turns: null, totalCostUsd: null, durationMs: null, durationApiMs: null,
    inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, iterations: null, modelUsage: null,
  });
});

test('instrumentation: the run copies Claude Code usage exactly and reports where the cost went', (t) => {
  const { project, checker, run, fake } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 120_000, yes: false });
  const usage = {
    input_tokens: 7, cache_creation_input_tokens: 1585, cache_read_input_tokens: 378_276, output_tokens: 969,
    server_tool_use: { web_search_requests: 0 }, iterations: [{ input_tokens: 4, output_tokens: 500 }, { input_tokens: 3, output_tokens: 469 }],
  };
  const modelUsage = { 'claude-sonnet-test': { inputTokens: 7, outputTokens: 969, cacheReadInputTokens: 378_276, cacheCreationInputTokens: 1585, costUSD: 0.4211 } };
  const report = { type: 'result', subtype: 'success', is_error: false, result: 'Finished.', num_turns: 17, duration_ms: 114_000, duration_api_ms: 98_000, total_cost_usd: 0.4211, usage, modelUsage };
  const result = run({ FAKE_MODE: 'ignore', FAKE_REPORT: JSON.stringify(report) });
  const value = result.value;
  assert.ok(value, result.stderr);
  assert.deepEqual(value.usage, usage);
  type Cost = {
    agent: Record<string, unknown>; injected: { systemPromptBytes: number | null; hookBytes: number; byEvent: Record<string, { injections: number; bytes: number }> };
    hooks: { invocations: number; elapsedMs: number; runtimeCalls: number; byEvent: Record<string, { invocations: number }>; byCommand: Record<string, { calls: number; elapsedMs: number }> };
    components: Record<string, { operations: number; modelTokens: number | null }>; rework: Record<string, unknown>;
  };
  const cost = value.cost as Cost;
  assert.deepEqual(cost.agent, {
    source: 'claude-code-json', turns: 17, totalCostUsd: 0.4211, durationMs: 114_000, durationApiMs: 98_000,
    inputTokens: 7, cacheReadTokens: 378_276, cacheWriteTokens: 1585, outputTokens: 969, iterations: usage.iterations, modelUsage,
  });
  const record = fake();
  assert.equal(cost.injected.systemPromptBytes, Buffer.byteLength(record.args[record.args.indexOf('--append-system-prompt') + 1] ?? ''));
  // Every deny reason and the Stop block reason the fake agent received, byte for byte.
  const denied = record.steps.filter(step => step.denied).map(step => Buffer.byteLength(step.reason ?? ''));
  assert.deepEqual(cost.injected.byEvent.PreToolUse, { injections: denied.length, bytes: denied.reduce((a, b) => a + b, 0) });
  assert.deepEqual(cost.injected.byEvent.Stop, { injections: 1, bytes: Buffer.byteLength(record.stop?.reason ?? '') });
  assert.equal(cost.rework.stopBlocks, 1);
  assert.equal(cost.hooks.byEvent.PreToolUse?.invocations, record.steps.length);
  assert.equal(cost.hooks.byEvent.Stop?.invocations, 1);
  assert.ok(cost.hooks.elapsedMs > 0 && (cost.hooks.byCommand.gate?.calls ?? 0) >= 1 && (cost.hooks.byCommand.gate?.elapsedMs ?? 0) > 0);
  for (const [name, component] of Object.entries(cost.components)) assert.equal(component.modelTokens, name === 'other' ? null : 0);
  assert.equal(cost.components.other?.operations, 0, 'every operation the run measured maps to a component');
  assert.ok((cost.components.goalIntelligence?.operations ?? 0) >= 1 && (cost.components.contextRetrieval?.operations ?? 0) >= 1);
  // `optimizer metrics` reads the same breakdown from the session.
  const metrics = JSON.parse(spawnSync(process.execPath, [cli, 'metrics', '--project', project, '--session', String(value.sessionId)], { encoding: 'utf8' }).stdout) as Cost & { measurements: unknown[] };
  const { measurements, ...breakdown } = metrics;
  assert.ok(measurements.length > 0);
  assert.deepEqual(breakdown.agent, cost.agent);
  assert.deepEqual(breakdown.injected, cost.injected);
  assert.deepEqual(breakdown.hooks, cost.hooks);
});

test('S3: managed-run requests carry no human authority, and run refuses to start inside a managed agent or hook', (t) => {
  const { project, checker, run, log } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  for (const env of [{ OPTIMIZER_MANAGED_RUN: '1' }, { OPTIMIZER_HOOK_TOKEN: 'x' }]) {
    const refused = run({ FAKE_MODE: 'ignore', ...env });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /inside an optimizer-managed agent/);
  }
  assert.equal(existsSync(log), false, 'the agent was never launched');
  const token = readProjectConfig(project)?.hookToken ?? '';
  const row = appendCapturedPrompt(project, 'Agent text pretending to be the user.', token, 'controller');
  assert.deepEqual(capturedPrompts(project), [], 'controller rows are not hook prompts');
  assert.deepEqual(capturedPrompts(project, true).map(item => item.id), [`run:${row}`]);
  const denied = gate(project, 'Edit', { file_path: join(project, 'counter.mjs') });
  assert.equal(denied.allow, false);
  assert.equal(denied.started, false, 'the gate never starts a contract from a controller row');
  // Relabelling the row as a hook capture breaks its MAC.
  const logPath = promptLogPath(project);
  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"capturedBy":"controller"', '"capturedBy":"hook"'));
  assert.deepEqual(capturedPrompts(project), []);
  writeFileSync(logPath, readFileSync(logPath, 'utf8').replace('"capturedBy":"hook"', '"capturedBy":"controller"'));
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const { session } = runtime.startFromPrompt(`run:${row}`);
  const itemIds = runtime.retrieve(session.id).items.map(item => item.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds, rationale: 'counter.mjs owns parseCount.' });
  runtime.review(session.id, { kind: 'challenge', goalVersion: runtime.get(session.id).goal.version, itemIds, requirementId: 'R1', owner: 'human', rationale: 'Which behaviour does the user want?' });
  assert.throws(() => runtime.resolve(session.id, { uncertaintyId: 'review:1', source: `run:${row}` }), /no human authority/);
});

test('--claude-args appends plain arguments without a shell and refuses metacharacters and run-owned flags', (t) => {
  const { project, checker, run, fake, log } = setup(t);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  const passed = run({ FAKE_MODE: 'ignore' }, ['--claude-args=--permission-mode acceptEdits  --allowedTools Bash']);
  assert.equal(passed.status, 1, 'unverified');
  assert.deepEqual(fake().args.slice(-4), ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash']);
  rmSync(log);
  const config = readProjectConfig(project);
  assert.ok(config);
  writeProjectConfig(project, { ...config, activeSessionId: null });
  for (const bad of ['--allowedTools "Bash"', 'x; rm -rf y', '--x $(id)', '--settings /tmp/s.json', '--max-turns=999', '--dangerously-skip-permissions']) {
    const refused = run({ FAKE_MODE: 'ignore' }, [`--claude-args=${bad}`]);
    assert.equal(refused.status, 1, bad);
    assert.match(refused.stderr, /claude-args/, bad);
  }
  assert.equal(existsSync(log), false, 'refused arguments never launch the agent');
});
