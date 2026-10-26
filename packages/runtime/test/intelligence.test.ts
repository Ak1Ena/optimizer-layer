import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessGate, extractGoal, nextAction, verifiedRequirementIds } from '../src/intelligence.ts';
import type { SessionState, VerificationEvidence } from '../src/types.ts';

function ready(): SessionState {
  return {
    id: 'session', goal: extractGoal('- R1: Support greeting\nAcceptance R1: Greeting returns hello'),
    checks: [{ id: 'hello', requirementIds: ['R1'], argv: ['node', 'test.js'], timeoutMs: 1000, artifacts: [] }],
    decisions: [],
    context: { items: [{ id: 'code', kind: 'code', path: '/project/hello.ts', line: 1, excerpt: 'hello', digest: 'source', retrievedAt: '2026-10-26T00:00:00Z', requirementIds: ['R1'], authority: 'untrusted' }], uncoveredRequirementIds: [], diagnostics: [], complete: true, projectDigest: 'current' },
    assessment: { kind: 'sufficient', rationale: 'Implementation and acceptance are understood', itemIds: ['code'] },
    review: { kind: 'accepted', goalVersion: 1, rationale: 'The contract preserves the requested greeting.', itemIds: ['code'] },
    control: { kind: 'running', rounds: 0 }, evidence: [], failureStreak: { signature: '', count: 0 }, completionClaimed: false,
  };
}
function passing(checkId = 'hello', requirementIds = ['R1']): VerificationEvidence {
  return { checkId, requirementIds, projectDigest: 'current', result: { argv: ['node', 'test.js'], outcome: 'passed', exitCode: 0, output: 'ok', outputDigest: 'output', durationMs: 1 }, at: '2026-10-26T00:00:00Z' };
}

test('goal dialect preserves requirement text, acceptance, source lines, and question ownership', () => {
  const request = '# Goal\n- R1: Keep every greeting.\nAcceptance R1: Empty names return hello.\n- R2: Preserve punctuation!\nAcceptance R2: Output ends with !\nQuestion human Q1: Which locale?\nQuestion local Q2: Where is greeting implemented?';
  const goal = extractGoal(request);
  assert.equal(goal.request, request);
  assert.deepEqual(goal.requirements, [
    { id: 'R1', statement: 'Keep every greeting.', acceptance: 'Empty names return hello.', sourceLine: 2 },
    { id: 'R2', statement: 'Preserve punctuation!', acceptance: 'Output ends with !', sourceLine: 4 },
  ]);
  assert.deepEqual(goal.uncertainties.map(({ id, owner, critical, resolution }) => ({ id, owner, critical, resolution })), [
    { id: 'Q1', owner: 'human', critical: true, resolution: { kind: 'open' } },
    { id: 'Q2', owner: 'local', critical: true, resolution: { kind: 'open' } },
  ]);
});

test('plain prose is retained with missing acceptance uncertainty rather than invented criteria', () => {
  const goal = extractGoal('Make greeting friendly. Keep Unicode.');
  assert.equal(goal.requirements[0]?.statement, 'Make greeting friendly. Keep Unicode.');
  assert.equal(goal.requirements[0]?.acceptance, '');
  assert.equal(goal.uncertainties[0]?.owner, 'human');
  assert.equal(goal.uncertainties[0]?.critical, true);
  assert.equal(goal.uncertainties[0]?.resolution.kind, 'open');
  assert.throws(() => extractGoal(' \n '), /empty/i);
});

test('duplicate IDs and orphan acceptance are rejected without silently losing requirements', () => {
  assert.throws(() => extractGoal('- R1: Hello\n- R1: Goodbye'), /duplicate/i);
  assert.throws(() => extractGoal('- R1: Hello\nAcceptance R2: Goodbye'), /unknown|orphan/i);
  assert.throws(() => extractGoal('- R1: Hello\nAcceptance R1: yes\nAcceptance R1: no'), /duplicate/i);
});

test('critical human uncertainty wins over missing context; an answer needs a source', () => {
  const state = ready();
  state.context = null;
  state.goal.uncertainties.push({ id: 'Q1', question: 'Which locale?', owner: 'human', critical: true, resolution: { kind: 'open' } });
  assert.equal(assessGate(state).kind, 'clarify');
  state.goal.uncertainties[0] = { id: 'Q1', question: 'Which locale?', owner: 'human', critical: true, resolution: { kind: 'resolved', answer: 'English', source: '' } };
  assert.equal(assessGate(state).kind, 'clarify');
});

test('gate requires complete covered retrieval and a sufficient current cited assessment', () => {
  const base = ready();
  assert.equal(assessGate(base).kind, 'proceed');
  for (const mutate of [
    (s: SessionState) => { s.context = null; },
    (s: SessionState) => { if (s.context) s.context.complete = false; },
    (s: SessionState) => { if (s.context) s.context.uncoveredRequirementIds = ['R1']; },
    (s: SessionState) => { s.assessment = null; },
    (s: SessionState) => { s.assessment = { kind: 'insufficient', rationale: 'Need source', itemIds: ['code'] }; },
    (s: SessionState) => { s.assessment = { kind: 'sufficient', rationale: '', itemIds: ['code'] }; },
    (s: SessionState) => { s.assessment = { kind: 'sufficient', rationale: 'Fine', itemIds: [] }; },
    (s: SessionState) => { s.assessment = { kind: 'sufficient', rationale: 'Fine', itemIds: ['old'] }; },
    (s: SessionState) => { if (s.context) s.context.items[0] = { id: 'code', kind: 'code', path: '/project/hello.ts', line: 1, excerpt: 'hello', digest: 'source', retrievedAt: '2026-10-26T00:00:00Z', requirementIds: [], authority: 'untrusted' }; },
    (s: SessionState) => { s.goal.uncertainties.push({ id: 'Q1', question: 'Find source', owner: 'local', critical: true, resolution: { kind: 'open' } }); },
  ]) {
    const state = structuredClone(base);
    mutate(state);
    assert.equal(assessGate(state).kind, 'investigate');
  }
});

test('next action honors pause and escalation before gates and completion claims', () => {
  const state = ready();
  state.control = { kind: 'paused', rounds: 1, reason: 'Repeated failures' };
  state.completionClaimed = true;
  state.context = null;
  assert.equal(nextAction(state).kind, 'reconsider');
  state.control = { kind: 'escalated', rounds: 3, reason: 'Retries exhausted' };
  assert.equal(nextAction(state).kind, 'escalate');
  state.control = { kind: 'running', rounds: 0 };
  assert.equal(nextAction(state).kind, 'retrieve');
  state.goal.uncertainties.push({ id: 'Q', question: 'Locale?', owner: 'human', critical: true, resolution: { kind: 'open' } });
  assert.equal(nextAction(state).kind, 'clarify');
});

test('completion requires every registered check and requirement to pass at current digest', () => {
  const state = ready();
  assert.equal(nextAction(state).kind, 'execute');
  state.completionClaimed = true;
  assert.equal(nextAction(state).kind, 'verify');
  state.evidence = [passing()];
  assert.equal(nextAction(state).kind, 'complete');
  for (const mutate of [
    (s: SessionState) => { s.evidence = []; },
    (s: SessionState) => { s.evidence[0] = { ...passing(), projectDigest: 'old' }; },
    (s: SessionState) => { s.evidence[0] = passing('unregistered'); },
    (s: SessionState) => { s.evidence[0] = passing('hello', []); },
    (s: SessionState) => { s.checks = []; },
    (s: SessionState) => { s.checks.push({ id: 'extra', requirementIds: ['R1'], argv: ['node', 'extra.js'], timeoutMs: 1000, artifacts: [] }); },
    (s: SessionState) => { s.goal.requirements.push({ id: 'R2', statement: 'Other behavior', acceptance: 'Other works', sourceLine: 1 }); if (s.context) s.context.items[0]?.requirementIds.push('R2'); },
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    assert.notEqual(nextAction(changed).kind, 'complete');
  }
  const failed = passing();
  failed.result.outcome = 'failed';
  failed.result.exitCode = 1;
  failed.at = '2026-10-26T01:00:00Z';
  state.evidence.push(failed);
  assert.equal(nextAction(state).kind, 'verify');
});


test('verified requirement IDs report only registered coverage with latest current passing evidence', () => {
  const state = ready();
  assert.deepEqual(verifiedRequirementIds(state), []);
  state.evidence = [passing()];
  assert.deepEqual(verifiedRequirementIds(state), ['R1']);
  state.evidence.push({ ...passing(), projectDigest: 'stale' });
  assert.deepEqual(verifiedRequirementIds(state), []);
});

test('a requirement remains unverified until every check registered for it has current passing evidence', () => {
  const state = ready();
  state.evidence = [passing()];
  state.checks.push({ id: 'regression', requirementIds: ['R1'], argv: ['node', 'regression.js'], timeoutMs: 1000, artifacts: [] });
  assert.deepEqual(verifiedRequirementIds(state), []);
  state.evidence.push(passing('regression'));
  assert.deepEqual(verifiedRequirementIds(state), ['R1']);
});
