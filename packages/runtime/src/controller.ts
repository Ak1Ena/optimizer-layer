import { classifyBash, reservedPath, type BashContext } from './bash.ts';
import { nextAction } from './intelligence.ts';
export { inexpensiveCheckMs, lightTierBlocker } from './intelligence.ts';
import type { ProjectConfig } from './schema.ts';
import type { NextAction, Phase, SessionState } from './types.ts';

/** Pure workflow policy: phases, decisions, the action gate and verification outcomes. No I/O, no LLM. */

export type DecisionKind = 'PROCEED' | 'RETRIEVE_CONTEXT' | 'INVESTIGATE' | 'ASK_HUMAN' | 'REVIEW_CONTRACT' | 'RUN_VERIFICATION' | 'REQUEST_RECONSIDERATION' | 'BLOCK_ACTION' | 'COMPLETE';
export interface Decision { decision: DecisionKind; reason: string; requiredBy: 'agent' | 'human' | 'none'; phase: Phase; needsHuman: boolean }
export type VerificationOutcome = 'VERIFIED' | 'FAILED' | 'INCONCLUSIVE' | 'NEEDS_HUMAN_REVIEW';
export type ActionKind = 'read' | 'protected' | 'verification' | 'control';
export { classifyBash } from './bash.ts';
export interface GateAction { kind: ActionKind; tool: string; target?: string; reserved?: boolean }
export interface GateContext { managed: boolean; available: boolean; active?: boolean; next?: NextAction }
export interface GateVerdict { allow: boolean; decision: DecisionKind; reason: string }

export const projectChecksAcceptance = 'Every user-approved project check passes against the final source.';

export const lightTierRule = 'Light tier: the user-approved project checks define acceptance, no question is open and the checks are inexpensive, so context sufficiency and contract review are satisfied by policy.';
/** Managed = tracked by the installed hook mode and verifiable by at least one user-approved check. */
export function managedProject(config: ProjectConfig | null, mode: string | undefined): boolean {
  const optIn = mode !== undefined && mode !== 'always-on' && mode !== 'managed';
  return config?.enabled === true && (!optIn || config.optedIn === true) && config.checks.length > 0;
}

export function phaseFor(state: SessionState, next: NextAction = nextAction(state)): Phase {
  if (state.control.kind === 'paused') return 'reconsidering';
  if (state.control.kind === 'escalated' || next.kind === 'escalate') return 'blocked';
  if (next.kind === 'clarify') return 'contract-proposed';
  if (next.kind === 'retrieve') return 'context-check';
  if (next.kind === 'review') return 'under-review';
  if (next.kind === 'complete') return 'verified';
  if (state.failureStreak.count > 0) return 'recovery';
  if (next.kind === 'verify') return 'verifying';
  return state.evidence.length || state.completionClaimed || state.phase === 'executing' ? 'executing' : 'ready';
}

const decisions = {
  review: 'REVIEW_CONTRACT', clarify: 'ASK_HUMAN', escalate: 'ASK_HUMAN', execute: 'PROCEED',
  verify: 'RUN_VERIFICATION', reconsider: 'REQUEST_RECONSIDERATION', complete: 'COMPLETE',
} as const;

export function decide(state: SessionState, next: NextAction = nextAction(state)): Decision {
  const needsHuman = next.kind === 'clarify' || next.kind === 'escalate';
  // A recorded block (stop budget) holds until a checkpoint command records a new phase.
  const phase = state.phase === 'blocked' ? 'blocked' : phaseFor(state, next);
  const requiredBy = next.route === 'human' ? 'human' : next.route === 'none' ? 'none' : 'agent';
  if (phase === 'blocked' && !needsHuman && next.kind !== 'complete') {
    return { decision: 'BLOCK_ACTION', reason: `Task is blocked and unverified. Report the blocker to the user, or resume through an optimizer checkpoint command (next action: ${next.kind}: ${next.reason})`, requiredBy, phase, needsHuman };
  }
  const decision = next.kind === 'retrieve' ? (state.context ? 'INVESTIGATE' : 'RETRIEVE_CONTEXT') : decisions[next.kind];
  return { decision, reason: next.reason, requiredBy, phase, needsHuman };
}

export function verificationOutcome(state: SessionState, next: NextAction = nextAction(state)): VerificationOutcome {
  if (next.kind === 'complete') return 'VERIFIED';
  const unmapped = state.goal.requirements.some(requirement => !state.checks.some(check => check.requirementIds.includes(requirement.id)));
  if (unmapped || next.kind === 'clarify') return 'NEEDS_HUMAN_REVIEW';
  const digest = state.context?.projectDigest;
  const failed = state.checks.some(check => {
    const latest = state.evidence.findLast(evidence => evidence.checkId === check.id);
    return digest !== undefined && latest?.projectDigest === digest && latest.result.outcome === 'failed';
  });
  if (failed) return 'FAILED';
  return next.kind === 'escalate' ? 'NEEDS_HUMAN_REVIEW' : 'INCONCLUSIVE';
}

/** Runtime state, approvals and hook-only commands are never agent-writable, managed or not. */
export function reservedAction(action: GateAction): boolean {
  return action.kind !== 'read' && (action.reserved === true || (action.target !== undefined && reservedPath.test(action.target)));
}

export function evaluate(state: SessionState | null, action: GateAction, context: GateContext): GateVerdict {
  if (reservedAction(action)) return { allow: false, decision: 'BLOCK_ACTION', reason: 'optimizer: runtime state, approvals, hook tokens and hook-only commands belong to the user and the optimizer hook.' };
  if (action.kind !== 'protected') return { allow: true, decision: state ? decide(state, context.next).decision : 'PROCEED', reason: `${action.kind} action is not gated` };
  if (!context.available) {
    return (context.active ?? state !== null)
      ? { allow: false, decision: 'BLOCK_ACTION', reason: 'optimizer unavailable: a managed task is active and the runtime cannot answer, so protected actions are denied. Read-only actions still work.' }
      : { allow: true, decision: 'PROCEED', reason: 'optimizer unavailable outside a managed task; failing open' };
  }
  if (!context.managed) return { allow: true, decision: 'PROCEED', reason: 'Unmanaged project (no approved check); edits are advisory' };
  if (!state) return { allow: false, decision: 'BLOCK_ACTION', reason: 'Managed project without an open goal contract; the controller starts one from the latest captured user prompt' };
  const checkpoint = decide(state, context.next);
  if (checkpoint.decision === 'PROCEED' || checkpoint.decision === 'RUN_VERIFICATION' || checkpoint.decision === 'COMPLETE') {
    return { allow: true, decision: checkpoint.decision, reason: checkpoint.reason };
  }
  return { allow: false, decision: 'BLOCK_ACTION', reason: `${checkpoint.decision}: ${checkpoint.reason}` };
}

const readTools = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'ToolSearch']);
export function classifyTool(tool: string, input: Record<string, unknown>, checks: readonly (readonly string[])[] = [], context: BashContext = {}): GateAction {
  if (readTools.has(tool)) return { kind: 'read', tool };
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return { ...classifyBash(command, checks, context), tool, target: command };
  }
  const target = [input.file_path, input.notebook_path, input.path].find(value => typeof value === 'string');
  return typeof target === 'string' ? { kind: 'protected', tool, target } : { kind: 'protected', tool };
}
