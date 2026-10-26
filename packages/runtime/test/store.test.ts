import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { Event, SessionState } from '../src/types.ts';

function fixture(): SessionState {
  return {
    id: 'session-1',
    goal: { version: 1, request: 'Fix counter', requirements: [{ id: 'R1', statement: 'Fix counter', acceptance: 'Counter passes tests', sourceLine: 1 }], uncertainties: [] },
    checks: [], decisions: [], context: null, assessment: null, review: { kind: 'pending' },
    control: { kind: 'running', rounds: 0 }, evidence: [],
    failureStreak: { signature: '', count: 0 }, completionClaimed: false,
  };
}

test('events survive restart and retries do not duplicate a completion claim', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'optimizer-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const started: Event = { version: 1, id: 'start', sessionId: 'session-1', producer: 'test', at: '2026-10-26T00:00:00Z', payload: { kind: 'session.started', state: fixture() } };
  assert.equal(store.append(started), 'accepted');
  const claim: Event = { ...started, id: 'claim', payload: { kind: 'completion.claimed' } };
  assert.equal(store.append(claim), 'accepted');
  assert.equal(store.append(claim), 'duplicate');
  assert.throws(() => store.append({ ...claim, at: '2026-10-26T00:00:01Z' }), /conflict/i);
  assert.equal(store.get('session-1').completionClaimed, true);
  store.close();
  const reopened = new Store(root);
  t.after(() => reopened.close());
  assert.equal(reopened.get('session-1').completionClaimed, true);
  assert.deepEqual(reopened.events('session-1').map((item) => item.sequence), [1, 2]);
  assert.throws(() => reopened.get('another-project-session'), /Unknown session/);
});

test('invalid event versions and session identity fail before persistence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'optimizer-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  t.after(() => store.close());
  assert.throws(() => store.append({ version: 99 }), /version|Invalid/i);
  assert.throws(() => store.append({ version: 1, id: 'start', sessionId: 'other', producer: 'test', at: '2026-10-26T00:00:00Z', payload: { kind: 'session.started', state: fixture() } }), /identity/i);
});

test('read-only sessions preserve observations and cannot create or mutate a store', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'optimizer-readonly-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new Store(root, { readOnly: true }), /initializ|open/i);
  const writer = new Store(root);
  writer.append({ version: 1, id: 'start', sessionId: 'session-1', producer: 'test', at: '2026-10-26T00:00:00Z', payload: { kind: 'session.started', state: fixture() } });
  writer.close();
  const reader = new Store(root, { readOnly: true });
  t.after(() => reader.close());
  assert.equal(reader.get('session-1').completionClaimed, false);
  assert.throws(() => reader.update('session-1', () => ({ kind: 'completion.claimed' })), /read.only/i);
  assert.equal(reader.events('session-1').length, 1);
});
