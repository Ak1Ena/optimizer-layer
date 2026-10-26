import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluate } from '../src/controller.ts';
import { availableActions, chooseAction, shadowModel, type DecisionModel } from '../src/decision-model.ts';
import { gate, Runtime } from '../src/runtime.ts';
import { capturePrompt, enableProject, readProjectConfig } from '../src/project.ts';

const cli = resolve('packages/runtime/src/cli.ts');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-home-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
delete process.env.OPTIMIZER_MODE;
delete process.env.OPTIMIZER_SHADOW_MODEL;
test.after(() => rmSync(home, { recursive: true, force: true }));

const secret = 'ZEBRA_SECRET_GOAL_TEXT';
const request = `Make parseCount throw RangeError for negative values ${secret}.`;

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-decisions-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value) || 0; }\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { parseCount } = await import(pathToFileURL(process.argv[2] + '/counter.mjs'));
assert.throws(() => parseCount('-1'), RangeError);
`);
  enableProject(project, { commands: [`node ${checker} ${project}`], timeoutMs: 5000, yes: false });
  capturePrompt(project, request, readProjectConfig(project)?.hookToken);
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const edit = () => gate(project, 'Edit', { file_path: join(project, 'counter.mjs') });
  const accept = (id: string) => {
    const itemIds = runtime.retrieve(id).items.map(item => item.id);
    runtime.assess(id, { kind: 'sufficient', itemIds, rationale: 'counter.mjs owns parseCount.' });
    runtime.review(id, { kind: 'accept', goalVersion: runtime.get(id).goal.version, itemIds, rationale: 'R1 is the prompt verbatim.' });
  };
  return { project, runtime, edit, accept };
}

test('a model ranking only orders allowed actions and can never override the gate', (t) => {
  const { runtime, edit } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const reckless: DecisionModel = { version: 'reckless', rank: () => [
    { action: 'COMPLETE', successProbability: 1, rationale: 'skip everything' },
    { action: 'PROCEED', successProbability: 1, rationale: 'just edit' },
  ] };
  const [experience] = runtime.experiences(id).slice(-1);
  assert.ok(experience);
  const mandatory = availableActions(runtime.decide(id).decision);
  assert.equal(mandatory.length, 1);
  assert.equal(chooseAction(reckless, experience.stateFeatures, mandatory), mandatory[0]);
  assert.equal(evaluate(runtime.get(id), { kind: 'protected', tool: 'Edit' }, { managed: true, available: true }).allow, false);
  assert.equal(edit().allow, false);
  assert.equal(chooseAction(reckless, experience.stateFeatures, availableActions('PROCEED')), 'PROCEED');
  assert.equal(chooseAction({ version: 'x', rank: () => [{ action: 'COMPLETE', successProbability: 1, rationale: 'r' }] }, experience.stateFeatures, ['RUN_VERIFICATION']), 'RUN_VERIFICATION');
});

test('experiences are recorded per distinct decision, deduplicated, and carry no free text', (t) => {
  const { runtime, edit, accept } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  const first = runtime.experiences(id).length;
  assert.ok(first > 0);
  for (let attempt = 0; attempt < 5; attempt++) edit();
  assert.equal(runtime.experiences(id).length, first, 'repeated identical gate queries add nothing');
  accept(id);
  const experiences = runtime.experiences(id);
  assert.ok(experiences.length > first);
  assert.equal(experiences.at(-1)?.chosenAction, 'PROCEED');
  assert.deepEqual(experiences.at(-1)?.availableActions, ['PROCEED', 'RUN_VERIFICATION', 'RETRIEVE_CONTEXT']);
  for (const item of experiences) {
    assert.equal(item.decisionModelVersion, 'rule-v0.1');
    assert.equal(item.shadow, undefined, 'shadow mode is off by default');
    for (const [key, value] of Object.entries(item.stateFeatures)) {
      assert.ok(typeof value !== 'string' || ['phase', 'reviewState', 'control', 'lastCheckOutcome'].includes(key), key);
    }
  }
  assert.doesNotMatch(JSON.stringify(experiences), new RegExp(`${secret}|parseCount|counter\\.mjs`));
});

test('verify and blocked outcomes are backfilled onto earlier decisions without inventing tokens', (t) => {
  const { project, runtime, edit, accept } = setup(t);
  const id = edit().sessionId;
  assert.ok(id);
  accept(id);
  runtime.claim(id);
  assert.equal(runtime.verify(id).outcome, 'FAILED');
  const failed = runtime.experiences(id);
  assert.ok(failed.every(item => item.observedOutcome !== null));
  assert.deepEqual(failed[0]?.observedOutcome, { outcome: 'FAILED', verificationProgress: { verified: 0, total: 1 }, goalSatisfied: false, additionalTokens: null, additionalTimeMs: (failed[0]?.observedOutcome as { additionalTimeMs: number }).additionalTimeMs });
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { const n = Number(value); if (n < 0) throw new RangeError("negative"); return n; }\n');
  accept(id);
  assert.equal(runtime.verify(id).outcome, 'VERIFIED');
  const verified = runtime.experiences(id).slice(failed.length);
  assert.ok(verified.length > 0);
  assert.ok(verified.every(item => (item.observedOutcome as { goalSatisfied: boolean } | null)?.goalSatisfied === true));
  const other = setup(t);
  const blockedId = other.edit().sessionId;
  assert.ok(blockedId);
  other.runtime.block(blockedId, 'Stop budget exhausted');
  assert.ok(other.runtime.experiences(blockedId).some(item => (item.observedOutcome as { outcome: string } | null)?.outcome === 'BLOCKED'));
});

test('a shadow model is recorded beside the real choice and never changes decisions or the gate', (t) => {
  const scenario = () => {
    const { runtime, edit, accept } = setup(t);
    const verdicts = [edit().allow];
    const id = edit().sessionId;
    assert.ok(id);
    accept(id);
    verdicts.push(edit().allow);
    runtime.claim(id);
    runtime.verify(id);
    return { verdicts, experiences: runtime.experiences(id) };
  };
  const off = scenario();
  process.env.OPTIMIZER_SHADOW_MODEL = 'prefer-retrieve';
  t.after(() => { delete process.env.OPTIMIZER_SHADOW_MODEL; });
  const on = scenario();
  assert.deepEqual(on.verdicts, off.verdicts);
  assert.deepEqual(on.experiences.map(item => [item.chosenAction, item.stateFeatures.phase]), off.experiences.map(item => [item.chosenAction, item.stateFeatures.phase]));
  assert.ok(on.experiences.every(item => item.shadow?.version === 'prefer-retrieve-v0'));
  const proceed = on.experiences.find(item => item.chosenAction === 'PROCEED');
  assert.equal(proceed?.shadow?.ranking[0]?.action, 'RETRIEVE_CONTEXT', 'the shadow disagrees, yet PROCEED was chosen');
  assert.equal(shadowModel('unknown-model'), null);
});

test('the experiences CLI exports recorded decisions as JSON', (t) => {
  const { project, edit } = setup(t);
  const id = edit().sessionId;
  const result = spawnSync(process.execPath, [cli, 'experiences', '--project', project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const exported: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(exported) && exported.length > 0);
  assert.ok(exported.every((item: { sessionId?: unknown }) => item.sessionId === id));
  assert.doesNotMatch(result.stdout, new RegExp(secret));
});
