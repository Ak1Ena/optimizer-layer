import type { ContractReview, ReviewResponse } from './schema.ts';
import type { DecisionKind, VerificationOutcome } from './controller.ts';
import type { DecisionAction, RankedAction, StateFeatures } from './decision-model.ts';
export type { ContractReview, ReviewResponse } from './schema.ts';

export interface Requirement {
  id: string;
  statement: string;
  acceptance: string;
  /** Set when the acceptance is the controller default rather than user dialect text. */
  acceptanceSource?: 'project-checks' | undefined;
  sourceLine: number;
}
export type Resolution = { kind: 'open' } | { kind: 'resolved'; answer: string; source: string };
export interface Uncertainty {
  id: string;
  question: string;
  owner: 'human' | 'local';
  critical: boolean;
  resolution: Resolution;
}
export interface Goal {
  version: number;
  request: string;
  requirements: Requirement[];
  uncertainties: Uncertainty[];
}
export interface Check {
  id: string;
  requirementIds: string[];
  argv: [string, ...string[]];
  timeoutMs: number;
  artifacts: { path: string; digest: string }[];
}
export interface Decision {
  id: string;
  text: string;
  source: string;
  line: number;
  digest: string;
  timestamp: string;
  role: 'user';
  supersedes: string[];
}
export interface ContextItem {
  id: string;
  kind: 'code' | 'document' | 'decision';
  path: string;
  line: number;
  excerpt: string;
  digest: string;
  retrievedAt: string;
  requirementIds: string[];
  authority: 'untrusted' | 'user-decision';
}
export interface ContextSnapshot {
  items: ContextItem[];
  uncoveredRequirementIds: string[];
  diagnostics: string[];
  complete: boolean;
  projectDigest: string;
}
export type ContextAssessment =
  | { kind: 'sufficient'; rationale: string; itemIds: string[] }
  | { kind: 'insufficient'; rationale: string; itemIds: string[] };
export type Gate =
  | { kind: 'review'; reason: string }
  | { kind: 'proceed'; reason: string }
  | { kind: 'investigate'; reason: string }
  | { kind: 'clarify'; reason: string; uncertaintyIds: string[] };
export interface CommandResult {
  argv: string[];
  outcome: 'passed' | 'failed' | 'timeout' | 'spawn-error' | 'output-limit';
  exitCode: number | null;
  output: string;
  outputDigest: string;
  durationMs: number;
}
export interface VerificationEvidence {
  checkId: string;
  requirementIds: string[];
  projectDigest: string;
  result: CommandResult;
  at: string;
}
export type Control =
  | { kind: 'running'; rounds: number }
  | { kind: 'paused'; rounds: number; reason: string }
  | { kind: 'escalated'; rounds: number; reason: string };
export type Phase =
  | 'requested' | 'contract-proposed' | 'under-review' | 'context-check' | 'ready' | 'executing'
  | 'reconsidering' | 'verifying' | 'verified' | 'recovery' | 'blocked';
export interface SessionState {
  id: string;
  /** Last recorded workflow phase; absent in sessions persisted before phases existed. */
  phase?: Phase | undefined;
  /** Controller-started sessions record the hook-captured prompt they came from. */
  origin?: { promptId: string } | undefined;
  goal: Goal;
  checks: Check[];
  decisions: Decision[];
  context: ContextSnapshot | null;
  assessment: ContextAssessment | null;
  review: ContractReview;
  control: Control;
  evidence: VerificationEvidence[];
  failureStreak: { signature: string; count: number };
  completionClaimed: boolean;
}
export type NextAction =
  | { kind: 'review'; route: 'agent'; reason: string }
  | { kind: 'retrieve'; route: 'local'; reason: string }
  | { kind: 'clarify'; route: 'human'; reason: string; uncertaintyIds: string[] }
  | { kind: 'execute'; route: 'agent'; reason: string }
  | { kind: 'verify'; route: 'local'; reason: string }
  | { kind: 'reconsider'; route: 'agent'; reason: string }
  | { kind: 'escalate'; route: 'human'; reason: string }
  | { kind: 'complete'; route: 'none'; reason: string };
export type EventPayload =
  | { kind: 'session.started'; state: SessionState }
  | { kind: 'conversation.imported'; decisions: Decision[] }
  | { kind: 'context.retrieved'; context: ContextSnapshot }
  | { kind: 'context.assessed'; assessment: ContextAssessment }
  | { kind: 'contract.reviewed'; review: Exclude<ContractReview, { kind: 'pending' }> }
  | { kind: 'contract.escalated'; reason: string; review: Extract<ReviewResponse, { kind: 'challenge' }> }
  | { kind: 'uncertainty.resolved'; uncertaintyId: string; answer: string; source: string }
  | { kind: 'command.observed'; evidence: VerificationEvidence; control: Control; failureStreak: SessionState['failureStreak'] }
  | { kind: 'strategy.resolved'; rationale: string; strategy: 'retain' | 'revise'; control: Control }
  | { kind: 'completion.claimed' }
  | { kind: 'session.replaced'; replacedBy: string }
  | { kind: 'workflow.transitioned'; from: Phase | null; to: Phase; cause: string }
  | {
    kind: 'decision.recorded'; decisionId: string; features: StateFeatures; availableActions: DecisionAction[]; chosenAction: DecisionKind;
    decisionModelVersion: string; shadow?: { version: string; ranking: RankedAction[] } | undefined;
  }
  | {
    kind: 'decision.outcome'; outcome: VerificationOutcome | 'BLOCKED'; verificationProgress: { verified: number; total: number };
    goalSatisfied: boolean; additionalTokens: null; decisions: { decisionId: string; additionalTimeMs: number }[];
  };
export interface Event {
  version: 1;
  id: string;
  sessionId: string;
  producer: string;
  at: string;
  payload: EventPayload;
}
export interface Measurement {
  operation: string;
  elapsedMs: number;
  externalMs: number;
  optimizerMs: number;
  at: string;
}
