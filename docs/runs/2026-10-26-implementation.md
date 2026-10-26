# Implementation ledger

Plan: `docs/superpowers/plans/2026-10-26-vertical-slice.md`.

## Workflow

- [x] Read principles and frame falsifiable outcome.
- [x] Design workflow and revise binding specification.
- [x] Run units through failing test, implementation, and passing check.
- [x] Keep decision/evidence trail.
- [x] Verify complete cycle and obtain independent review.

## Rulings

- The user authorized implementation and reversible decisions. No additional design approval round.
- Git metadata is protected. Work locally in the authorized workspace; Git worktree/commit helpers cannot run. Use this ledger and nonoverlapping file ownership.
- Node.js 24 is installed. Use explicit PATH rather than change machine configuration.
- Registry DNS is blocked. Copy installed dev tools into ignored node_modules; keep portable exact dependency declarations.
- Preserve the full vertical slice. Optional transports cannot replace core behavior.

## Preflight

Intelligence/context consume shared domain types. Runtime consumes their typed results. Adapter consumes only public Runtime/CLI. Executable checks are registered separately from free text. No parallel authoritative state.

## Evidence

- Node.js 24.18.0, SQLite 3.53.1, TypeScript 5.9.3 verified locally.
- Hosted-model and registry DNS unavailable. Codex installed/authenticated; no hosted invocation claimed.
- Final full suite: 49/49 passed. Strict typecheck, compiler lint, and build passed.
- Two actual coding-agent runs independently passed R1–R3. The optimized workflow exercised clarification, cited sufficiency, three controlled failed checks, cooperative pause/reconsideration, source refresh, and independent verification.
- [Coding-agent evidence](2026-10-26-vertical-slice-results.json) includes all five command observations and optimizer measurements. A single slower optimized run does not establish efficiency improvement.
- [Packaging evidence](2026-10-26-packaging-results.json) includes a clean offline tarball install and installed CLI/adapter/MCP checks against the final built runtime, including artifactFiles registration. Registry-backed clean installation remains unverified.
- Independent core and final reviews found no remaining concrete blocker. Regressions cover appended transcript provenance, directly executed verifier pinning, and stale-artifact requirement labels.
- User requested a handoff before the previous final response. [handoff.md](../../handoff.md) records delivered scope, exact checks, environment constraints, raw artifact locations, and resume priorities.

## Remaining limits

Goal interpretation is restricted to the documented dialect; history is explicitly normalized/imported; control is cooperative through checkpoints. Native hosted CLI integration and statistically useful efficiency evaluation remain open. Build staging currently overlays generated outputs, so prune owned generated artifacts before future source deletions. Git initialization is blocked by protected metadata writes.

## Contract review follow-up

Context checked: CONTEXT.md v0.5, especially the confirmed working-agent contract review/challenge protocol in sections 5 and 19.

- Added explicit pending/accepted/challenged review state, goal versions, durable review/escalation events, and a shared gate before checks and completion.
- Challenges use the existing local/human uncertainty protocol and cannot remove requirements or alter registered checks. Their requirement, reason, citations, and owner remain in the event log, including budget escalation.
- Updated CLI, adapter command, checkpoint skill, public examples, and affected tests. Historical demo/packaging reports remain unchanged.
- Ruling: keep review separate from context assessment — evidence sufficiency and contract acceptance are different decisions — cost if wrong: one extra explicit checkpoint.
- Ruling: allow two challenges before escalation — bound negotiation in this prototype — cost if wrong: a difficult contract may need earlier human involvement.
- Ruling: source edits alone retain acceptance of the same goal version; reopened local answers require resolution and fresh review — preserve provenance without reviewing every unchanged requirement after every edit — cost if wrong: conservative source hashing can cause extra reviews.
- Ruling: implement inline with a fresh read-only review — interfaces are tightly connected and runtime remains sole state owner — cost if wrong: no independent reviewer between individual implementation steps.
- A fresh reviewer found two blockers, reproduced before fixes: schema defaults broke identical retries of pre-review events; budget escalation discarded its triggering concern. Canonical event comparison and persisted escalation review evidence address both, with regressions.
- Validation: 58/58 tests passed; strict typecheck, compiler lint, and build passed on Node.js 24.18.0. The actual CLI integration test exercised challenge, cited resolution, acceptance, strategy reconsideration, changed-source answer refresh, and independent completion. A smoke check against the compiled runtime also proved pending review blocks execution and accepted review reaches independent R1 completion.
- Fresh read-only review confirmed both blockers fixed and found no remaining concrete blocker. No minor findings were deferred.
- Expanded the root README at the user's request with purpose, lifecycle, package ownership, capabilities, repository layout, setup/packaging, usage, limits, and evidence links. Documentation links and CLI help were checked separately; historical evidence remains unchanged.
