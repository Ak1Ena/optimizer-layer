import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-cycle-')));
  const project = join(directory, 'project');
  mkdirSync(project);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { return Number(value) || 0; }\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const {parseCount} = await import(pathToFileURL(process.argv[2] + '/counter.mjs'));
assert.equal(parseCount('2'),2);
assert.throws(()=>parseCount('-1'), RangeError);
`);
  const request = '- R1: parseCount preserves nonnegative integers.\nAcceptance R1: parseCount returns 2 for numeric text.\n- R2: parseCount rejects negative values.\nAcceptance R2: parseCount throws RangeError for negative values.\nQuestion human Q1: What should parseCount do for negative values?';
  const checks = [{ id: 'acceptance', requirementIds: ['R1', 'R2'], argv: [process.execPath, checker, project], timeoutMs: 2000 }];
  const history = join(directory, 'conversation.jsonl');
  writeFileSync(history, JSON.stringify({ id: 'prior', projectRoot: project, role: 'user', content: 'Decision: parseCount must throw RangeError for negative values.', timestamp: '2026-10-26T00:00:00Z' }) + '\n');
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({ request, checks });
  function prepare() {
    runtime.importHistory(session.id, history);
    runtime.resolve(session.id, { uncertaintyId: 'Q1', source: 'prior:decision:1' });
    const context = runtime.retrieve(session.id);
    runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The counter implementation and prior human decision cover both numeric conversion and negative input handling.' });
    runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  }
  return { runtime, session, project, checker, history, prepare };
}

test('full cycle gates uncertainty, pauses failures, accepts reconsideration and independently verifies code', (t) => {
  const { runtime, session, project, prepare } = setup(t);
  assert.equal(runtime.next(session.id).kind, 'clarify');
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /clarif|critical/i);
  prepare();
  assert.equal(runtime.next(session.id).kind, 'execute');
  runtime.claim(session.id);
  assert.equal(runtime.next(session.id).kind, 'verify');
  for (let attempt = 0; attempt < 3; attempt++) {
    const evidence = runtime.runCheck(session.id, 'acceptance');
    assert.equal(evidence.result.outcome, 'failed');
  }
  assert.equal(runtime.next(session.id).kind, 'reconsider');
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /paused/i);
  assert.throws(() => runtime.reconsider(session.id, { strategy: 'retain', rationale: '' }), /rationale/i);
  runtime.reconsider(session.id, { strategy: 'retain', rationale: 'The acceptance failure identifies the missing negative guard. Retain the parser approach and add a RangeError before returning the numeric value.' });
  assert.equal(runtime.next(session.id).kind, 'execute');
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { const count = Number(value); if (count < 0) throw new RangeError("negative"); return count; }\n');
  assert.equal(runtime.next(session.id).kind, 'retrieve');
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The updated counter adds the required negative guard and preserves numeric conversion from the original contract.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  const result = runtime.verify(session.id);
  assert.equal(result.action.kind, 'complete');
  assert.deepEqual(result.verifiedRequirementIds, ['R1', 'R2']);
  const observed = runtime.events(session.id).filter(item => item.event.payload.kind === 'command.observed');
  assert.equal(observed.length, 4);
  assert.ok(runtime.measurements(session.id).some(item => item.externalMs > 0 && item.optimizerMs >= 0));
});

test('source changes invalidate unverified work and stale human decisions reopen clarification', (t) => {
  const { runtime, session, project, history, prepare } = setup(t);
  prepare();
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount(value) { const n=Number(value); if(n<0)throw new RangeError(); return n; }\n');
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The implementation and decision cover both requirements.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  assert.notEqual(runtime.next(session.id).kind, 'retrieve');
  writeFileSync(join(project, 'counter.mjs'), 'export function parseCount() { return 0; }\n');
  assert.equal(runtime.next(session.id).kind, 'retrieve');
  writeFileSync(history, readFileSync(history, 'utf8').replace('throw RangeError', 'clamp to zero'));
  assert.equal(runtime.next(session.id).kind, 'clarify');
});

test('appending an actual human clarification refreshes unchanged decision provenance', (t) => {
  const { runtime, session, project, history, prepare } = setup(t);
  prepare();
  const previous = readFileSync(history, 'utf8');
  writeFileSync(history, previous + JSON.stringify({ id: 'follow-up', projectRoot: project, role: 'user', content: 'Decision: parseCount must continue rejecting negative values with RangeError.', timestamp: '2026-10-26T00:01:00Z', supersedes: ['prior'] }) + '\n');
  assert.equal(runtime.next(session.id).kind, 'clarify');
  runtime.importHistory(session.id, history);
  runtime.resolve(session.id, { uncertaintyId: 'Q1', source: 'follow-up:decision:1' });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The follow-up human decision retains the negative value policy and the current implementation remains located.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  assert.equal(runtime.next(session.id).kind, 'execute');
});

test('missing coverage and commands modifying source cannot establish verified completion', (t) => {
  const { runtime, project, prepare, session } = setup(t);
  prepare();
  const mutating = new Runtime(project);
  t.after(() => mutating.close());
  const other = mutating.start({ request: '- R1: counter works\nAcceptance R1: counter check passes', checks: [{ id: 'mutate', requirementIds: ['R1'], argv: [process.execPath, '-e', "require('node:fs').writeFileSync('counter.mjs','changed')"], timeoutMs: 1000 }] });
  const context = mutating.retrieve(other.id);
  mutating.assess(other.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The counter source covers the stated counter requirement.' });
  mutating.review(other.id, { kind: 'accept', goalVersion: mutating.get(other.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  assert.equal(mutating.runCheck(other.id, 'mutate').result.outcome, 'failed');
  assert.notEqual(mutating.next(other.id).kind, 'complete');
  const noChecks = runtime.start({ request: '- R1: counter works\nAcceptance R1: counter check passes', checks: [] });
  const current = runtime.retrieve(noChecks.id);
  runtime.assess(noChecks.id, { kind: 'sufficient', itemIds: current.items.map(item => item.id), rationale: 'The counter file is present but independently registered checks are absent.' });
  runtime.review(noChecks.id, { kind: 'accept', goalVersion: runtime.get(noChecks.id).goal.version, itemIds: current.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  runtime.claim(noChecks.id);
  assert.notEqual(runtime.verify(noChecks.id).action.kind, 'complete');
  assert.notEqual(runtime.next(session.id).kind, 'complete');
});
