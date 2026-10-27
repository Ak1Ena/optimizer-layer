import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Event, Measurement } from './types.ts';

/** Written by the Claude Code hook, one line per hook invocation; read here only for the cost breakdown. */
export interface HookTrace {
  at: string;
  sessionId: string;
  event: string;
  /** Wall clock of the whole hook process, Node.js startup included. */
  elapsedMs: number;
  /** Which hook output fields reached the model, and their summed exact UTF-8 bytes; 0 when the hook injected nothing. */
  injectedAs: string[];
  injectedBytes: number;
  calls: { command: string; elapsedMs: number; ok: boolean }[];
}

export const hookTracePath = (projectRoot: string) => join(projectRoot, '.optimizer', 'hook-metrics.jsonl');
// shortcut: the hook never rotates hook-metrics.jsonl, so only its last 16 MiB are read; add rotation if long-lived projects need older sessions.
const traceReadLimit = 16 * 1024 * 1024;

/** Which optimizer component each measured runtime operation belongs to; an unlisted operation lands in `other`, whose model usage is unknown. */
const componentOf: Record<string, Component> = {
  start: 'goalIntelligence', 'import-history': 'goalIntelligence', 'import-prompt': 'goalIntelligence', resolve: 'goalIntelligence', review: 'goalIntelligence',
  retrieve: 'contextRetrieval', assess: 'contextRetrieval',
  open: 'decision', status: 'decision', next: 'decision', decide: 'decision', gate: 'decision', phase: 'decision', block: 'decision',
  reconsider: 'replanning',
  check: 'verification', claim: 'verification',
};
type Component = 'goalIntelligence' | 'contextRetrieval' | 'decision' | 'replanning' | 'verification' | 'other';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCall = (value: unknown) => isRecord(value) && typeof value.command === 'string' && duration(value.elapsedMs) && typeof value.ok === 'boolean';

/** Malformed, foreign or other-session lines are skipped, never repaired into numbers. */
function parseTrace(line: string, sessionId: string): HookTrace | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.sessionId !== sessionId || typeof value.event !== 'string' || typeof value.at !== 'string') return null;
    if (!duration(value.elapsedMs) || !duration(value.injectedBytes) || !Array.isArray(value.injectedAs) || !value.injectedAs.every(item => typeof item === 'string')) return null;
    if (!Array.isArray(value.calls) || !value.calls.every(isCall)) return null;
    return value as unknown as HookTrace;
  } catch {
    return null;
  }
}

export function readHookTraces(projectRoot: string, sessionId: string): HookTrace[] {
  let descriptor: number;
  try {
    // Same rule as the writer: never through a symlinked .optimizer directory or a symlinked file.
    if (lstatSync(join(projectRoot, '.optimizer')).isSymbolicLink()) return [];
    descriptor = openSync(hookTracePath(projectRoot), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, traceReadLimit);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const needle = JSON.stringify({ sessionId }).slice(1, -1);
    // A cut first line fails to parse and is skipped; the substring test avoids parsing other sessions' lines.
    return buffer.toString('utf8').split('\n').flatMap(line => {
      const trace = line.includes(needle) ? parseTrace(line, sessionId) : null;
      return trace ? [trace] : [];
    });
  } finally {
    closeSync(descriptor);
  }
}

const number = (value: unknown): number | null => typeof value === 'number' ? value : null;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Where one session's cost went, from recorded sources only: what nobody measured stays null. */
export function costBreakdown(events: Event[], measurements: Measurement[], traces: HookTrace[]) {
  const payloads = events.map(event => ({ ...event.payload, at: event.at }));
  const reported = payloads.findLast(item => item.kind === 'agent.usage');
  const usage = reported?.kind === 'agent.usage' ? reported.usage : null;
  const agent = reported?.kind === 'agent.usage'
    ? {
      source: reported.source, turns: reported.turns, totalCostUsd: reported.totalCostUsd, durationMs: reported.durationMs, durationApiMs: reported.durationApiMs,
      inputTokens: number(usage?.input_tokens), cacheReadTokens: number(usage?.cache_read_input_tokens), cacheWriteTokens: number(usage?.cache_creation_input_tokens),
      outputTokens: number(usage?.output_tokens), iterations: Array.isArray(usage?.iterations) ? usage.iterations : null, modelUsage: reported.modelUsage,
    }
    : {
      source: null, turns: null, totalCostUsd: null, durationMs: null, durationApiMs: null, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      outputTokens: null, iterations: null, modelUsage: null,
      note: 'Not measured: only `optimizer run` receives the agent\'s usage from Claude Code; hook mode does not read transcripts (spec Q4).',
    };

  const components = Object.fromEntries((['goalIntelligence', 'contextRetrieval', 'decision', 'replanning', 'verification', 'other'] as const).map(name => {
    const rows = measurements.filter(item => (componentOf[item.operation] ?? 'other') === name);
    // The mapped components call no model, a measured zero; an unmapped operation's model usage is unknown.
    return [name, { operations: rows.length, elapsedMs: sum(rows.map(item => item.elapsedMs)), externalMs: sum(rows.map(item => item.externalMs)), optimizerMs: sum(rows.map(item => item.optimizerMs)), modelTokens: name === 'other' ? null : 0 }];
  })) as Record<Component, { operations: number; elapsedMs: number; externalMs: number; optimizerMs: number; modelTokens: 0 | null }>;

  const group = <T>(keys: string[], value: (key: string) => T) => Object.fromEntries([...new Set(keys)].map(key => [key, value(key)]));
  const calls = traces.flatMap(trace => trace.calls);
  const hooks = {
    invocations: traces.length, elapsedMs: sum(traces.map(trace => trace.elapsedMs)), runtimeCalls: calls.length, runtimeCallMs: sum(calls.map(call => call.elapsedMs)),
    byEvent: group(traces.map(trace => trace.event), event => {
      const rows = traces.filter(trace => trace.event === event);
      return { invocations: rows.length, elapsedMs: sum(rows.map(trace => trace.elapsedMs)), runtimeCalls: sum(rows.map(trace => trace.calls.length)) };
    }),
    byCommand: group(calls.map(call => call.command), command => {
      const rows = calls.filter(call => call.command === command);
      return { calls: rows.length, elapsedMs: sum(rows.map(call => call.elapsedMs)), failed: rows.filter(call => !call.ok).length };
    }),
  };
  const shown = traces.filter(trace => trace.injectedBytes > 0);
  const bytesOf = (rows: HookTrace[]) => sum(rows.map(trace => trace.injectedBytes));
  const injected = {
    systemPromptBytes: reported?.kind === 'agent.usage' ? reported.systemPromptBytes : null,
    // SubagentStart context goes to a subagent, not to the main agent.
    hookBytes: bytesOf(shown.filter(trace => trace.event !== 'SubagentStart')),
    subagentBytes: bytesOf(shown.filter(trace => trace.event === 'SubagentStart')),
    byEvent: group(shown.map(trace => trace.event), event => {
      const rows = shown.filter(trace => trace.event === event);
      return { injections: rows.length, bytes: bytesOf(rows) };
    }),
  };

  const tiers = payloads.flatMap(item => item.kind === 'tier.decided' ? [{ tier: item.tier, trigger: item.trigger, at: item.at }] : []);
  const checks = payloads.flatMap(item => item.kind === 'command.observed' ? [item.evidence.result.outcome] : []);
  const count = (kind: string, keep: (item: (typeof payloads)[number]) => boolean = () => true) => payloads.filter(item => item.kind === kind && keep(item)).length;
  const retrievals = count('context.retrieved');
  const assessments = count('context.assessed', item => item.kind === 'context.assessed' && item.assessment.kind !== 'policy');
  const reviews = count('contract.reviewed', item => item.kind === 'contract.reviewed' && item.review.kind !== 'policy');
  const rework = {
    checksRun: checks.length, failedChecks: checks.filter(outcome => outcome !== 'passed').length,
    retrievals, reRetrievals: Math.max(0, retrievals - 1),
    agentAssessments: assessments, reAssessments: Math.max(0, assessments - 1),
    agentReviews: reviews, reReviews: Math.max(0, reviews - 1),
    challenges: count('contract.reviewed', item => item.kind === 'contract.reviewed' && item.review.kind === 'challenged') + count('contract.escalated'),
    reconsiderations: count('strategy.resolved'),
    stopBlocks: traces.filter(trace => trace.event === 'Stop' && trace.injectedAs.includes('reason')).length,
    blocked: count('workflow.transitioned', item => item.kind === 'workflow.transitioned' && item.to === 'blocked'),
    // Not observed: the runtime sees file digests, not which edits undid earlier ones.
    revertedEdits: null,
  };
  return { tier: { initial: tiers[0] ?? null, escalations: tiers.slice(1) }, agent, injected, components, hooks, rework };
}
