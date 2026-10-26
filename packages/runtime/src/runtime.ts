import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { extractGoal, assessGate, nextAction, verifiedRequirementIds } from './intelligence.ts';
import { importConversation, isContextCurrent, projectDigest, retrieveContext } from './context.ts';
import { nonempty, parseAssessment, parseChecks, parseReviewResponse } from './schema.ts';
import { runCommand } from './process.ts';
import { artifactsCurrent, registerArtifacts } from './verification.ts';
import type { ContextAssessment, Control, Goal, Measurement, ReviewResponse, SessionState, VerificationEvidence } from './types.ts';

export class Runtime {
  readonly projectRoot: string;
  readonly #store: Store;
  readonly #openMs: number;
  readonly #readOnly: boolean;
  #openRecorded = false;

  constructor(projectRoot: string, options: { readOnly?: boolean } = {}) {
    const started = performance.now();
    this.#readOnly = options.readOnly ?? false;
    this.#store = new Store(projectRoot, options);
    this.projectRoot = this.#store.projectRoot;
    this.#openMs = performance.now() - started;
  }

  #measure<T>(sessionId: string, operation: string, run: (timing: { externalMs: number }) => T): T {
    if (this.#readOnly) return run({ externalMs: 0 });
    const started = performance.now();
    const timing = { externalMs: 0 };
    try {
      return run(timing);
    } finally {
      const elapsedMs = performance.now() - started;
      const at = new Date().toISOString();
      if (!this.#openRecorded) {
        this.#store.measure(sessionId, { operation: 'open', elapsedMs: this.#openMs, externalMs: 0, optimizerMs: this.#openMs, at });
        this.#openRecorded = true;
      }
      this.#store.measure(sessionId, { operation, elapsedMs, externalMs: timing.externalMs, optimizerMs: Math.max(0, elapsedMs - timing.externalMs), at });
    }
  }

  #current(state: SessionState): SessionState {
    const contextCurrent = state.context !== null && isContextCurrent(this.projectRoot, state.context);
    const validChecks = new Set(state.checks.filter(artifactsCurrent).map(check => check.id));
    const superseded = new Set(state.decisions.flatMap(item => item.supersedes));
    const freshDecisionIds = new Set<string>();
    const sources = new Map<string, ReturnType<typeof importConversation>>();
    for (const decision of state.decisions) {
      if (superseded.has(decision.id)) continue;
      try {
        let actual = sources.get(decision.source);
        if (!actual) {
          actual = importConversation(this.projectRoot, decision.source);
          sources.set(decision.source, actual);
        }
        if (actual.some(item => item.id === decision.id && item.digest === decision.digest && item.text === decision.text)) freshDecisionIds.add(decision.id);
      } catch {
        // A removed or unreadable source cannot keep authorizing an old decision.
      }
    }
    const uncertainties: Goal['uncertainties'] = state.goal.uncertainties.map(question => {
      if (question.resolution.kind === 'open') return question;
      const source = question.resolution.source;
      const sourceCurrent = question.owner === 'human'
        ? freshDecisionIds.has(source)
        : contextCurrent && state.context !== null && state.context.items.some(item => item.id === source);
      if (sourceCurrent) return question;
      return { ...question, resolution: { kind: 'open' } };
    });
    return {
      ...state,
      evidence: state.evidence.filter(item => validChecks.has(item.checkId)),
      goal: { ...state.goal, uncertainties },
      context: contextCurrent ? state.context : null,
      assessment: contextCurrent ? state.assessment : null,
    };
  }

  start(input: { request: string; checks: unknown }): SessionState {
    const id = `session-${randomUUID()}`;
    return this.#measure(id, 'start', () => {
      const goal = extractGoal(nonempty(input.request, 'request'));
      const checks = parseChecks(input.checks).map(check => registerArtifacts(this.projectRoot, check));
      const checkIds = new Set<string>();
      for (const check of checks) {
        if (checkIds.has(check.id)) throw new Error(`Duplicate check ID: ${check.id}`);
        checkIds.add(check.id);
        if (check.requirementIds.some(id => !goal.requirements.some(item => item.id === id))) throw new Error('Check references unknown requirement');
      }
      const state: SessionState = {
        id, goal, checks, decisions: [], context: null, assessment: null, review: { kind: 'pending' },
        control: { kind: 'running', rounds: 0 }, evidence: [],
        failureStreak: { signature: '', count: 0 }, completionClaimed: false,
      };
      this.#store.append({ version: 1, id: randomUUID(), sessionId: id, producer: 'runtime', at: new Date().toISOString(), payload: { kind: 'session.started', state } });
      return state;
    });
  }

  get(sessionId: string): SessionState {
    return this.#measure(sessionId, 'status', () => this.#current(this.#store.get(sessionId)));
  }

  next(sessionId: string) {
    return this.#measure(sessionId, 'next', () => {
      const state = this.#current(this.#store.get(sessionId));
      if (state.checks.some(check => !artifactsCurrent(check))) {
        return { kind: 'escalate', route: 'human', reason: 'Registered verifier artifacts changed; an operator must register a new contract.' } as const;
      }
      return nextAction(state);
    });
  }

  importHistory(sessionId: string, path: string): SessionState {
    return this.#measure(sessionId, 'import-history', () => {
      const decisions = importConversation(this.projectRoot, path);
      return this.#store.update(sessionId, () => ({ kind: 'conversation.imported', decisions }));
    });
  }

  retrieve(sessionId: string) {
    return this.#measure(sessionId, 'retrieve', () => {
      const state = this.#store.update(sessionId, current => ({ kind: 'context.retrieved', context: retrieveContext(this.projectRoot, current.goal, current.decisions) }));
      if (!state.context) throw new Error('Context retrieval did not produce a snapshot');
      return state.context;
    });
  }

  assess(sessionId: string, input: ContextAssessment): SessionState {
    const assessment = parseAssessment(input);
    return this.#measure(sessionId, 'assess', () => this.#store.update(sessionId, stored => {
      const state = this.#current(stored);
      if (!state.context) throw new Error('Retrieve current context before assessment');
      if (assessment.itemIds.some(id => !state.context?.items.some(item => item.id === id))) throw new Error('Assessment cites unknown context');
      return { kind: 'context.assessed', assessment };
    }));
  }

  resolve(sessionId: string, input: { uncertaintyId: string; source: string; answer?: string }): SessionState {
    return this.#measure(sessionId, 'resolve', () => this.#store.update(sessionId, stored => {
      const question = stored.goal.uncertainties.find(item => item.id === input.uncertaintyId);
      if (!question) throw new Error('Unknown uncertainty');
      let answer: string;
      if (question.owner === 'human') {
        const superseded = new Set(stored.decisions.flatMap(item => item.supersedes));
        const decision = stored.decisions.find(item => item.id === input.source && !superseded.has(item.id));
        if (!decision) throw new Error('Human uncertainty requires an active imported user decision');
        const actual = importConversation(this.projectRoot, decision.source);
        if (!actual.some(item => item.id === decision.id && item.digest === decision.digest)) throw new Error('Human decision source is stale');
        answer = decision.text;
      } else {
        const current = this.#current(stored);
        if (!current.context?.items.some(item => item.id === input.source)) throw new Error('Local answer requires current cited context');
        answer = nonempty(input.answer ?? '', 'answer');
      }
      return { kind: 'uncertainty.resolved', uncertaintyId: question.id, answer, source: input.source };
    }));
  }

  review(sessionId: string, input: ReviewResponse): SessionState {
    const response = parseReviewResponse(input);
    return this.#measure(sessionId, 'review', () => this.#store.update(sessionId, stored => {
      const state = this.#current(stored);
      if (state.control.kind !== 'running') throw new Error(`Execution is ${state.control.kind}; resolve cooperative control first`);
      if (response.goalVersion !== state.goal.version) throw new Error('Review references a stale goal version');
      if (!state.context) throw new Error('Retrieve current context before contract review');
      const items = state.context.items.filter(item => response.itemIds.includes(item.id));
      if (response.itemIds.some(id => !items.some(item => item.id === id))) throw new Error('Review cites unknown context');
      if (response.kind === 'accept') {
        const gate = assessGate(state);
        if (gate.kind !== 'review' && gate.kind !== 'proceed') throw new Error(`${gate.kind}: ${gate.reason}`);
        if (state.goal.requirements.some(requirement => !items.some(item => item.requirementIds.includes(requirement.id)))) {
          throw new Error('Review citations do not cover every requirement');
        }
        return { kind: 'contract.reviewed', review: { ...response, kind: 'accepted' } };
      }
      if (!state.goal.requirements.some(item => item.id === response.requirementId)) throw new Error('Challenge references unknown requirement');
      if (!items.some(item => item.requirementIds.includes(response.requirementId))) throw new Error('Challenge citations do not cover the requirement');
      const challenges = state.goal.uncertainties.filter(item => item.id.startsWith('review:'));
      if (challenges.some(item => item.resolution.kind === 'open')) throw new Error('Resolve the open review challenge first');
      if (challenges.length >= 2) return { kind: 'contract.escalated', reason: 'Contract review challenge budget exhausted; a human decision is required.', review: response };
      return { kind: 'contract.reviewed', review: { ...response, kind: 'challenged', uncertaintyId: `review:${challenges.length + 1}` } };
    }));
  }

  runCheck(sessionId: string, checkId: string): VerificationEvidence {
    return this.#measure(sessionId, 'check', timing => this.#store.commit(sessionId, stored => {
      const state = this.#current(stored);
      if (state.control.kind !== 'running') throw new Error(`Execution is ${state.control.kind}; resolve cooperative control first`);
      const gate = assessGate(state);
      if (gate.kind !== 'proceed') throw new Error(`${gate.kind}: ${gate.reason}`);
      const check = state.checks.find(item => item.id === checkId);
      if (!check) throw new Error('Unknown registered check');
      if (!artifactsCurrent(check)) throw new Error('Registered verifier artifact changed');
      const before = projectDigest(this.projectRoot);
      const result = runCommand({ argv: check.argv, cwd: this.projectRoot, timeoutMs: check.timeoutMs });
      timing.externalMs += result.durationMs;
      if (projectDigest(this.projectRoot) !== before || !artifactsCurrent(check)) {
        result.outcome = 'failed';
        result.output = 'Verification changed project files; result invalidated.\n' + result.output.slice(0, 65_400);
      }
      const evidence: VerificationEvidence = { checkId, requirementIds: check.requirementIds, projectDigest: before, result, at: new Date().toISOString() };
      const signature = `${check.id}:${result.outcome}:${result.exitCode}`;
      const failureStreak = result.outcome === 'passed'
        ? { signature: '', count: 0 }
        : { signature, count: stored.failureStreak.signature === signature ? stored.failureStreak.count + 1 : 1 };
      let control: Control = state.control;
      if (failureStreak.count >= 3) {
        const reason = `Check ${check.id} failed three consecutive times. Pause, inspect the evidence, and provide a justified reconsideration response.`;
        control = state.control.rounds < 2
          ? { kind: 'paused', rounds: state.control.rounds + 1, reason }
          : { kind: 'escalated', rounds: state.control.rounds, reason: 'Reconsideration budget exhausted; a human decision is required.' };
      }
      return { payload: { kind: 'command.observed', evidence, control, failureStreak }, value: evidence };
    }).value);
  }

  reconsider(sessionId: string, input: { strategy: 'retain' | 'revise'; rationale: string }): SessionState {
    const rationale = nonempty(input.rationale, 'rationale');
    return this.#measure(sessionId, 'reconsider', () => this.#store.update(sessionId, state => {
      if (state.control.kind !== 'paused') throw new Error('A strategy response requires a paused session');
      if (input.strategy !== 'retain' && input.strategy !== 'revise') throw new Error('Unknown strategy response');
      return { kind: 'strategy.resolved', strategy: input.strategy, rationale, control: { kind: 'running', rounds: state.control.rounds } };
    }));
  }

  claim(sessionId: string): SessionState {
    return this.#measure(sessionId, 'claim', () => this.#store.update(sessionId, () => ({ kind: 'completion.claimed' })));
  }

  verify(sessionId: string) {
    const state = this.get(sessionId);
    for (const check of state.checks) {
      const action = this.next(sessionId);
      if (action.kind !== 'execute' && action.kind !== 'verify' && action.kind !== 'complete') break;
      this.runCheck(sessionId, check.id);
    }
    const current = this.get(sessionId);
    const action = this.next(sessionId);
    return { action, verifiedRequirementIds: verifiedRequirementIds(current), evidence: current.evidence };
  }

  events(sessionId: string) { return this.#store.events(sessionId); }
  measurements(sessionId: string): Measurement[] { return this.#store.measurements(sessionId); }
  close(): void { this.#store.close(); }
}
