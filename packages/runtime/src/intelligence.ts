import type { Check, Gate, Goal, NextAction, SessionState, Uncertainty, VerificationEvidence } from './types.ts';

/** Dialect: - R1: statement; Acceptance R1: criterion; Question human/local Q1: question. */
export function extractGoal(request: string): Goal {
  if (!request.trim()) throw new Error('Goal request is empty');
  const goal: Goal = { version: 1, request, requirements: [], uncertainties: [] };
  const acceptance = new Map<string, string>();
  const requirementIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const [index, line] of request.split(/\r?\n/).entries()) {
    const requirement = /^\s*[-*]\s+(R[\w-]+):\s*(\S.*)\s*$/.exec(line);
    const criterion = /^\s*Acceptance\s+(R[\w-]+):\s*(\S.*)\s*$/i.exec(line);
    const question = /^\s*Question\s+(human|local)\s+([\w-]+):\s*(\S.*)\s*$/i.exec(line);
    if (requirement) {
      const [, id, statement] = requirement;
      if (!id || !statement) continue;
      if (requirementIds.has(id)) throw new Error(`Duplicate requirement ID: ${id}`);
      requirementIds.add(id);
      goal.requirements.push({ id, statement: statement.trim(), acceptance: '', sourceLine: index + 1 });
      continue;
    }
    if (criterion) {
      const [, id, text] = criterion;
      if (!id || !text) continue;
      if (acceptance.has(id)) throw new Error(`Duplicate acceptance for ${id}`);
      acceptance.set(id, text.trim());
      continue;
    }
    if (!question) continue;
    const [, ownerText, id, text] = question;
    if (!ownerText || !id || !text) continue;
    if (questionIds.has(id)) throw new Error(`Duplicate uncertainty ID: ${id}`);
    questionIds.add(id);
    goal.uncertainties.push({
      id,
      question: text.trim(),
      owner: ownerText.toLowerCase() === 'human' ? 'human' : 'local',
      critical: true,
      resolution: { kind: 'open' },
    });
  }
  if (goal.requirements.length === 0) {
    if (acceptance.size || goal.uncertainties.length) throw new Error('Goal has no requirements');
    const sourceLine = request.split(/\r?\n/).findIndex(line => line.trim()) + 1;
    goal.requirements.push({ id: 'R1', statement: request.trim(), acceptance: '', sourceLine });
    requirementIds.add('R1');
  }
  for (const id of acceptance.keys()) {
    if (!requirementIds.has(id)) throw new Error(`Acceptance references unknown requirement: ${id}`);
  }
  for (const requirement of goal.requirements) {
    requirement.acceptance = acceptance.get(requirement.id) ?? '';
    if (requirement.acceptance) continue;
    goal.uncertainties.push({
      id: `acceptance:${requirement.id}`,
      question: `What observable result satisfies ${requirement.id}: ${requirement.statement}?`,
      owner: 'human',
      critical: true,
      resolution: { kind: 'open' },
    });
  }
  return goal;
}

function unresolved(uncertainty: Uncertainty): boolean {
  if (uncertainty.resolution.kind === 'open') return true;
  return !uncertainty.resolution.answer.trim() || !uncertainty.resolution.source.trim();
}

/** Spec default for an "inexpensive" check (open question Q5). */
export const inexpensiveCheckMs = 60_000;

/** Why the session cannot (or can no longer) stay on the light tier; null while it qualifies. Pure, so start and escalation share it. */
export function lightTierBlocker(state: SessionState): string | null {
  const open = state.goal.uncertainties.filter(question => question.resolution.kind === 'open');
  const human = open.find(question => question.owner === 'human' && question.critical);
  if (human) return `open critical human question ${human.id}`;
  const local = open.find(question => question.owner === 'local');
  if (local) return `open local question ${local.id}`;
  const prose = state.goal.requirements.find(requirement => requirement.acceptanceSource !== 'project-checks');
  if (prose) return `${prose.id} has prose acceptance, not the approved project checks`;
  const uncovered = state.goal.requirements.find(requirement => !state.checks.some(check => check.requirementIds.includes(requirement.id)));
  if (uncovered) return `${uncovered.id} is not covered by an approved check`;
  if (state.control.kind !== 'running') return `reconsideration: ${state.control.reason}`;
  const slow = state.evidence.find(evidence => evidence.result.durationMs >= inexpensiveCheckMs);
  if (slow) return `check ${slow.checkId} ran ${Math.round(slow.result.durationMs / 1000)} s, over the ${inexpensiveCheckMs / 1000} s light-tier threshold`;
  return null;
}

export function assessGate(state: SessionState): Gate {
  const humanQuestions = state.goal.uncertainties.filter(question => {
    return question.critical && question.owner === 'human' && unresolved(question);
  });
  if (humanQuestions.length) {
    return {
      kind: 'clarify',
      reason: 'Critical human decisions need answers with source references',
      uncertaintyIds: humanQuestions.map(question => question.id),
    };
  }
  const localQuestions = state.goal.uncertainties.some(question => {
    return question.owner === 'local' && unresolved(question);
  });
  if (localQuestions) return { kind: 'investigate', reason: 'Local questions remain unresolved' };
  const { context, assessment } = state;
  // Light tier: acceptance comes from the approved checks, not cited context, so stale or missing context does not block.
  // The rule is re-tested here, so a session that should escalate never proceeds or closes before #sync records it.
  if (state.tier === 'light' && lightTierBlocker(state) === null && assessment?.kind === 'policy' && state.review.kind === 'policy' && state.review.goalVersion === state.goal.version) {
    return { kind: 'proceed', reason: state.review.rule };
  }
  if (!context) return { kind: 'investigate', reason: 'Retrieve project context first' };
  if (!context.complete || !context.projectDigest.trim()) {
    return { kind: 'investigate', reason: 'Context retrieval is incomplete' };
  }
  if (context.uncoveredRequirementIds.length || !state.goal.requirements.length) {
    return { kind: 'investigate', reason: 'Requirements lack context coverage' };
  }
  if (!assessment || assessment.kind !== 'sufficient' || !assessment.rationale.trim() || !assessment.itemIds.length) {
    return { kind: 'investigate', reason: 'Assess context sufficiency with a rationale and current citations' };
  }
  const currentIds = new Set(context.items.map(item => item.id));
  if (assessment.itemIds.some(id => !currentIds.has(id))) {
    return { kind: 'investigate', reason: 'Assessment cites missing context items' };
  }
  const cited = context.items.filter(item => assessment.itemIds.includes(item.id));
  const uncovered = state.goal.requirements.some(requirement => {
    return !cited.some(item => item.requirementIds.includes(requirement.id));
  });
  if (uncovered) {
    return { kind: 'investigate', reason: 'Assessment citations do not cover every requirement' };
  }
  if (state.review.kind !== 'accepted' || state.review.goalVersion !== state.goal.version) {
    return { kind: 'review', reason: 'Review and accept the current goal contract before execution' };
  }
  return { kind: 'proceed', reason: 'Requirements have assessed context and no unresolved critical decisions' };
}

function currentPassingEvidence(state: SessionState, check: Check): VerificationEvidence | undefined {
  if (!state.context || !check.requirementIds.length) return undefined;
  const required = new Set(state.goal.requirements.map(requirement => requirement.id));
  if (check.requirementIds.some(id => !required.has(id))) return undefined;
  const latest = state.evidence.findLast(evidence => evidence.checkId === check.id);
  if (!latest || latest.projectDigest !== state.context.projectDigest) return undefined;
  if (latest.result.outcome !== 'passed' || latest.result.exitCode !== 0) return undefined;
  if (check.requirementIds.some(id => !latest.requirementIds.includes(id))) return undefined;
  return latest;
}

export function verifiedRequirementIds(state: SessionState): string[] {
  const passingCheckIds = new Set(state.checks.filter(check => {
    return currentPassingEvidence(state, check) !== undefined;
  }).map(check => check.id));
  return state.goal.requirements.filter(requirement => {
    const checks = state.checks.filter(check => check.requirementIds.includes(requirement.id));
    return checks.length > 0 && checks.every(check => passingCheckIds.has(check.id));
  }).map(requirement => requirement.id);
}

function verified(state: SessionState): boolean {
  if (!state.checks.length || !state.goal.requirements.length) return false;
  if (state.checks.some(check => !currentPassingEvidence(state, check))) return false;
  return verifiedRequirementIds(state).length === state.goal.requirements.length;
}

export function nextAction(state: SessionState): NextAction {
  if (state.control.kind === 'paused') {
    return { kind: 'reconsider', route: 'agent', reason: state.control.reason };
  }
  if (state.control.kind === 'escalated') {
    return { kind: 'escalate', route: 'human', reason: state.control.reason };
  }
  const gate = assessGate(state);
  if (gate.kind === 'clarify') return { ...gate, route: 'human' };
  if (gate.kind === 'investigate') return { kind: 'retrieve', route: 'local', reason: gate.reason };
  if (gate.kind === 'review') return { ...gate, route: 'agent' };
  if (verified(state)) {
    return { kind: 'complete', route: 'none', reason: 'Every requirement and registered check has current passing evidence' };
  }
  if (state.completionClaimed) {
    return { kind: 'verify', route: 'local', reason: 'Completion claim requires independent current checks' };
  }
  return { kind: 'execute', route: 'agent', reason: gate.reason };
}
