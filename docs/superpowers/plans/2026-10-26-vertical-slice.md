# Optimizer vertical slice implementation plan

> **For agentic workers:** Use executing-plans task by task. The user authorized implementation and reversible engineering decisions without another design approval round.

**Goal:** Demonstrate the complete cooperative optimizer cycle on an actual coding task with independent acceptance checks and measured overhead.

**Architecture:** A typed library owns SQLite and deterministic intelligence. CLI and installable checkpoint adapter expose its operations. Existing agent reasoning handles context assessment and reconsideration; optimizer-side LLM inference is unnecessary.

**Tech Stack:** Node.js 24.18.0, TypeScript 5.9.3, SQLite, node:test.

**Spec:** `docs/superpowers/specs/2026-10-26-complete-optimizer-design.md`.

## Global constraints

- Preserve human authority, explicit requirements, and Pause, Reconsider, Resolve.
- Validate external inputs. Goal/context text cannot authorize execution.
- Agent claims never count as independent verification.
- Report unavailable integrations and usage honestly. No efficiency claims from one demonstration.
- Git operations remain blocked; no commits, pushes, publishing, or external configuration changes.

## Review focus

- Critical human ambiguity cannot be resolved by relevance scores or agent assertion.
- Stale context and modified project files invalidate sufficiency and verification.
- Assistant messages, cross-project transcripts, and superseded decisions cannot gain human authority.
- Uncovered requirements, timed-out commands, and code edits during checks prevent completion.
- Repeated failures pause execution; justified responses can retain the current strategy; retries cannot duplicate events.

## File map and interfaces

`packages/runtime/src/types.ts` defines Goal, Requirement, Uncertainty, Check, ContextItem, ContextAssessment, SessionState, NextAction, and Event.

`intelligence.ts` exports `extractGoal(request)`, `assessGate(state)`, and `nextAction(state)`. `context.ts` exports `retrieveContext(projectRoot, goal, decisions)`, `importConversation(projectRoot, path)`, `projectDigest(projectRoot)`, and `isContextCurrent(projectRoot, context)`.

`store.ts` owns transactional sessions, append/replay, and measurements. `runtime.ts` exports public Runtime operations. `process.ts` executes bounded argv. `cli.ts` validates commands. `packages/adapter` supplies installable instructions and checkpoint wrapper. `examples/vertical-slice` holds the coding fixture and external acceptance runner.

## Task 1. Contracts and intelligence

- [x] Write and run failing tests for extraction, critical questions, retrieval/provenance, and three gate outcomes.
- [x] Implement deterministic intelligence against shared types; document exact syntax.
- [x] Run relevant tests and strict typecheck.

## Task 2. Persistent cooperative runtime

- [x] Write failing tests for restart/replay, duplicate/conflicting events, isolation, and routing.
- [x] Implement transactional SQLite and public Runtime operations.
- [x] Prove actual failed commands trigger Pause, explicit rationale permits Resolve, and a budget bounds reconsideration.

## Task 3. Verification and adapter

- [x] Write failing tests for coverage, stale digests, bounds, and false claims.
- [x] Implement registered check execution, CLI, and thin installable checkpoint adapter.
- [x] Exercise installed CLI subprocesses and independent requirement verification.

## Task 4. Demonstration and baseline

- [x] Prepare identical coding fixtures and an external acceptance runner.
- [x] Run the optimizer cycle with an actual coding agent; retain events and measurements.
- [x] Run baseline when possible; report verification, wall time, unknown tokens, and optimizer overhead without improvement claims.

## Task 5. Review and handoff

- [x] Verify package installation and document established commands in AGENTS.md and README.md.
- [x] Run full tests, typecheck, lint, build, and installed CLI check.
- [x] Obtain independent review, fix material findings with regression tests, and report limits.
