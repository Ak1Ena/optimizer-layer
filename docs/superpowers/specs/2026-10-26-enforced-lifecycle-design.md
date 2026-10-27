# Enforced execution lifecycle

Date: 2026-10-26. Status: approved by user directive ("Fix Optimizer Bypass and Enforce the Execution Lifecycle"). Amends the [hooks](2026-10-26-claude-hooks-design.md) and [always-on](2026-10-26-always-on-dashboard-design.md) designs; everything not changed here stays.

## Audit (current implementation)

| Question | Finding |
|---|---|
| How tasks enter the agent | User prompt reaches Claude Code; `UserPromptSubmit` hook captures it and injects advisory text. No task exists until the agent voluntarily runs `optimizer start` with a drafted goal. |
| Where Goal/Context Intelligence run | Only inside CLI commands the agent chooses to call (`start`, `retrieve`, `assess`, `review`). Never automatically. |
| Decision Engine state transitions | `nextAction` (intelligence.ts) is a pure function over replayed state. It owns no transitions; nothing persists "phase". Hooks consult it only when a session exists. |
| Recommendations: optional or enforced | Enforced (deny edit / block Stop) only while a session is active. With no session: `PreToolUse` allows everything, `Stop` allows. |
| Tools without checkpoints | Yes: all edits before any session; all `Bash` file writes always (only optimizer-specific strings are guarded). |
| Finish without verification | Yes when no session. With a session, Stop blocks but is bounded (3) and then allows with a message. |
| Host capabilities used | Claude Code `UserPromptSubmit`, `PreToolUse` (Edit/Write/MultiEdit/NotebookEdit/Bash), `Stop`, `SubagentStart`, `SessionStart` (ensure). MCP is read-only. |
| Bypass paths | (1) never starting a session, (2) Bash writes, (3) Stop budget exhaustion presented as stop, (4) runtime/hook failure fails open, (5) agent can run with hooks not installed. |

**Root cause:** the controller has no authority over task creation. The lifecycle starts only when the agent opts in, so every enforcement point is conditional on agent cooperation. Secondary: Bash is unclassified, failures fail open even inside a managed task, and verification has only pass/not-complete outcomes.

## Decisions (made under the directive; reversible)

1. **Managed project.** Enforcement applies to a *managed project*: tracked (always-on or opted-in) **and** has at least one user-approved check. A tracked project without approved checks cannot be verified, so it stays advisory and the hook tells the agent to `propose-check`; the dashboard shows it as "Unmanaged: no approved check". Rationale: the directive forbids claiming verification without evidence and forbids needless blocking.
2. **Controller-started tasks.** In a managed project, the first *protected action* with no open session makes the controller start a session automatically from the latest hook-captured user prompt (Goal Intelligence), run context retrieval (Context Intelligence), persist the contract proposal, and deny the action with the next required checkpoint. The agent never has to call `start`.
3. **Default acceptance.** A controller-started contract keeps the user's prompt verbatim as R1. Its acceptance is "every user-approved project check passes against the final source" (a deterministic, user-authorized criterion, recorded as `acceptanceSource: 'project-checks'`). The agent may *add* requirements/acceptance via `review --kind challenge` with evidence; it can never remove or weaken R1. Ambiguity the agent finds becomes a critical human question as today.
4. **Protected actions.** Edit/Write/MultiEdit/NotebookEdit, and Bash commands not on a deterministic read-only allowlist (e.g. `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find` without `-delete/-exec`, `git status|diff|log|show|branch`, `pwd`, `which`, `optimizer` read commands, and the project's approved check argv). Redirections (`>`, `>>`, `| tee`), `sed -i`, `rm`, `mv`, `cp`, package installs etc. are protected. Unknown = protected. Read tools (Read, Grep, Glob, WebFetch) are never gated.
5. **Fail closed inside a managed task.** If a session is active (pointer present) and the runtime cannot answer, protected actions are denied with an explicit "optimizer unavailable" reason; read-only actions still pass. Outside a managed task, hooks keep failing open so Claude Code never breaks.
6. **Stop budget.** When the Stop budget is exhausted the controller records `BLOCKED` (event + phase) and the stop message says the task is blocked/unverified, never complete.
7. **Managed Execution Mode** = `optimizer run --project P --prompt-file F [--max-turns N]`: the optimizer creates the session itself (Decision 2 path, but before the agent starts), writes a private Claude Code settings file whose hooks run in `managed` mode (always enforced, ignoring the user's global mode), launches `claude -p` with `--settings` and `--append-system-prompt` describing the protocol, observes it, then runs independent verification itself and returns the outcome. Same controller API and policies as plugin mode.

## Architecture

### Runtime: controller (`packages/runtime/src/controller.ts`, new)

- **Workflow phases** (persisted as `workflow.transitioned` events with `from`, `to`, `cause`, `at`; current phase derivable by replay):
  `requested → contract-proposed → under-review → context-check → ready → executing → reconsidering → verifying → verified | recovery | blocked`. `verified` is terminal: the session is an immutable historical result, later edits never reopen it, and new work gets a new session. `needs-human` is an overlay flag when a critical human question is open.
- **Structured decisions**: `decide(state) → { decision: 'PROCEED' | 'RETRIEVE_CONTEXT' | 'INVESTIGATE' | 'ASK_HUMAN' | 'REVIEW_CONTRACT' | 'RUN_VERIFICATION' | 'REQUEST_RECONSIDERATION' | 'BLOCK_ACTION' | 'COMPLETE', reason, requiredBy }`, derived deterministically from the existing `nextAction` plus phase. Keep `nextAction` for compatibility; the decision is the authoritative output.
- **Policy gate**: `evaluate(state | null, action: { kind: 'read' | 'protected' | 'verification' | 'control'; tool; target? }, context: { managed: boolean; available: boolean }) → { allow: boolean; decision; reason }`. Pure, no I/O, no LLM. Used by plugin hooks and managed mode alike.
- **Verification outcomes**: `verify` returns `outcome: 'VERIFIED' | 'FAILED' | 'INCONCLUSIVE' | 'NEEDS_HUMAN_REVIEW'`: FAILED when a required check fails; INCONCLUSIVE when evidence is stale/missing/timeouts; NEEDS_HUMAN_REVIEW when a requirement's acceptance cannot be mapped to any check or an open human question remains. FAILED moves to `recovery` (failure streak → reconsideration as today); budgets exhausted move to `blocked`.
- **Protected records**: authoritative goal/verification state lives only in SQLite + per-user store (already outside agent-write paths); add a test that agent-reachable CLI commands cannot remove/weaken requirements or write verification outcomes, and that direct file edits of runtime state are denied by the gate.
- **startFromPrompt(promptId)**: Decision 2/3 path; idempotent per prompt id; returns the session.
- **Overhead**: measure gate evaluation and hook end-to-end latency; record via existing `measurements`.

### Adapter: plugin mode (`claude-hook.ts`)

Hooks call the controller (CLI commands `gate`, `start-from-prompt`, `decide`) instead of embedding policy. Hooks stay thin. New install mode value `managed` is only for Managed Execution settings files.

### Managed execution (`optimizer run`)

As Decision 7. Lives in the runtime package CLI (it owns task startup); spawns `claude` without a shell; bounded turns/time; captures the agent's final message; runs `verify`; prints `{ sessionId, outcome, phase, evidence, timings }`.

## Required tests (map to directive §10)

1. Implementation before contract review → denied (hook + gate).
2. Agent ignores advice, never calls optimizer → first protected action auto-starts the contract and is denied; Stop blocked.
3. Completion claim without verification → not VERIFIED.
4. Repeated failing strategy → pause → reconsider → resolve; budget → blocked.
5. Valid technical challenge → contract version advances, original R1 preserved.
6. Attempts to change goal/verification records (CLI paths and file edits) → rejected/denied.
7. Runtime unavailable during managed task → protected denied, reads allowed; outside task → fail open.
8. Concurrent independent sessions/projects → isolated.
9. Reconsideration/verification/Stop budgets exceeded → blocked, not complete.
10. Low-risk read-only work in managed project → no denial, no session started.
Plus: one real `claude -p` managed-mode run on the parseCount fixture; advisory-vs-enforced comparison on a scripted "ignore the optimizer" run; overhead numbers.

## Decision model (hybrid engine, addendum)

No learned model exists yet. The controller stays the final authority; models only rank.

- **`DecisionModel`** `{ version; rank(features, actions) → RankedAction[] }`, with `RankedAction = { action, successProbability, expectedCostMs?, expectedTokens?, rationale }`. The default `rule-v0.1` wraps `decide()`: the deterministic decision ranks first.
- **Allowed actions.** Only `PROCEED` leaves a choice (`PROCEED`, `RUN_VERIFICATION`, `RETRIEVE_CONTEXT`); every other decision is a mandatory checkpoint with exactly one allowed action. `chooseAction` takes the top-ranked *allowed* action. The gate (`evaluate`) never consults a model, so a model cannot unlock a denied action, skip a mandatory transition or answer a human question.
- **`StateFeatures`** are numbers, booleans and enums only: phase, requirement count, open human/local questions, context completeness and uncovered requirements, review state, control kind, failure streak, reconsideration rounds, check count, last check outcome, milliseconds since start, event count. No goal, prompt or context text.
- **Experiences.** Each checkpoint command and gate evaluation that yields a new (phase, decision) pair appends `decision.recorded` `{decisionId, features, availableActions, chosenAction, decisionModelVersion, shadow?}`; repeated identical queries add nothing. When `verify` returns an outcome, or the session becomes `blocked`, `decision.outcome` `{outcome, verificationProgress {verified, total}, goalSatisfied, additionalTokens: null, decisions [{decisionId, additionalTimeMs}]}` covers every decision recorded since the previous outcome. Token usage stays `null` because the host does not report it.
- **Shadow mode** (off by default): `OPTIMIZER_SHADOW_MODEL` names a built-in candidate (`prefer-retrieve` for testing). Its ranking is stored in `shadow` beside the real choice and never affects decisions or the gate; an unknown name or a failing candidate is ignored.
- **Export.** `optimizer experiences [--session ID]` returns the experiences joined with their observed outcomes as a JSON array for offline training and analysis.

## Explicit limitations to document

Plugin mode cannot stop the agent from running with hooks uninstalled, cannot see shell writes hidden inside allowlisted programs, cannot truly pause the host (checkpoints happen at tool boundaries), and a same-user process can still modify state outside the hooks. Managed mode closes the "hooks not installed / agent never called optimizer" paths for the runs it launches.
