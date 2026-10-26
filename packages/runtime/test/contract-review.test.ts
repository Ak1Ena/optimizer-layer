import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import type { ReviewResponse } from '../src/types.ts';

function setup(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-review-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = () => "Hello";\n');
  const marker = join(directory, 'checked');
  const verifier = join(directory, 'acceptance.mjs');
  writeFileSync(verifier, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { greeting } = await import(pathToFileURL(process.argv[2]));
assert.equal(greeting(), 'Hello');
writeFileSync(process.argv[3], 'checked');
`);
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({
    request: '- R1: greeting returns Hello\nAcceptance R1: greeting() is exactly Hello',
    checks: [{ id: 'acceptance', requirementIds: ['R1'], argv: [process.execPath, verifier, join(project, 'greeting.mjs'), marker], timeoutMs: 1000 }],
  });
  function prepare() {
    const context = runtime.retrieve(session.id);
    const itemIds = context.items.map(item => item.id);
    runtime.assess(session.id, { kind: 'sufficient', itemIds, rationale: 'The greeting source covers the requested return value and acceptance.' });
    return itemIds;
  }
  function response() {
    return { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, rationale: 'R1 preserves the requested greeting and its independently testable acceptance.', itemIds: prepare() } as const;
  }
  return { runtime, session, directory, project, marker, prepare, response };
}

test('unreviewed contracts block checks and completion claims without executing the verifier', t => {
  const { runtime, session, marker, prepare } = setup(t);
  prepare();
  runtime.claim(session.id);
  assert.equal(runtime.next(session.id).kind, 'review');
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /review/i);
  assert.equal(runtime.verify(session.id).action.kind, 'review');
  assert.equal(existsSync(marker), false);
});

test('accepted contract review survives restart and allows independently verified completion', t => {
  const { runtime, session, project, response } = setup(t);
  runtime.review(session.id, response());
  const reader = new Runtime(project, { readOnly: true });
  t.after(() => reader.close());
  assert.equal(reader.get(session.id).review.kind, 'accepted');
  assert.equal(reader.next(session.id).kind, 'execute');
  const result = runtime.verify(session.id);
  assert.equal(result.action.kind, 'complete');
  assert.deepEqual(result.verifiedRequirementIds, ['R1']);
  assert.ok(runtime.events(session.id).some(({ event }) => event.payload.kind === 'contract.reviewed'));
});

test('local challenges preserve requirements and checks until cited resolution and a fresh review', t => {
  const { runtime, session, response, prepare } = setup(t);
  const before = runtime.get(session.id);
  const challenged = runtime.review(session.id, { ...response(), kind: 'challenge', requirementId: 'R1', owner: 'local', rationale: 'Confirm which greeting module owns the requested behavior.' });
  assert.equal(challenged.review.kind, 'challenged');
  assert.equal(challenged.goal.version, 2);
  assert.deepEqual(challenged.goal.requirements, before.goal.requirements);
  assert.deepEqual(challenged.checks, before.checks);
  const question = challenged.goal.uncertainties.at(-1);
  assert.ok(question);
  assert.equal(runtime.next(session.id).kind, 'retrieve');
  assert.throws(() => runtime.review(session.id, response()), /unresolved|question/i);
  const itemIds = prepare();
  const source = itemIds[0];
  assert.ok(source);
  runtime.resolve(session.id, { uncertaintyId: question.id, source, answer: 'greeting.mjs exports greeting and currently returns Hello.' });
  assert.equal(runtime.get(session.id).goal.version, 3);
  assert.equal(runtime.get(session.id).review.kind, 'pending');
  prepare();
  assert.equal(runtime.next(session.id).kind, 'review');
  runtime.review(session.id, response());
  assert.equal(runtime.verify(session.id).action.kind, 'complete');
});

test('human challenges require imported user authority and changed answers invalidate acceptance', t => {
  const { runtime, session, directory, project, response, prepare } = setup(t);
  const challenged = runtime.review(session.id, { ...response(), kind: 'challenge', requirementId: 'R1', owner: 'human', rationale: 'Confirm that Hello is the required greeting language.' });
  const question = challenged.goal.uncertainties.at(-1);
  assert.ok(question);
  assert.equal(runtime.next(session.id).kind, 'clarify');
  const source = prepare()[0];
  assert.ok(source);
  assert.throws(() => runtime.resolve(session.id, { uncertaintyId: question.id, source, answer: 'Hello is fine' }), /user decision/i);
  const history = join(directory, 'conversation.jsonl');
  writeFileSync(history, JSON.stringify({ id: 'user', projectRoot: project, role: 'user', content: 'Decision: The greeting must remain Hello.', timestamp: '2026-10-26T00:00:00Z' }) + '\n');
  runtime.importHistory(session.id, history);
  runtime.resolve(session.id, { uncertaintyId: question.id, source: 'user:decision:1' });
  runtime.review(session.id, response());
  assert.equal(runtime.next(session.id).kind, 'execute');
  runtime.resolve(session.id, { uncertaintyId: question.id, source: 'user:decision:1' });
  prepare();
  assert.equal(runtime.next(session.id).kind, 'review');
});

test('stale versions, unrelated citations, and malformed reviews fail before event persistence', t => {
  const { runtime, session, project, response } = setup(t);
  const valid = response();
  const before = runtime.events(session.id).length;
  for (const input of [
    { ...valid, goalVersion: 0 },
    { ...valid, goalVersion: 2 },
    { ...valid, rationale: ' ' },
    { ...valid, itemIds: [] },
    { ...valid, itemIds: ['missing'] },
    { ...valid, requirements: [] },
    { ...valid, kind: 'challenge' as const, owner: 'local' as const, requirementId: 'R99' },
  ]) assert.throws(() => runtime.review(session.id, input));
  assert.equal(runtime.events(session.id).length, before);
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = () => "Changed";\n');
  assert.throws(() => runtime.review(session.id, valid), /current|context/i);
  assert.equal(runtime.events(session.id).length, before);
});

test('review challenge budget escalates instead of starting an unlimited negotiation loop', t => {
  const { runtime, session, project, response, prepare } = setup(t);
  for (let round = 0; round < 2; round++) {
    const state = runtime.review(session.id, { ...response(), kind: 'challenge', requirementId: 'R1', owner: 'local', rationale: 'Investigate greeting ownership before accepting the requirement.' });
    const question = state.goal.uncertainties.at(-1);
    assert.ok(question);
    const source = prepare()[0];
    assert.ok(source);
    runtime.resolve(session.id, { uncertaintyId: question.id, source, answer: 'greeting.mjs owns this behavior.' });
  }
  runtime.review(session.id, { ...response(), kind: 'challenge', requirementId: 'R1', owner: 'local', rationale: 'The contract still needs investigation.' });
  assert.equal(runtime.next(session.id).kind, 'escalate');
  const reader = new Runtime(project, { readOnly: true });
  t.after(() => reader.close());
  const escalation = reader.events(session.id).find(({ event }) => event.payload.kind === 'contract.escalated');
  assert.ok(escalation?.event.payload.kind === 'contract.escalated');
  assert.equal(escalation.event.payload.review.rationale, 'The contract still needs investigation.');
  assert.equal(escalation.event.payload.review.requirementId, 'R1');
  assert.ok(escalation.event.payload.review.itemIds.length > 0);
  assert.equal(reader.next(session.id).kind, 'escalate');
  assert.throws(() => runtime.review(session.id, response()), /escalated/i);
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /escalated/i);
});

test('old event logs reopen with pending review rather than implicit contract acceptance', t => {
  const project = mkdtempSync(join(tmpdir(), 'optimizer-legacy-review-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const store = new Store(project);
  store.close();
  const body = JSON.stringify({ version: 1, id: 'start', sessionId: 'legacy', producer: 'runtime', at: '2026-10-26T00:00:00Z', payload: {
    kind: 'session.started', state: {
      id: 'legacy', goal: { request: 'greeting returns Hello', requirements: [{ id: 'R1', statement: 'greeting returns Hello', acceptance: 'greeting() is Hello', sourceLine: 1 }], uncertainties: [] },
      checks: [], decisions: [], context: null, assessment: null, control: { kind: 'running', rounds: 0 }, evidence: [], failureStreak: { signature: '', count: 0 }, completionClaimed: true,
    },
  } });
  const database = new DatabaseSync(join(project, '.optimizer', 'runtime.sqlite'));
  database.prepare('INSERT INTO events(session_id, producer, event_id, digest, body) VALUES(?,?,?,?,?)').run('legacy', 'runtime', 'start', createHash('sha256').update(body).digest('hex'), body);
  database.close();
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  assert.equal(runtime.get('legacy').goal.version, 1);
  assert.equal(runtime.get('legacy').review.kind, 'pending');
  assert.notEqual(runtime.next('legacy').kind, 'complete');
  const writer = new Store(project);
  t.after(() => writer.close());
  const original: unknown = JSON.parse(body);
  assert.equal(writer.append(original), 'duplicate');
  const changed: unknown = JSON.parse(body.replace('greeting returns Hello', 'greeting returns Goodbye'));
  assert.throws(() => writer.append(changed), /identity conflict/i);
  assert.equal(writer.events('legacy').length, 1);
});

test('review citations must cover acceptance and identify the challenged requirement', t => {
  const { runtime, project } = setup(t);
  writeFileSync(join(project, 'farewell.mjs'), 'export const farewell = () => "Goodbye";');
  const session = runtime.start({ request: '- R1: greeting returns Hello\nAcceptance R1: greeting() is Hello\n- R2: farewell returns Goodbye\nAcceptance R2: farewell() is Goodbye', checks: [] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'Both exported functions have source evidence.' });
  const greeting = context.items.find(item => item.path.endsWith('greeting.mjs'));
  assert.ok(greeting);
  const response = { kind: 'accept', goalVersion: 1, rationale: 'Both functions retain the user-requested return values.', itemIds: [greeting.id] } satisfies ReviewResponse;
  assert.throws(() => runtime.review(session.id, response), /cover every requirement/i);
  assert.throws(() => runtime.review(session.id, { ...response, kind: 'challenge', requirementId: 'R2', owner: 'local' }), /citations.*requirement/i);
  runtime.review(session.id, { ...response, itemIds: context.items.map(item => item.id) });
  assert.equal(runtime.next(session.id).kind, 'execute');
});

test('a contract review cannot clear an execution strategy pause', t => {
  const { runtime, session, project, response } = setup(t);
  writeFileSync(join(project, 'greeting.mjs'), 'export const greeting = () => "Wrong";');
  runtime.review(session.id, response());
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(runtime.runCheck(session.id, 'acceptance').result.outcome, 'failed');
  assert.equal(runtime.next(session.id).kind, 'reconsider');
  assert.throws(() => runtime.review(session.id, response()), /paused/i);
  assert.equal(runtime.next(session.id).kind, 'reconsider');
});
