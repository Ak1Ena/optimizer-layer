import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costBreakdown, hookTracePath, readHookTraces } from '../src/cost.ts';
import type { Event } from '../src/types.ts';

function project(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-cost-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const line = (fields: Record<string, unknown> = {}) => JSON.stringify({
  at: '2026-10-27T00:00:00.000Z', sessionId: 's1', event: 'PreToolUse', elapsedMs: 120, injectedAs: ['permissionDecisionReason'], injectedBytes: 42,
  calls: [{ command: 'gate', elapsedMs: 80, ok: true }], ...fields,
});

test('hook traces: malformed, invalid and other-session lines are skipped', (t) => {
  const root = project(t);
  mkdirSync(join(root, '.optimizer'));
  writeFileSync(hookTracePath(root), [
    line(), '{not json', line({ sessionId: 's2' }), line({ elapsedMs: -1 }), line({ injectedBytes: 'many' }), line({ elapsedMs: null }),
    line({ calls: [{ command: 'gate', elapsedMs: -5, ok: true }] }), line({ calls: [{ command: 'gate' }] }), line({ calls: 'gate' }), line({ injectedAs: 'reason' }),
    line({ event: 'Stop', injectedAs: ['reason'], injectedBytes: 10, calls: [] }), '',
  ].join('\n'));
  const traces = readHookTraces(root, 's1');
  assert.deepEqual(traces.map(trace => trace.event), ['PreToolUse', 'Stop']);
  const cost = costBreakdown([], [], traces);
  assert.deepEqual(cost.injected, { systemPromptBytes: null, hookBytes: 52, subagentBytes: 0, byEvent: { PreToolUse: { injections: 1, bytes: 42 }, Stop: { injections: 1, bytes: 10 } } });
  assert.equal(cost.rework.stopBlocks, 1);
  assert.deepEqual(cost.hooks.byCommand, { gate: { calls: 1, elapsedMs: 80, failed: 0 } });
  assert.deepEqual(readHookTraces(root, 's2').length, 1, 'the other session sees only its own line');
});

test('hook traces: SubagentStart bytes are reported apart from the main agent', (t) => {
  const root = project(t);
  mkdirSync(join(root, '.optimizer'));
  writeFileSync(hookTracePath(root), [line(), line({ event: 'SubagentStart', injectedAs: ['additionalContext'], injectedBytes: 7, calls: [] })].join('\n'));
  const { injected } = costBreakdown([], [], readHookTraces(root, 's1'));
  assert.equal(injected.hookBytes, 42);
  assert.equal(injected.subagentBytes, 7);
});

test('hook traces are never read through a symlinked file or a symlinked .optimizer directory', (t) => {
  const root = project(t);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'hook-metrics.jsonl'), line());
  mkdirSync(join(root, '.optimizer'));
  symlinkSync(join(elsewhere, 'hook-metrics.jsonl'), hookTracePath(root));
  assert.deepEqual(readHookTraces(root, 's1'), []);
  const linked = project(t);
  symlinkSync(elsewhere, join(linked, '.optimizer'));
  assert.equal(readFileSync(hookTracePath(linked), 'utf8'), line(), 'the file is reachable through the link');
  assert.deepEqual(readHookTraces(linked, 's1'), []);
  assert.deepEqual(readHookTraces(project(t), 's1'), [], 'a project without traces has none');
});

test('agent usage: token fields that are absent or not numbers stay null', () => {
  const event: Event = {
    version: 1, id: 'e1', sessionId: 's1', producer: 'test', at: '2026-10-27T00:00:00.000Z',
    payload: { kind: 'agent.usage', source: 'claude-code-json', systemPromptBytes: 900, turns: 3, totalCostUsd: null, durationMs: null, durationApiMs: null, usage: { input_tokens: '7', output_tokens: 5 }, modelUsage: null },
  };
  const { agent, injected } = costBreakdown([event], [], []);
  assert.equal(agent.inputTokens, null);
  assert.equal(agent.outputTokens, 5);
  assert.equal(agent.cacheReadTokens, null);
  assert.equal(agent.iterations, null);
  assert.equal(agent.turns, 3);
  assert.equal(injected.systemPromptBytes, 900);
});

test('cost breakdown with nothing recorded: counts clamp at zero and unknowns stay null', () => {
  const cost = costBreakdown([], [{ operation: 'future-op', elapsedMs: 3, externalMs: 0, optimizerMs: 3, at: '2026-10-27T00:00:00.000Z' }], []);
  assert.equal(cost.rework.retrievals, 0);
  assert.equal(cost.rework.reRetrievals, 0);
  assert.equal(cost.rework.reAssessments, 0);
  assert.equal(cost.rework.reReviews, 0);
  assert.equal(cost.rework.revertedEdits, null);
  assert.deepEqual(cost.components.other, { operations: 1, elapsedMs: 3, externalMs: 0, optimizerMs: 3, modelTokens: null }, 'an unmapped operation claims no model usage');
  assert.equal(cost.components.decision.modelTokens, 0);
  assert.equal(cost.agent.inputTokens, null);
  assert.equal(cost.tier.initial, null);
});
