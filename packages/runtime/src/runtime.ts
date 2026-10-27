import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Store } from './store.ts';
import { availableActions, chooseAction, ruleModel, shadowModel, stateFeatures } from './decision-model.ts';
import { classifyTool, decide, evaluate, managedProject, phaseFor, projectChecksAcceptance, reservedAction, verificationOutcome, type Decision, type GateAction } from './controller.ts';
import { extractGoal, assessGate, nextAction, verifiedRequirementIds } from './intelligence.ts';
import { capturedPrompts, importConversation, isContextCurrent, projectDigest, retrieveContext, sourceDecisions } from './context.ts';
import { assertSafeArgv, readProjectConfig, writeProjectConfig } from './project.ts';
import { canonicalRoot } from './user-store.ts';
import { nonempty, parseAssessment, parseChecks, parseReviewResponse } from './schema.ts';
import { runCommand } from './process.ts';
import { artifactsCurrent, registerArtifacts } from './verification.ts';
import type { ContextAssessment, Control, Decision as UserDecision, Goal, Measurement, NextAction, Phase, ReviewResponse, SessionState, VerificationEvidence } from './types.ts';
import type { ProjectConfig } from './schema.ts';

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

  /** `trustContext` keeps the reviewed snapshot while executing; verification still requires current context. */
  #current(state: SessionState, trustContext = false): SessionState {
    // A verified session is a closed historical result: later edits cannot reopen it or change its outcome.
    if (state.phase === 'verified') return state;
    const contextCurrent = state.context !== null && (trustContext || isContextCurrent(this.projectRoot, state.context));
    const validChecks = new Set(state.checks.filter(artifactsCurrent).map(check => check.id));
    const superseded = new Set(state.decisions.flatMap(item => item.supersedes));
    const freshDecisionIds = new Set<string>();
    const sources = new Map<string, ReturnType<typeof sourceDecisions>>();
    for (const decision of state.decisions) {
      if (superseded.has(decision.id)) continue;
      try {
        let actual = sources.get(decision.source);
        if (!actual) {
          actual = sourceDecisions(this.projectRoot, decision.source);
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

  #action(state: SessionState): NextAction {
    if (state.phase === 'verified') return { kind: 'complete', route: 'none', reason: 'Verified; this session is closed. New work starts a new session.' };
    if (state.checks.some(check => !artifactsCurrent(check))) {
      return { kind: 'escalate', route: 'human', reason: 'Registered verifier artifacts changed; an operator must register a new contract.' };
    }
    return nextAction(state);
  }

  /** A verified session is closed: its result, evidence and phase are final, so no checkpoint command may change it. */
  #open(sessionId: string): void {
    if (this.#store.get(sessionId).phase === 'verified') throw new Error('Session is verified and closed; new work starts a new session');
  }

  #transition(sessionId: string, to: Phase, cause: string): void {
    const stored = this.#store.update(sessionId, state => {
      if (state.phase === 'verified') throw new Error(`Session is verified and closed; it cannot move to ${to}`);
      return { kind: 'workflow.transitioned', from: state.phase ?? null, to, cause };
    });
    if (to === 'blocked') this.#backfill(sessionId, 'BLOCKED', this.#current(stored));
  }

  /** One decision experience per distinct (phase, decision); repeated identical queries add nothing. */
  #record(sessionId: string, state: SessionState, next: NextAction): void {
    const checkpoint = decide(state, next);
    const events = this.#store.events(sessionId);
    const last = events.findLast(item => item.event.payload.kind === 'decision.recorded')?.event.payload;
    if (last?.kind === 'decision.recorded' && last.chosenAction === checkpoint.decision && last.features.phase === checkpoint.phase) return;
    const features = stateFeatures(state, checkpoint.phase, { startedAt: events[0]?.event.at ?? new Date().toISOString(), events: events.length, now: Date.now() });
    const actions = availableActions(checkpoint.decision);
    const model = ruleModel(checkpoint.decision);
    let shadow: { version: string; ranking: ReturnType<typeof model.rank> } | undefined;
    const candidate = shadowModel(process.env.OPTIMIZER_SHADOW_MODEL);
    try {
      if (candidate) shadow = { version: candidate.version, ranking: candidate.rank(features, actions) };
    } catch {
      // A failing shadow model is dropped; it must never affect the real decision.
    }
    this.#store.update(sessionId, () => ({
      kind: 'decision.recorded', decisionId: randomUUID(), features, availableActions: actions,
      chosenAction: chooseAction(model, features, actions), decisionModelVersion: model.version, ...(shadow ? { shadow } : {}),
    }));
  }

  /** Attaches the observed outcome to every decision recorded since the previous outcome. Token usage is unknown, never invented. */
  #backfill(sessionId: string, outcome: ReturnType<typeof verificationOutcome> | 'BLOCKED', state: SessionState): void {
    const events = this.#store.events(sessionId);
    const since = events.findLastIndex(item => item.event.payload.kind === 'decision.outcome');
    const now = Date.now();
    const decisions = events.slice(since + 1).flatMap(({ event }) => event.payload.kind === 'decision.recorded'
      ? [{ decisionId: event.payload.decisionId, additionalTimeMs: Math.max(0, now - Date.parse(event.at)) }] : []);
    if (!decisions.length) return;
    this.#store.update(sessionId, () => ({
      kind: 'decision.outcome', outcome, verificationProgress: { verified: verifiedRequirementIds(state).length, total: state.goal.requirements.length },
      goalSatisfied: outcome === 'VERIFIED', additionalTokens: null, decisions,
    }));
  }

  /** Decision experiences joined with their observed outcomes, for offline training and analysis. */
  experiences(sessionId?: string) {
    return (sessionId ? [sessionId] : this.#store.sessionIds()).flatMap(id => {
      const events = this.#store.events(id);
      const outcomes = new Map<string, unknown>();
      for (const { event } of events) {
        if (event.payload.kind !== 'decision.outcome') continue;
        const { decisions, kind: _, ...observed } = event.payload;
        for (const item of decisions) if (!outcomes.has(item.decisionId)) outcomes.set(item.decisionId, { ...observed, additionalTimeMs: item.additionalTimeMs });
      }
      return events.flatMap(({ event }) => {
        if (event.payload.kind !== 'decision.recorded') return [];
        const { kind: _, features, ...decision } = event.payload;
        return [{ sessionId: id, at: event.at, ...decision, stateFeatures: features, observedOutcome: outcomes.get(decision.decisionId) ?? null }];
      });
    });
  }

  /** Records the phase the controller derives after a checkpoint, so phases replay from events. */
  #sync(sessionId: string, cause: string): void {
    if (this.#readOnly) return;
    this.#measure(sessionId, 'phase', () => {
      const stored = this.#store.get(sessionId);
      const state = this.#current(stored);
      const next = this.#action(state);
      const to = phaseFor(state, next);
      if (to !== stored.phase) this.#transition(sessionId, to, cause);
      this.#record(sessionId, { ...state, phase: to }, next);
    });
  }

  /** Without explicit checks, the project's user-approved checks cover every requirement of the new goal. */
  /**
   * Without explicit checks, the project's user-approved checks cover every requirement of the new goal.
   * `agent` marks the agent-reachable CLI path: in a managed project its goal must keep the latest captured prompt verbatim.
   */
  start(input: { request: string; checks?: unknown; replace?: boolean; agent?: boolean }): SessionState {
    return this.#begin(input, null);
  }

  /** Decision 2/3: the latest captured prompt becomes R1 verbatim, accepted by the approved project checks. Idempotent per prompt. */
  startFromPrompt(promptId: string): { session: SessionState; created: boolean } {
    const id = /^(prompt|run):/.test(promptId) ? promptId : `prompt:${promptId}`;
    const existing = this.#store.sessionForPrompt(id);
    if (existing) {
      // Resume an unfinished session for this prompt; a verified one is closed, so new work gets a new session.
      if (this.next(existing).kind !== 'complete') {
        const config = readProjectConfig(this.projectRoot);
        if (config?.enabled && config.activeSessionId === null) writeProjectConfig(this.projectRoot, { ...config, activeSessionId: existing });
        return { session: this.get(existing), created: false };
      }
    }
    const prompt = capturedPrompts(this.projectRoot, id.startsWith('run:')).find(item => item.id === id);
    if (!prompt) throw new Error('Unknown hook-captured user prompt');
    const session = this.#begin({ request: prompt.text }, prompt);
    try {
      this.retrieve(session.id);
    } catch {
      // The session stays at context-check; the next checkpoint retries retrieval.
    }
    return { session: this.get(session.id), created: true };
  }

  #begin(input: { request: string; checks?: unknown; replace?: boolean; agent?: boolean }, prompt: UserDecision | null): SessionState {
    const id = `session-${randomUUID()}`;
    const config = readProjectConfig(this.projectRoot);
    const enabled = config?.enabled === true ? config : null;
    if (input.checks !== undefined && config) throw new Error('Project checks come only from user approval (`optimizer propose-check` or `optimizer enable`)');
    if (input.checks === undefined && !enabled?.checks.length) {
      throw new Error('No approved project checks; run `optimizer propose-check --project P --check CMD` and have the user approve it, or pass --checks for a project without optimizer hook state');
    }
    const active = enabled?.activeSessionId ?? null;
    let replaced: string | null = null;
    let unfinished = false;
    try {
      unfinished = active !== null && this.#store.events(active).length > 0 && this.next(active).kind !== 'complete';
    } catch {
      // An unreadable session cannot prove completion; it is replaceable.
      unfinished = true;
    }
    if (active && unfinished) {
      if (!input.replace) throw new Error(`Active session ${active} is not complete; pass --replace to start another`);
      replaced = active;
    }
    // A controller-started contract keeps the user's R1 verbatim through every agent-initiated replacement.
    let kept: { statement: string; origin: NonNullable<SessionState['origin']> } | null = null;
    if (replaced) {
      let old: SessionState;
      try {
        old = this.#store.get(replaced);
      } catch (error) {
        // An unreadable session cannot show that its R1 is safe to drop.
        throw new Error(`Cannot replace unreadable session ${replaced}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const statement = old.goal.requirements[0]?.statement;
      if (old.origin && statement !== undefined) kept = { statement, origin: old.origin };
    }
    // N3: in a managed project an agent-started contract must carry the user's latest prompt verbatim.
    let latestPrompt: string | null = null;
    if (input.agent === true && !prompt && !kept && enabled?.checks.length) {
      latestPrompt = capturedPrompts(this.projectRoot).findLast(item => !/^approve\s+check\s+[0-9a-f]{4}$/i.test(item.text))?.text ?? null;
    }
    for (const check of enabled?.checks ?? []) assertSafeArgv(check.argv);
    const started = this.#measure(id, 'start', () => {
      const goal: Goal = prompt
        ? { version: 1, request: prompt.text, requirements: [{ id: 'R1', statement: prompt.text, acceptance: projectChecksAcceptance, acceptanceSource: 'project-checks', sourceLine: 1 }], uncertainties: [] }
        : extractGoal(nonempty(input.request, 'request'));
      if (latestPrompt !== null && !goal.requirements.some(item => item.statement === latestPrompt)) {
        throw new Error(`This managed project has a captured user prompt; a contract must keep it verbatim as a requirement statement (or let the controller start it on the first edit): ${latestPrompt.slice(0, 500)}`);
      }
      if (kept && !goal.requirements.some(item => item.statement === kept.statement)) {
        throw new Error(`Session ${replaced} was started by the controller from the user's prompt; a replacement must keep its R1 verbatim as a requirement statement: ${kept.statement.slice(0, 500)}`);
      }
      const checks = input.checks === undefined
        ? (enabled?.checks ?? []).map(check => ({ ...check, requirementIds: goal.requirements.map(requirement => requirement.id) }))
        : parseChecks(input.checks).map(check => registerArtifacts(this.projectRoot, check));
      const checkIds = new Set<string>();
      for (const check of checks) {
        if (checkIds.has(check.id)) throw new Error(`Duplicate check ID: ${check.id}`);
        checkIds.add(check.id);
        if (check.requirementIds.some(id => !goal.requirements.some(item => item.id === id))) throw new Error('Check references unknown requirement');
      }
      const state: SessionState = {
        id, ...(prompt ? { origin: { promptId: prompt.id } } : kept ? { origin: kept.origin } : {}), goal, checks, decisions: prompt ? [prompt] : [], context: null, assessment: null, review: { kind: 'pending' },
        control: { kind: 'running', rounds: 0 }, evidence: [],
        failureStreak: { signature: '', count: 0 }, completionClaimed: false,
      };
      this.#store.append({ version: 1, id: randomUUID(), sessionId: id, producer: 'runtime', at: new Date().toISOString(), payload: { kind: 'session.started', state } });
      return state;
    });
    if (replaced) {
      try {
        this.#store.update(replaced, () => ({ kind: 'session.replaced', replacedBy: id }));
      } catch {
        // The old session's history is unreadable; the new active pointer still supersedes it.
      }
    }
    if (enabled) writeProjectConfig(this.projectRoot, { ...enabled, activeSessionId: id });
    if (!this.#readOnly) this.#transition(id, 'requested', prompt ? 'controller-started' : 'session.started');
    this.#sync(id, 'goal.extracted');
    return started;
  }

  get(sessionId: string): SessionState {
    return this.#measure(sessionId, 'status', () => this.#current(this.#store.get(sessionId)));
  }

  next(sessionId: string) {
    return this.#measure(sessionId, 'next', () => {
      const action = this.#action(this.#current(this.#store.get(sessionId)));
      if (action.kind === 'complete' && !this.#readOnly) {
        // Completion is recorded as terminal, and a verified session releases the pointer, so hooks take the no-spawn path again.
        if (this.#store.get(sessionId).phase !== 'verified') this.#transition(sessionId, 'verified', 'complete');
        const config = readProjectConfig(this.projectRoot);
        if (config?.activeSessionId === sessionId) writeProjectConfig(this.projectRoot, { ...config, activeSessionId: null });
      }
      return action;
    });
  }

  importHistory(sessionId: string, path: string): SessionState {
    this.#open(sessionId);
    const state = this.#measure(sessionId, 'import-history', () => {
      const decisions = importConversation(this.projectRoot, path);
      return this.#store.update(sessionId, () => ({ kind: 'conversation.imported', decisions }));
    });
    this.#sync(sessionId, 'conversation.imported');
    return state;
  }

  retrieve(sessionId: string) {
    this.#open(sessionId);
    const context = this.#measure(sessionId, 'retrieve', () => {
      const state = this.#store.update(sessionId, current => ({ kind: 'context.retrieved', context: retrieveContext(this.projectRoot, current.goal, current.decisions) }));
      if (!state.context) throw new Error('Context retrieval did not produce a snapshot');
      return state.context;
    });
    this.#sync(sessionId, 'context.retrieved');
    return context;
  }

  assess(sessionId: string, input: ContextAssessment): SessionState {
    this.#open(sessionId);
    const assessment = parseAssessment(input);
    const state = this.#measure(sessionId, 'assess', () => this.#store.update(sessionId, stored => {
      const state = this.#current(stored);
      if (!state.context) throw new Error('Retrieve current context before assessment');
      if (assessment.itemIds.some(id => !state.context?.items.some(item => item.id === id))) throw new Error('Assessment cites unknown context');
      return { kind: 'context.assessed', assessment };
    }));
    this.#sync(sessionId, 'context.assessed');
    return state;
  }

  resolve(sessionId: string, input: { uncertaintyId: string; source: string; answer?: string }): SessionState {
    this.#open(sessionId);
    if (input.source.startsWith('prompt:')) {
      const stored = this.#store.get(sessionId);
      if (stored.goal.uncertainties.find(item => item.id === input.uncertaintyId)?.owner === 'human' && !stored.decisions.some(item => item.id === input.source)) {
        // Only rows the hook captured as user prompts carry human authority.
        const decision = capturedPrompts(this.projectRoot).find(item => item.id === input.source);
        if (!decision) throw new Error('Unknown hook-captured user prompt');
        this.#measure(sessionId, 'import-prompt', () => this.#store.update(sessionId, () => ({ kind: 'conversation.imported', decisions: [decision] })));
      }
    }
    const resolved = this.#measure(sessionId, 'resolve', () => this.#store.update(sessionId, stored => {
      const question = stored.goal.uncertainties.find(item => item.id === input.uncertaintyId);
      if (!question) throw new Error('Unknown uncertainty');
      let answer: string;
      if (question.owner === 'human') {
        const superseded = new Set(stored.decisions.flatMap(item => item.supersedes));
        const decision = stored.decisions.find(item => item.id === input.source && !superseded.has(item.id));
        if (!decision) throw new Error('Human uncertainty requires an active imported user decision');
        if (decision.id.startsWith('run:')) throw new Error('A managed-run request carries no human authority; the user must answer in a captured prompt');
        const actual = sourceDecisions(this.projectRoot, decision.source);
        if (!actual.some(item => item.id === decision.id && item.digest === decision.digest)) throw new Error('Human decision source is stale');
        answer = decision.text;
      } else {
        const current = this.#current(stored);
        if (!current.context?.items.some(item => item.id === input.source)) throw new Error('Local answer requires current cited context');
        answer = nonempty(input.answer ?? '', 'answer');
      }
      return { kind: 'uncertainty.resolved', uncertaintyId: question.id, answer, source: input.source };
    }));
    this.#sync(sessionId, 'uncertainty.resolved');
    return resolved;
  }

  review(sessionId: string, input: ReviewResponse): SessionState {
    this.#open(sessionId);
    const response = parseReviewResponse(input);
    const reviewed = this.#measure(sessionId, 'review', () => this.#store.update(sessionId, stored => {
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
    this.#sync(sessionId, 'contract.reviewed');
    return reviewed;
  }

  runCheck(sessionId: string, checkId: string): VerificationEvidence {
    const observed = this.#measure(sessionId, 'check', timing => this.#store.commit(sessionId, stored => {
      if (stored.phase === 'verified') throw new Error('Session is verified and closed; new work starts a new session');
      const state = this.#current(stored);
      if (state.control.kind !== 'running') throw new Error(`Execution is ${state.control.kind}; resolve cooperative control first`);
      const gate = assessGate(state);
      if (gate.kind !== 'proceed') throw new Error(`${gate.kind}: ${gate.reason}`);
      const check = state.checks.find(item => item.id === checkId);
      if (!check) throw new Error('Unknown registered check');
      const config = readProjectConfig(this.projectRoot);
      // Sessions in the runtime database can come from a committed file; with user-store approvals, only approved argv runs.
      if (config && (!config.enabled || !config.checks.some(item => JSON.stringify([item.argv, item.timeoutMs]) === JSON.stringify([check.argv, check.timeoutMs])))) {
        throw new Error('Check is not among the user-approved project checks, or the project is opted out');
      }
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
    this.#sync(sessionId, 'command.observed');
    return observed;
  }

  reconsider(sessionId: string, input: { strategy: 'retain' | 'revise'; rationale: string }): SessionState {
    this.#open(sessionId);
    const rationale = nonempty(input.rationale, 'rationale');
    const state = this.#measure(sessionId, 'reconsider', () => this.#store.update(sessionId, state => {
      if (state.control.kind !== 'paused') throw new Error('A strategy response requires a paused session');
      if (input.strategy !== 'retain' && input.strategy !== 'revise') throw new Error('Unknown strategy response');
      return { kind: 'strategy.resolved', strategy: input.strategy, rationale, control: { kind: 'running', rounds: state.control.rounds } };
    }));
    this.#sync(sessionId, 'strategy.resolved');
    return state;
  }

  claim(sessionId: string): SessionState {
    // The documented check → claim → verify protocol may claim after checks already closed the session: a no-op.
    if (this.#store.get(sessionId).phase === 'verified') return this.get(sessionId);
    const state = this.#measure(sessionId, 'claim', () => this.#store.update(sessionId, () => ({ kind: 'completion.claimed' })));
    this.#sync(sessionId, 'completion.claimed');
    return state;
  }

  /** The authoritative structured decision for a session. */
  decide(sessionId: string): Decision & { sessionId: string; action: NextAction } {
    return this.#measure(sessionId, 'decide', () => {
      const state = this.#current(this.#store.get(sessionId));
      const action = this.#action(state);
      return { sessionId, ...decide(state, action), action };
    });
  }

  /** Decision 6: an exhausted Stop budget is recorded as blocked, never as a stop with the task complete. */
  block(sessionId: string, cause: string): Decision & { sessionId: string; action: NextAction } {
    const reason = nonempty(cause, 'reason');
    this.#measure(sessionId, 'block', () => {
      const phase = this.#store.get(sessionId).phase;
      if (phase !== 'blocked' && phase !== 'verified') this.#transition(sessionId, 'blocked', reason);
    });
    return this.decide(sessionId);
  }

  /** A protected action in a managed project: start the contract if none is open, then evaluate against it. */
  gate(action: GateAction, activeSessionId: string | null) {
    // A pointer left on a verified session (older state) is released, never reopened.
    let sessionId = activeSessionId && this.next(activeSessionId).kind === 'complete' ? null : activeSessionId;
    let started = false;
    if (!sessionId) {
      const prompt = capturedPrompts(this.projectRoot).findLast(item => !/^approve\s+check\s+[0-9a-f]{4}$/i.test(item.text));
      if (!prompt) return { allow: false, decision: 'BLOCK_ACTION' as const, reason: 'Managed project without a captured user prompt to start a contract from; start one with `optimizer start`.', sessionId: null, started };
      const result = this.startFromPrompt(prompt.id);
      sessionId = result.session.id;
      started = result.created;
    }
    const id = sessionId;
    return this.#measure(id, 'gate', () => {
      const stored = this.#store.get(id);
      let state = this.#current(stored);
      let next = this.#action(state);
      let checkpoint = decide(state, next);
      // Edits make the reviewed snapshot stale by design; while executing they continue under it, and verify requires fresh context.
      if ((stored.phase === 'executing' || stored.phase === 'recovery') && (checkpoint.decision === 'RETRIEVE_CONTEXT' || checkpoint.decision === 'INVESTIGATE')) {
        const trusted = this.#current(stored, true);
        const trustedNext = this.#action(trusted);
        if (trustedNext.kind === 'execute' || trustedNext.kind === 'verify') {
          state = trusted;
          next = trustedNext;
          checkpoint = decide(state, next);
        }
      }
      const verdict = evaluate(state, action, { managed: true, available: true, next });
      const executing = verdict.allow && checkpoint.phase === 'ready' && state.phase !== 'executing';
      if (executing) this.#transition(id, 'executing', `tool:${action.tool}`);
      this.#record(id, executing ? { ...state, phase: 'executing' } : state, next);
      return { ...verdict, sessionId: id, started, checkpoint };
    });
  }

  verify(sessionId: string) {
    // Verifying a closed session only reports its recorded result.
    const closed = this.#store.get(sessionId).phase === 'verified';
    const state = this.get(sessionId);
    for (const check of state.checks) {
      const action = this.next(sessionId);
      if (action.kind !== 'execute' && action.kind !== 'verify') break;
      this.runCheck(sessionId, check.id);
    }
    if (!closed) this.#sync(sessionId, 'verify');
    const current = this.get(sessionId);
    const action = this.next(sessionId);
    const outcome = verificationOutcome(current, action);
    if (!this.#readOnly && !closed) this.#backfill(sessionId, outcome, current);
    return { action, outcome, phase: this.#store.get(sessionId).phase ?? phaseFor(current, action), verifiedRequirementIds: verifiedRequirementIds(current), evidence: current.evidence };
  }

  events(sessionId: string) { return this.#store.events(sessionId); }
  sessions(): string[] { return this.#store.sessionIds(); }
  measurements(sessionId: string): Measurement[] { return this.#store.measurements(sessionId); }
  close(): void { this.#store.close(); }
}

/**
 * Policy gate for one host tool call. Reads, control commands and unmanaged projects never open the
 * runtime store, so they start no session; a runtime failure inside a managed task fails closed.
 */
export function gate(projectRoot: string, tool: string, input: Record<string, unknown>) {
  let config: ProjectConfig | null = null;
  try {
    config = readProjectConfig(projectRoot);
  } catch {
    // An unreadable record cannot show an active task; the evaluation below fails open.
  }
  const managed = managedProject(config, process.env.OPTIMIZER_MODE);
  const active = config?.activeSessionId ?? null;
  let action: GateAction = { kind: 'protected', tool };
  let runtime: Runtime | null = null;
  try {
    const root = canonicalRoot(projectRoot);
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : root;
    // A root shaped like a bare repository (committed HEAD and objects without .git) would hand git its config.
    const gitSafe = existsSync(join(root, '.git')) || !(existsSync(join(root, 'HEAD')) && existsSync(join(root, 'objects')));
    const classified = classifyTool(tool, input, config?.enabled ? config.checks.map(check => check.argv) : [], { root, cwd, gitSafe });
    action = classified.target !== undefined && tool !== 'Bash' ? { ...classified, target: resolve(root, classified.target) } : classified;
    if (action.kind !== 'protected' || !managed || reservedAction(action)) {
      return { ...evaluate(null, action, { managed, available: true }), sessionId: active, started: false, action };
    }
    runtime = new Runtime(projectRoot);
    return { ...runtime.gate(action, active), action };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // In a managed project a failure denies protected actions even before a task starts; elsewhere it fails open.
    return { ...evaluate(null, action, { managed, available: false, active: active !== null || managed }), sessionId: active, started: false, action, error: message };
  } finally {
    runtime?.close();
  }
}
