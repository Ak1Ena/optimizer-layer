# Adaptive execution: verified goals at the lowest practical cost

Status: implemented (light tier, instrumentation). The benchmark is not implemented yet.

## Objective (amends earlier specs)

Achieve verified user goals with the lowest practical total tokens, wall-clock time, retries and rework, **including the optimizer's own overhead**. Correctness is a hard constraint and the primary quality outcome; it is not the only objective. Earlier specs called efficiency a research hypothesis; this spec makes it an acceptance criterion.

Goal Intelligence, Context Intelligence, the Decision Engine, Adaptive Replanning and Independent Verification all stay. The change is *when* each runs: the Decision Engine invokes a component only when its expected value exceeds its cost, inside fixed policy constraints.

## Evidence: where the cost comes from today

One A/B on the `parseCount` fixture (Sonnet, same prompt, both passed the hidden acceptance check):

| | Plain agent | `optimizer run` |
|---|---|---|
| Wall clock | 28 s | 114 s |
| Turns | 4 | 17 |
| Input tokens read (cache) | ~174k | ~766k |
| Output tokens | 677 | 4,692 |

From the code, every task, however trivial, passes these agent-driven steps (`intelligence.ts` `assessGate`, `nextAction`; `controller.ts` `evaluate`):

1. `retrieve` (required before any protected edit; `assessGate` returns `investigate` with no context).
2. `assess --items ...` (sufficiency with rationale and cited items).
3. `review --version N` (contract accept/challenge).
4. Edit.
5. Edits make the context snapshot stale (`runtime.ts` `#current`, `isContextCurrent`); verification requires current context, so retrieve/assess (and possibly review) repeat.
6. `check`, `claim`, `verify`.

Each step is a turn that re-sends the whole conversation, which is why tokens read scale with turns. A single run is demonstration, not proof; step-level attribution is inferred until instrumentation (below) exists.

## Design

### Tiers chosen by the Decision Engine

The controller picks a tier when a session starts and may escalate (never silently de-escalate) as evidence arrives.

**Light (default when all hold):**
- Goal has no open critical human question and no open local question.
- `acceptanceSource` is `project-checks` (the user-approved checks define done), or every requirement maps to an approved check.
- Approved checks are deterministic and inexpensive (recorded duration under a threshold, default 60 s).
- No failure streak, no prior escalation for this prompt.

Light path:
- The runtime performs retrieval itself at start (it already does in `startFromPrompt`) and records it; no agent turn.
- Sufficiency assessment and contract review are **recorded as policy-satisfied** (`assessment.kind = 'policy'`, `review.kind = 'policy'`) with the rule that justified them, instead of asking the agent. Both remain visible in history.
- Protected edits are allowed immediately.
- Verification uses the approved checks against the current source. Stale *context* alone does not block verification on this tier, because acceptance comes from the checks, not from cited context; stale *check artifacts* (pinned verifier digests) still do.
- Steps: edit, `check`/`verify`. Target: at most one optimizer turn beyond the plain agent.

**Standard / Deep (escalation triggers):**
- Open critical human question → `clarify` (human), as today.
- Requirements not covered by approved checks, or prose acceptance → standard: agent assess + review.
- Check failure streak ≥ 2, or a check that fails after a claim → Adaptive Replanning (reconsider), as today.
- Large or risky change signals (many files touched, reserved paths, check runtime over threshold) → standard.
- Each escalation is recorded as a decision event with its trigger, so the benchmark can attribute cost.

Fixed policy constraints (never skipped on any tier): user-approved checks only; independent verification by the runtime; no agent writes to runtime state; human questions route to the human; verified sessions are terminal.

### Context injection

- UserPromptSubmit injects nothing when the project has no active session, no pending proposal and no checkpoint. Enabled-state signalling becomes one short line only when an action is needed (e.g. a pending check proposal).
- The goal dialect and propose-check instructions are injected only when the agent is about to need them (first protected action in a managed project without a contract), not on every prompt.

### Instrumentation

Recorded per session, from real sources only; missing values stay `null`, never estimated:

- Working-agent input, cache-read, cache-write and output tokens per turn (from Claude Code `usage` in `optimizer run`; from transcript usage when available in hook mode).
- Optimizer-injected context: exact bytes and a token count only if a provider count is available, else bytes.
- Per optimizer component (Goal Intelligence, Context retrieval, Decision, Replanning, Verification): wall-clock and subprocess time (existing `#measure`), plus model usage if a component ever calls a model (none do today: record `0`, not `null`).
- Hook and CLI overhead: wall-clock per hook invocation.
- Retries and rework: failed checks, re-retrievals, re-reviews, reverted edits.
- Tier chosen and every escalation with its trigger.

Implemented as `optimizer metrics --project P --session ID` (cost breakdown beside the raw measurements) and the `cost` block of `optimizer run` output, from `cost.ts`:
- Agent tokens: `optimizer run` appends an `agent.usage` event with `num_turns`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `usage` (including `iterations` when present) and `modelUsage` copied verbatim from `claude -p --output-format json`. Per-turn values are what Claude Code reports in `usage.iterations`; nothing else is split. Hook mode: `null` (see Q4).
- Injected context: UTF-8 bytes of the `run` system prompt and of each hook output that reaches the model (`additionalContext`, deny reasons, Stop block reasons), per event. No token count: no provider count of these strings is available.
- Components: existing measurements mapped to Goal Intelligence, Context retrieval, Decision, Replanning, Verification (and `other`); `modelTokens: 0` for each.
- Hook overhead: the hook appends one line per invocation to `.optimizer/hook-metrics.jsonl` with its process wall clock and each runtime CLI call it made.
- Rework: from session events (failed checks, re-retrievals, re-assessments, re-reviews, challenges, reconsiderations, `blocked`) and hook lines (Stop blocks). Reverted edits stay `null`: the runtime does not observe them.

### Benchmark (requires explicit user approval before paid runs)

Arms, identical tasks, repository snapshots, model, permissions, turn budget and hidden acceptance tests:
- A. Plain agent.
- B. Controller with all mandatory gates (today's behaviour).
- C. Adaptive optimizer (this spec).

Tasks: straightforward fixes; ambiguous requests where a human decision matters; multi-file changes; tasks with a misleading first approach where replanning should help. Several repetitions per arm.

Metrics: verified goal satisfaction (hidden test), false "done" claims, total tokens, wall-clock, cost per verified success, optimizer overhead share.

## Acceptance criteria

- AC1: On straightforward tasks, C's median tokens and wall-clock are within 1.25× of A, with equal or better verified satisfaction.
- AC2: On ambiguous/complex tasks, C's verified satisfaction is at least A's, and cost per verified success is no worse than B's.
- AC3: Every run reports the cost categories above, with `null` where no real measurement exists.
- AC4: No policy constraint above is bypassed on any tier (regression tests).
- AC5: No efficiency claim in README or release notes until benchmark results support it.

## Decisions (user, 2026-10-27)

- Q1: Target is within 1.25× of the plain agent on straightforward tasks (AC1 as written).
- Q2: Yes. The light tier records assessment and review as policy-satisfied, with the justifying rule, and asks no agent turn when approved checks define acceptance.
- Q3: Benchmark size is decided after the light tier is implemented and local tests pass. No paid run before that decision.

## Open questions

- Question local Q4: Can hook mode read per-turn token usage reliably from the Claude Code transcript, or only `optimizer run`?
  Answer (2026-10-27): readable, but not proven reliable, so hook mode records `null`. A sample of local transcripts from Claude Code 2.1.283 to 2.1.300 shows each API response written as several `assistant` lines (one per content block) sharing `message.id`, all with identical `usage` (final output tokens, cache fields, `iterations`), plus `<synthetic>` messages with zero usage. Summing per unique `message.id` would therefore work on these versions. It is not used because: the transcript is an undocumented internal format with no stability promise (older versions are reported to have written streaming placeholder `output_tokens`); subagent turns are written to separate files; the Stop hook can run before the last line is flushed; and no transcript sum has been checked against the `claude -p` result `usage` of the same session. One managed run comparing the two would settle it; until then only `optimizer run` reports agent tokens.
- Question local Q5: Check-duration threshold for "inexpensive" (default 60 s) — measure on real projects.
