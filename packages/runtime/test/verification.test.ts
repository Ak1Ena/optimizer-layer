import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';

test('changing an external acceptance runner cannot turn a failing requirement into a pass', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-verifier-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'parseCount.mjs'), 'export const parseCount = () => 0;');
  const verifier = join(root, 'acceptance.mjs');
  writeFileSync(verifier, 'process.exitCode = 1;');
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: parseCount works\nAcceptance R1: parseCount passes acceptance', checks: [{ id: 'acceptance', requirementIds: ['R1'], argv: [process.execPath, verifier], timeoutMs: 1000 }] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The parseCount source identifies the code under test.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  writeFileSync(verifier, 'process.exitCode = 0;');
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /verifier|artifact/i);
  assert.notEqual(runtime.next(session.id).kind, 'complete');
});

test('a changed verifier invalidates requirement labels as well as the completion action of an unfinished session', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-stale-proof-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'parseCount.txt'), 'parseCount implementation');
  const verifier = join(root, 'acceptance.mjs');
  writeFileSync(verifier, 'process.exitCode=0;');
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  // R2 stays unverified, so the session is still open when the verifier changes.
  const session = runtime.start({ request: '- R1: parseCount works\nAcceptance R1: parseCount passes acceptance\n- R2: parseCount is documented\nAcceptance R2: docs check passes', checks: [
    { id: 'acceptance', requirementIds: ['R1'], argv: [process.execPath, verifier], timeoutMs: 1000 },
    { id: 'docs', requirementIds: ['R2'], argv: [process.execPath, '-e', 'process.exitCode=1'], timeoutMs: 1000 },
  ] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The parseCount source covers the requirements.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  assert.deepEqual(runtime.verify(session.id).verifiedRequirementIds, ['R1']);
  writeFileSync(verifier, 'process.exitCode=1;');
  const result = runtime.verify(session.id);
  assert.equal(result.action.kind, 'escalate');
  assert.deepEqual(result.verifiedRequirementIds, []);
});

test('a verifier executed directly is pinned as an artifact, including argv zero', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-executable-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'parseCount.txt'), 'parseCount implementation');
  const verifier = join(root, 'acceptance.sh');
  writeFileSync(verifier, '#!/bin/sh\nexit 1\n');
  chmodSync(verifier, 0o700);
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: parseCount works\nAcceptance R1: parseCount passes acceptance', checks: [{ id: 'acceptance', requirementIds: ['R1'], argv: [verifier], timeoutMs: 1000 }] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The parseCount source identifies the implementation.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  writeFileSync(verifier, '#!/bin/sh\nexit 0\n');
  assert.throws(() => runtime.runCheck(session.id, 'acceptance'), /verifier|artifact/i);
  assert.equal(runtime.next(session.id).kind, 'escalate');
});

test('operators can pin verifier helper files without supplying fake digests', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-helper-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'parseCount.txt'), 'parseCount implementation');
  const helper = join(root, 'helper.mjs');
  writeFileSync(helper, 'export const accepted = false;');
  const runner = join(root, 'acceptance.mjs');
  writeFileSync(runner, "import {accepted} from './helper.mjs'; process.exitCode=accepted?0:1;");
  const runtime = new Runtime(project);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: parseCount works\nAcceptance R1: parseCount passes acceptance', checks: [{ id: 'acceptance', requirementIds: ['R1'], argv: [process.execPath, runner], timeoutMs: 1000, artifactFiles: [helper] }] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The parseCount source and registered verifier identify the acceptance check.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  assert.equal(runtime.verify(session.id).outcome, 'FAILED');
  writeFileSync(helper, 'export const accepted = true;');
  assert.equal(runtime.next(session.id).kind, 'escalate');
  assert.deepEqual(runtime.verify(session.id).verifiedRequirementIds, []);
});

test('bounded reconsideration rounds escalate a persistently failing strategy to the human', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-budget-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'counter.txt'), 'parseCount implementation needs work');
  const runtime = new Runtime(root);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: parseCount works\nAcceptance R1: parseCount passes acceptance', checks: [{ id: 'failure', requirementIds: ['R1'], argv: [process.execPath, '-e', 'process.exitCode=1'], timeoutMs: 1000 }] });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'The parseCount source is located for this failing strategy.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  for (let round = 0; round < 3; round++) {
    for (let attempt = 0; attempt < 3; attempt++) runtime.runCheck(session.id, 'failure');
    if (round < 2) runtime.reconsider(session.id, { strategy: 'retain', rationale: 'The evidence identifies a local issue; continue the same plan with a focused repair.' });
  }
  assert.equal(runtime.next(session.id).kind, 'escalate');
  assert.throws(() => runtime.reconsider(session.id, { strategy: 'revise', rationale: 'Try again.' }), /paused/);
});
