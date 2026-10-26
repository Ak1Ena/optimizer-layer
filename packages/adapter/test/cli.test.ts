import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runOptimizer, type OptimizerCommand } from '../src/index.ts';

function property(value: unknown, name: string): unknown {
  assert.ok(value !== null && typeof value === 'object' && name in value);
  return Reflect.get(value, name);
}

test('real CLI checkpoints clarify, pause, reconsider and independently verify agent edits', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-adapter-cli-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, 'project');
  mkdirSync(projectRoot);
  const sourcePath = join(projectRoot, 'greeting.mjs');
  writeFileSync(sourcePath, 'export const greeting = () => "wrong";\n');
  const checker = join(directory, 'acceptance.mjs');
  writeFileSync(checker, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { greeting } = await import(pathToFileURL(process.argv[2]));
assert.equal(greeting('Ada'), 'Hello Ada');
`);
  const requestPath = join(directory, 'goal.md');
  writeFileSync(requestPath, '- R1: greeting returns a personalized greeting.\nAcceptance R1: greeting of Ada returns Hello Ada.\nQuestion human Q1: Which greeting language is required?\n');
  const checksPath = join(directory, 'checks.json');
  writeFileSync(checksPath, JSON.stringify([{ id: 'acceptance', requirementIds: ['R1'], argv: [process.execPath, checker, sourcePath], timeoutMs: 2000 }]));
  const historyPath = join(directory, 'conversation.jsonl');
  writeFileSync(historyPath, JSON.stringify({ id: 'prior', projectRoot, role: 'user', content: 'Decision: The greeting must say Hello in English.', timestamp: '2026-10-26T00:00:00Z' }) + '\n');
  let sessionId: string | undefined;
  function request(command: OptimizerCommand, options: Record<string, string | number> = {}) {
    return runOptimizer({
      executable: process.execPath,
      args: [fileURLToPath(new URL('../../runtime/src/cli.ts', import.meta.url))],
      projectRoot, command, options,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }
  function checkpoint(command: OptimizerCommand, options: Record<string, string | number> = {}, exitCode = 0): unknown {
    const result = request(command, options);
    assert.equal(result.kind, 'response', JSON.stringify(result));
    assert.ok(result.kind === 'response');
    assert.equal(result.exitCode, exitCode, JSON.stringify(result.value));
    return result.value;
  }
  const started = checkpoint('start', { request: requestPath, checks: checksPath });
  const id = property(started, 'id');
  assert.equal(typeof id, 'string');
  assert.ok(typeof id === 'string');
  sessionId = id;
  assert.equal(property(checkpoint('next'), 'kind'), 'clarify');
  assert.equal(request('check', { check: 'acceptance' }).kind, 'runtime-error');
  checkpoint('history', { file: historyPath });
  checkpoint('resolve', { question: 'Q1', source: 'prior:decision:1' });
  function assessCurrentContext() {
    const items = property(checkpoint('retrieve'), 'items');
    assert.ok(Array.isArray(items));
    const ids = items.map((item: unknown) => {
      const itemId = property(item, 'id');
      assert.ok(typeof itemId === 'string');
      return itemId;
    });
    checkpoint('assess', { kind: 'sufficient', items: ids.join(','), rationale: 'The current greeting source and imported English language decision cover R1 and its acceptance criterion.' });
  }
  assessCurrentContext();
  assert.equal(property(checkpoint('next'), 'kind'), 'review');
  assert.equal(request('check', { check: 'acceptance' }).kind, 'runtime-error');
  const state = property(checkpoint('status'), 'state');
  const goal = property(state, 'goal');
  const version = property(goal, 'version');
  assert.ok(typeof version === 'number');
  const contextItems = property(property(state, 'context'), 'items');
  assert.ok(Array.isArray(contextItems));
  const reviewItems = contextItems.map((item: unknown) => property(item, 'id')).join(',');
  checkpoint('review', { kind: 'challenge', version, items: reviewItems, requirement: 'R1', owner: 'local', rationale: 'Confirm that greeting.mjs owns the personalized greeting.' });
  assert.equal(property(checkpoint('next'), 'kind'), 'retrieve');
  const source = property(contextItems[0], 'id');
  assert.ok(typeof source === 'string');
  checkpoint('resolve', { question: 'review:1', source, answer: 'greeting.mjs exports the greeting function under test.' });
  assessCurrentContext();
  const reviewedGoal = property(property(checkpoint('status'), 'state'), 'goal');
  const reviewedVersion = property(reviewedGoal, 'version');
  assert.ok(typeof reviewedVersion === 'number');
  assert.equal(request('review', { kind: 'accept', version, items: reviewItems, rationale: 'Stale response must not be accepted.' }).kind, 'runtime-error');
  checkpoint('review', { kind: 'accept', version: reviewedVersion, items: reviewItems, rationale: 'R1 and its acceptance preserve the requested personalized English greeting.' });
  assert.equal(property(checkpoint('next'), 'kind'), 'execute');
  checkpoint('claim');
  assert.equal(property(checkpoint('next'), 'kind'), 'verify');
  for (let attempt = 0; attempt < 3; attempt++) {
    const checked = checkpoint('check', { check: 'acceptance' }, 1);
    assert.equal(property(property(property(checked, 'evidence'), 'result'), 'outcome'), 'failed');
  }
  assert.equal(property(checkpoint('next'), 'kind'), 'reconsider');
  assert.equal(request('check', { check: 'acceptance' }).kind, 'runtime-error');
  checkpoint('reconsider', { strategy: 'retain', rationale: 'The independent test shows the greeting ignores its input. Retain the function and return the confirmed English greeting plus the supplied name.' });
  writeFileSync(sourcePath, 'export const greeting = name => `Hello ${name}`;\n');
  assert.equal(property(checkpoint('next'), 'kind'), 'retrieve');
  assessCurrentContext();
  const refreshed = property(checkpoint('status'), 'state');
  const refreshedQuestions = property(property(refreshed, 'goal'), 'uncertainties');
  assert.ok(Array.isArray(refreshedQuestions));
  const reopened = refreshedQuestions.find((item: unknown) => property(item, 'id') === 'review:1');
  assert.equal(property(property(reopened, 'resolution'), 'kind'), 'open');
  const refreshedItems = property(property(refreshed, 'context'), 'items');
  assert.ok(Array.isArray(refreshedItems));
  const refreshedSource = property(refreshedItems[0], 'id');
  assert.ok(typeof refreshedSource === 'string');
  checkpoint('resolve', { question: 'review:1', source: refreshedSource, answer: 'The updated greeting.mjs still owns personalized greeting behavior.' });
  assessCurrentContext();
  const finalVersion = property(property(property(checkpoint('status'), 'state'), 'goal'), 'version');
  assert.ok(typeof finalVersion === 'number');
  checkpoint('review', { kind: 'accept', version: finalVersion, items: refreshedItems.map((item: unknown) => property(item, 'id')).join(','), rationale: 'The refreshed ownership evidence supports the unchanged user requirement and independent acceptance.' });
  const verified = checkpoint('verify');
  assert.equal(property(property(verified, 'action'), 'kind'), 'complete');
  assert.deepEqual(property(verified, 'verifiedRequirementIds'), ['R1']);
  const status = checkpoint('status');
  assert.equal(property(property(status, 'action'), 'kind'), 'complete');
  const events = checkpoint('events', { limit: 2 });
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 2);
  const metrics = checkpoint('metrics');
  assert.ok(Array.isArray(metrics));
  assert.ok(metrics.length > 0);
});
