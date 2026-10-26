# Goal Contract Review Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan inline, task by task.

**Goal:** Require an explicit, durable working-agent contract review before registered checks or verified completion.

**Architecture:** Runtime owns versioned review state and events. Challenges become existing provenance-aware uncertainties. CLI and adapter forward review responses without owning policy.

**Tech Stack:** TypeScript ESM, Node.js 24.18.0, built-in SQLite, existing Zod.

**Spec:** `docs/superpowers/specs/2026-10-26-contract-review-design.md`

## Global Constraints

- Preserve user requirements and operator-selected checks.
- No new dependency, hosted-model call, or native-hook claim.
- No Git metadata writes are available; preserve a source snapshot for diff review.

## Review Focus

- Pending/legacy reviews cannot become completion through old check evidence or a claim.
- Concurrent stale-version responses fail before event persistence.
- Human challenges require actual imported user decisions; local documents cannot authorize them.
- Context or answer changes cannot reuse an acceptance of a different contract version.
- Review and challenge cannot bypass strategy control; repeated challenges escalate.

## Task 1: Durable review and shared execution gate

Files: runtime `types.ts`, `schema.ts`, `intelligence.ts`, `store.ts`, `runtime.ts`, `index.ts`; runtime intelligence/store/runtime/verifier tests; new `contract-review.test.ts`.

Interfaces: `Goal.version: number`; `SessionState.review: ContractReview`; `ReviewResponse` accept/challenge union; `Runtime.review(sessionId: string, input: ReviewResponse): SessionState`; `Gate` and `NextAction` add `review`.

- [x] Add behavior tests and observe failures for missing review gate/API.
- [x] Implement schemas, pending defaults, version advancement, review events, and shared policy.
- [x] Test durable accept; human/local challenges; stale/unknown/empty inputs; immutable requirements and checks; challenge budget; old logs and control gates.
- [x] Update existing test consumers to explicitly accept contracts. Run runtime tests and typecheck.

## Task 2: Complete cooperative workflow

Files: runtime CLI; adapter command union, real CLI test and checkpoint skill; MCP verifier-test setup if needed; root/runtime/adapter READMEs; handoff and implementation ledger.

Interfaces: CLI `review` options from the spec; adapter `OptimizerCommand` includes `review`. No adapter policy and no MCP write tool.

- [x] Extend the actual CLI integration test to prove review blocking, challenge resolution, and acceptance.
- [x] Observe failure, then add CLI/adapter support and update documentation/examples.
- [x] Run full `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` using Node 24.18.0.
- [x] Review snapshot diff and obtain a fresh review of changed code. Fix concrete blockers with regression tests.
- [x] Record results and remaining limits. Do not modify historical demonstration evidence.
