import type { DecisionKind } from './controller.ts';
import type { CommandResult, Phase, SessionState } from './types.ts';

/** Hybrid decision engine pieces: deterministic features, pluggable rankers, and the gate's final authority. No learned model exists yet. */

export type DecisionAction = DecisionKind;
/** Numbers, booleans and enums only: goal, prompt and context text never enter features. */
export interface StateFeatures {
  phase: Phase;
  requirements: number;
  openHumanQuestions: number;
  openLocalQuestions: number;
  contextComplete: boolean | null;
  uncoveredRequirements: number;
  reviewState: 'pending' | 'accepted' | 'challenged' | 'policy';
  control: 'running' | 'paused' | 'escalated';
  failureStreak: number;
  reconsiderationRounds: number;
  checks: number;
  lastCheckOutcome: CommandResult['outcome'] | null;
  msSinceStart: number;
  events: number;
}
export interface RankedAction { action: DecisionAction; successProbability: number; expectedCostMs?: number | undefined; expectedTokens?: number | undefined; rationale: string }
export interface DecisionModel { version: string; rank(features: StateFeatures, actions: DecisionAction[]): RankedAction[] }

export function stateFeatures(state: SessionState, phase: Phase, info: { startedAt: string; events: number; now: number }): StateFeatures {
  const open = state.goal.uncertainties.filter(item => item.resolution.kind === 'open');
  return {
    phase,
    requirements: state.goal.requirements.length,
    openHumanQuestions: open.filter(item => item.owner === 'human').length,
    openLocalQuestions: open.filter(item => item.owner === 'local').length,
    contextComplete: state.context ? state.context.complete : null,
    uncoveredRequirements: state.context ? state.context.uncoveredRequirementIds.length : state.goal.requirements.length,
    reviewState: state.review.kind === 'pending' ? 'pending' : state.review.kind,
    control: state.control.kind,
    failureStreak: state.failureStreak.count,
    reconsiderationRounds: state.control.rounds,
    checks: state.checks.length,
    lastCheckOutcome: state.evidence.at(-1)?.result.outcome ?? null,
    msSinceStart: Math.max(0, info.now - Date.parse(info.startedAt)),
    events: info.events,
  };
}

/** Actions the gate permits now. Only PROCEED leaves a choice; every other decision is a mandatory checkpoint. */
export function availableActions(decision: DecisionKind): DecisionAction[] {
  return decision === 'PROCEED' ? ['PROCEED', 'RUN_VERIFICATION', 'RETRIEVE_CONTEXT'] : [decision];
}

/** rule-v0.1 wraps the deterministic decide(): its decision ranks first. */
export function ruleModel(decision: DecisionKind): DecisionModel {
  return {
    version: 'rule-v0.1',
    rank: (_features, actions) => [...actions]
      .sort((left, right) => Number(right === decision) - Number(left === decision))
      .map(action => ({ action, successProbability: action === decision ? 1 : 0, rationale: action === decision ? 'Deterministic controller decision' : 'Not the controller decision' })),
  };
}

/** A model only orders the allowed actions; anything it ranks outside them is ignored. */
export function chooseAction(model: DecisionModel, features: StateFeatures, allowed: DecisionAction[]): DecisionAction {
  const [fallback] = allowed;
  if (fallback === undefined) throw new Error('No allowed action');
  return model.rank(features, allowed).find(item => allowed.includes(item.action))?.action ?? fallback;
}

const shadowCandidates: Record<string, DecisionModel> = {
  // Test candidate: prefers refreshing context whenever that is allowed.
  'prefer-retrieve': {
    version: 'prefer-retrieve-v0',
    rank: (_features, actions) => [...actions]
      .sort((left, right) => Number(right === 'RETRIEVE_CONTEXT') - Number(left === 'RETRIEVE_CONTEXT'))
      .map((action, index) => ({ action, successProbability: index === 0 ? 0.5 : 0.25, rationale: 'Heuristic: fresh context first' })),
  },
};

/** Shadow models are recorded beside the real choice and never affect it; off unless OPTIMIZER_SHADOW_MODEL names a built-in candidate. */
export function shadowModel(name: string | undefined): DecisionModel | null {
  return name !== undefined && Object.hasOwn(shadowCandidates, name) ? shadowCandidates[name] ?? null : null;
}
