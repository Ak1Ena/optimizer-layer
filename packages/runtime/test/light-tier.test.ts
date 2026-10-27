import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lightTierBlocker, projectChecksAcceptance } from '../src/controller.ts';
import { gate, Runtime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import type { ContextAssessment, ReviewResponse } from '../src/types.ts';
import { capturePrompt, enableProject, readProjectConfig, writeProjectConfig } from '../src/project.ts';
import type { SessionState } from '../src/types.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_MODE;
test.after(() => rmSync(home, { recursive: true, force: true }));

const request = 'Make parseCount throw RangeError for negative values and keep returning numbers otherwise.';
const fixed = 'export function parseCount(value) { const count = Number(value); if (count < 0) throw new RangeError("negative"); return count; }\n';

/** The parseCount fixture of the A/B run, with an inexpensive approved check (5 s timeout), so sessions start on the light tier. */
function setup(t: test.TestContext, timeoutMs = 5000, extraChecks: string[] = []) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-light-')));
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
  writeFileSync(join(directory, 'done.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync(process.argv[2] + '/done') ? 0 : 1);\n");
  enableProject(project, { commands: [`node ${checker} ${project}`, ...extraChecks.map(file => `node ${join(directory, file)} ${project}`)], timeoutMs, yes: false });
  const token = readProjectConfig(project)?.hookToken ?? '';
  const prompt = (text = request) => `prompt:${capturePrompt(project, text, token).id}`;
  const promptId = prompt();
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const edit = () => gate(project, 'Edit', { file_path: join(project, 'counter.mjs') });
  const tiers = (id: string) => runtime.events(id).flatMap(({ event }) => event.payload.kind === 'tier.decided' ? [[event.payload.tier, event.payload.trigger]] : []);
  return { directory, project, checker, token, promptId, prompt, runtime, edit, tiers };
}

test('light tier: the first edit is allowed with zero agent optimizer steps, and edit + verify reaches VERIFIED', (t) => {
  const { project, runtime, edit, tiers } = setup(t);
  // No retrieve, assess or review from the agent: the first protected action itself is allowed.
  const first = edit();
  assert.equal(first.allow, true);
  assert.equal(first.started, true);
  assert.equal(first.decision, 'PROCEED');
  const id = first.sessionId;
  assert.ok(id);
  const state = runtime.get(id);
  assert.equal(state.tier, 'light');
  assert.equal(state.assessment?.kind, 'policy');
  assert.equal(state.review.kind, 'policy');
  const kinds = runtime.events(id).map(({ event }) => event.payload.kind);
  for (const kind of ['tier.decided', 'context.assessed', 'contract.reviewed', 'context.retrieved'] as const) assert.ok(kinds.includes(kind), kind);
  assert.deepEqual(tiers(id).map(([tier]) => tier), ['light']);
  assert.match(String(tiers(id)[0]?.[1]), /^Light tier: the user-approved project checks define acceptance/);
  assert.equal(runtime.decide(id).tier, 'light');
  // The edit makes the retrieved context stale; on the light tier that alone blocks nothing.
  writeFileSync(join(project, 'counter.mjs'), fixed);
  assert.equal(runtime.decide(id).decision, 'PROCEED');
  assert.equal(edit().allow, true, 'later edits stay allowed');
  const verified = runtime.verify(id);
  assert.equal(verified.outcome, 'VERIFIED');
  assert.equal(verified.phase, 'verified');
  assert.equal(readProjectConfig(project)?.activeSessionId, null);
  assert.deepEqual(tiers(id).map(([tier]) => tier), ['light'], 'no escalation on the happy path');
  assert.throws(() => runtime.retrieve(id), /verified and closed/, 'verified sessions stay terminal');
});

test('light tier: a changed pinned check artifact still blocks verification', (t) => {
  const { project, checker, runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  writeFileSync(join(project, 'counter.mjs'), fixed);
  writeFileSync(checker, 'process.exit(0);\n');
  const result = runtime.verify(id);
  assert.notEqual(result.outcome, 'VERIFIED');
  assert.equal(result.action.kind, 'escalate');
  assert.match(result.action.reason, /verifier artifacts changed/);
});

test('light tier escalates on an open human question to clarify, recorded with its trigger', (t) => {
  const { runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const itemIds = runtime.get(id).context?.items.map(item => item.id) ?? [];
  runtime.review(id, { kind: 'challenge', goalVersion: runtime.get(id).goal.version, itemIds, requirementId: 'R1', owner: 'human', rationale: 'Should negative values throw or clamp to zero?' });
  assert.deepEqual(tiers(id).at(-1), ['standard', 'open critical human question review:1']);
  const decision = runtime.decide(id);
  assert.deepEqual([decision.decision, decision.tier], ['ASK_HUMAN', 'standard']);
  assert.equal(edit().allow, false);
});

test('light tier escalates on an open local question, and the agent then assesses and reviews (standard)', (t) => {
  const { runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const itemIds = runtime.get(id).context?.items.map(item => item.id) ?? [];
  runtime.review(id, { kind: 'challenge', goalVersion: runtime.get(id).goal.version, itemIds, requirementId: 'R1', owner: 'local', rationale: 'Does any caller rely on the zero fallback?' });
  assert.deepEqual(tiers(id).at(-1), ['standard', 'open local question review:1']);
  assert.equal(runtime.get(id).assessment, null, 'escalation drops the policy assessment');
  assert.equal(edit().allow, false);
});

test('prose acceptance starts on the standard tier: agent assess and review are required', (t) => {
  const { runtime, tiers } = setup(t);
  const session = runtime.start({ request: '- R1: parseCount rejects negatives.\nAcceptance R1: parseCount("-1") throws RangeError.' });
  assert.equal(session.tier, 'standard');
  assert.deepEqual(tiers(session.id), [['standard', 'R1 has prose acceptance, not the approved project checks']]);
  assert.equal(runtime.decide(session.id).decision, 'RETRIEVE_CONTEXT');
});

test('a requirement not covered by an approved check, or paused control, blocks the light tier (pure rule)', () => {
  const base: SessionState = {
    id: 's', tier: 'light', goal: { version: 1, request: 'r', requirements: [{ id: 'R1', statement: 'r', acceptance: projectChecksAcceptance, acceptanceSource: 'project-checks', sourceLine: 1 }], uncertainties: [] },
    checks: [{ id: 'c', requirementIds: ['R1'], argv: ['true'], timeoutMs: 1000, artifacts: [] }], decisions: [], context: null, assessment: null,
    review: { kind: 'pending' }, control: { kind: 'running', rounds: 0 }, evidence: [], failureStreak: { signature: '', count: 0 }, completionClaimed: false,
  };
  assert.equal(lightTierBlocker(base), null);
  assert.equal(lightTierBlocker({ ...base, checks: [] }), 'R1 is not covered by an approved check');
  assert.equal(lightTierBlocker({ ...base, control: { kind: 'paused', rounds: 1, reason: 'x' } }), 'reconsideration: x');
});

test('light tier: a second identical check failure pauses for reconsideration and escalates', (t) => {
  const { runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  runtime.runCheck(id, 'check-1');
  assert.equal(runtime.decide(id).decision, 'PROCEED', 'one failure is ordinary iteration');
  runtime.runCheck(id, 'check-1');
  assert.equal(runtime.decide(id).decision, 'REQUEST_RECONSIDERATION');
  assert.match(String(tiers(id).at(-1)?.[1]), /^reconsideration: Check check-1 failed twice in a row/);
  assert.equal(runtime.get(id).tier, 'standard', 'the Light replan threshold (second identical failure) escalates');
  runtime.reconsider(id, { strategy: 'revise', rationale: 'The guard is missing; add it.' });
  assert.match(runtime.decide(id).decision, /^(RETRIEVE_CONTEXT|INVESTIGATE)$/, 'never silently back to light: the standard checkpoints apply');
});

test('light tier: a check that fails after a completion claim pauses for reconsideration and escalates', (t) => {
  const { runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  runtime.claim(id);
  assert.notEqual(runtime.verify(id).outcome, 'VERIFIED');
  assert.equal(runtime.decide(id).decision, 'REQUEST_RECONSIDERATION');
  assert.match(String(tiers(id).at(-1)?.[1]), /failed after a completion claim/);
});

test('an expensive check starts on the standard tier; a recorded short run makes the next prompt light', (t) => {
  const { project, prompt, runtime, edit, tiers } = setup(t, 120_000);
  const first = edit();
  assert.equal(first.allow, false);
  assert.ok(first.sessionId);
  assert.match(String(tiers(first.sessionId)[0]?.[1]), /no recorded run and its timeout 120 s exceeds the 60 s light-tier threshold/);
  // Record a short passing run of the same argv through a light session, then restore the long timeout.
  writeFileSync(join(project, 'counter.mjs'), fixed);
  const config = readProjectConfig(project);
  assert.ok(config);
  writeProjectConfig(project, { ...config, activeSessionId: null, checks: config.checks.map(check => ({ ...check, timeoutMs: 5000 })) });
  const quick = runtime.startFromPrompt(prompt('quick run')).session.id;
  runtime.runCheck(quick, 'check-1');
  const updated = readProjectConfig(project);
  assert.ok(updated);
  writeProjectConfig(project, { ...updated, activeSessionId: null, checks: updated.checks.map(check => ({ ...check, timeoutMs: 120_000 })) });
  const next = runtime.startFromPrompt(prompt('next task')).session;
  assert.equal(next.tier, 'light', 'the recorded duration, not the timeout, decides');
});

test('a session never de-escalates: the store refuses light after standard', (t) => {
  const { project, runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  runtime.claim(id);
  runtime.verify(id);
  const store = new Store(project);
  t.after(() => store.close());
  assert.equal(store.get(id).tier, 'standard');
  assert.throws(() => store.update(id, () => ({ kind: 'tier.decided', tier: 'light', trigger: 'x' })), /never de-escalates/);
});

test('a failed fast run is not a recorded duration: it never makes an expensive check Light', (t) => {
  const { project, prompt, runtime } = setup(t);
  const quick = runtime.startFromPrompt(prompt('first')).session.id;
  runtime.runCheck(quick, 'check-1');
  assert.equal(runtime.get(quick).evidence.at(-1)?.result.outcome, 'failed');
  const config = readProjectConfig(project);
  assert.ok(config);
  writeProjectConfig(project, { ...config, activeSessionId: null, checks: config.checks.map(check => ({ ...check, timeoutMs: 120_000 })) });
  const next = runtime.startFromPrompt(prompt('second')).session;
  assert.equal(next.tier, 'standard');
});

test('a slow recorded run escalates at once: next() never closes it, and verify is not VERIFIED', (t) => {
  const { project, runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const state = runtime.get(id);
  assert.ok(state.context);
  // Inject a passing but slow run bound to the current source, without the post-command #sync.
  const store = new Store(project);
  t.after(() => store.close());
  store.update(id, current => ({ kind: 'command.observed', control: current.control, failureStreak: current.failureStreak, evidence: {
    checkId: 'check-1', requirementIds: ['R1'], projectDigest: state.context?.projectDigest ?? '', at: new Date().toISOString(),
    result: { argv: ['node'], outcome: 'passed', exitCode: 0, output: '', outputDigest: 'x', durationMs: 61_000 },
  } }));
  assert.notEqual(runtime.next(id).kind, 'complete', 'the pure rule blocks the light shortcut before escalation is recorded');
  assert.notEqual(runtime.verify(id).outcome, 'VERIFIED');
  assert.match(String(tiers(id).at(-1)?.[1]), /ran 61 s, over the 60 s light-tier threshold/);
});

test('agents cannot submit policy assessments or reviews', (t) => {
  const { runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const policyAssessment: ContextAssessment = { kind: 'policy', rule: 'trust me' };
  assert.throws(() => runtime.assess(id, policyAssessment as never));
  const policyReview = { kind: 'policy', goalVersion: runtime.get(id).goal.version, rule: 'trust me' } as unknown as ReviewResponse;
  assert.throws(() => runtime.review(id, policyReview));
  assert.equal(runtime.get(id).tier, 'light', 'rejected input changes nothing');
});

test('a prior escalated session for the same prompt makes the next session for it standard', (t) => {
  const { project, promptId, runtime, edit, tiers } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  runtime.claim(id);
  runtime.verify(id);
  runtime.reconsider(id, { strategy: 'revise', rationale: 'Add the negative guard.' });
  writeFileSync(join(project, 'counter.mjs'), fixed);
  const itemIds = runtime.retrieve(id).items.map(item => item.id);
  runtime.assess(id, { kind: 'sufficient', itemIds, rationale: 'counter.mjs owns parseCount.' });
  runtime.review(id, { kind: 'accept', goalVersion: runtime.get(id).goal.version, itemIds, rationale: 'R1 is the prompt verbatim.' });
  assert.equal(runtime.verify(id).outcome, 'VERIFIED');
  const again = runtime.startFromPrompt(promptId);
  assert.equal(again.created, true);
  assert.equal(again.session.tier, 'standard');
  assert.match(String(tiers(again.session.id)[0]?.[1]), new RegExp(`prior session ${id} for this prompt escalated`));
});

test('a Light session is not VERIFIED when the source changes after its last passing check', (t) => {
  const { project, runtime, edit } = setup(t, 5000, ['done.mjs']);
  const id = edit().sessionId;
  assert.ok(id);
  writeFileSync(join(project, 'counter.mjs'), fixed);
  assert.equal(runtime.runCheck(id, 'check-1').result.outcome, 'passed');
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value); }\n');
  writeFileSync(join(project, 'done'), '');
  assert.equal(runtime.runCheck(id, 'check-2').result.outcome, 'passed');
  assert.notEqual(runtime.next(id).kind, 'complete', 'check-1 passed on older source');
  assert.notEqual(runtime.verify(id).outcome, 'VERIFIED');
});

test('runCheck rejects an unknown check before any context refresh', (t) => {
  const { runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const retrievals = () => runtime.events(id).filter(({ event }) => event.payload.kind === 'context.retrieved').length;
  const before = retrievals();
  assert.throws(() => runtime.runCheck(id, 'nope'), /Unknown registered check/);
  assert.equal(retrievals(), before);
});

test('cost breakdown: rework, tier escalations and component time come from recorded events; unmeasured values stay null', (t) => {
  const { runtime, edit } = setup(t);
  const id = String(edit().sessionId);
  runtime.runCheck(id, 'check-1');
  runtime.runCheck(id, 'check-1');
  runtime.reconsider(id, { strategy: 'revise', rationale: 'The guard is missing; add it.' });
  const cost = runtime.cost(id);
  assert.deepEqual(cost.rework, {
    checksRun: 2, failedChecks: 2, retrievals: 1, reRetrievals: 0, agentAssessments: 0, reAssessments: 0, agentReviews: 0, reReviews: 0,
    challenges: 0, reconsiderations: 1, stopBlocks: 0, blocked: 0, revertedEdits: null,
  });
  assert.equal(cost.tier.initial?.tier, 'light');
  assert.deepEqual(cost.tier.escalations.map(item => item.tier), ['standard']);
  assert.match(cost.tier.escalations[0]?.trigger ?? '', /^reconsideration: Check check-1 failed twice/);
  assert.equal(cost.components.verification.operations, 2);
  assert.ok(cost.components.verification.externalMs > 0, 'check subprocess time is attributed to verification');
  assert.equal(cost.components.replanning.operations, 1);
  assert.ok(cost.components.contextRetrieval.operations >= 1 && cost.components.decision.operations > 0);
  for (const [name, component] of Object.entries(cost.components)) assert.equal(component.modelTokens, name === 'other' ? null : 0, 'mapped components call no model; unmapped usage is unknown');
  assert.equal(cost.components.other.operations, 0, 'every measured operation maps to a component');
  // In-process use: no agent report, no hook ran.
  assert.equal(cost.agent.inputTokens, null);
  assert.equal(cost.agent.outputTokens, null);
  assert.equal(cost.agent.turns, null);
  assert.equal(cost.injected.systemPromptBytes, null);
  assert.equal(cost.hooks.invocations, 0);
});
