# Goal contract review

Implements the confirmed working-agent review decision in CONTEXT.md sections 5 and 19. The user authorized continuing implementation from that context.

The current runtime extracts requirements and assesses context, but context sufficiency does not mean the agent has reviewed the goal contract. Add an explicit review checkpoint before execution and completion. Keep the existing TypeScript/SQLite runtime, thin adapter, and independent verifier.

## Chosen shape

Use a separate `ContractReview` discriminated union on session state: pending, accepted, or challenged. Reusing context assessment would conflate evidence sufficiency with contract acceptance and make challenges unauditable. A separate negotiation service would duplicate runtime ownership.

`Goal.version` starts at 1. Imported authority, resolved answers, and added challenges advance the version and invalidate acceptance. Source edits alone require fresh context assessment, not a new review of an unchanged contract. Old event logs default to version 1 and pending review; previously recorded check evidence never bypasses the new gate.

`Runtime.review(sessionId, input)` consumes a schema-validated response containing `kind: accept|challenge`, `goalVersion`, `rationale`, and current context `itemIds`. A challenge also contains `requirementId` and `owner: human|local`. Acceptance requires sufficient context, resolved critical questions, current version, and citations covering all requirements. A challenge requires citations linked to its requirement and creates a critical uncertainty through the existing resolution mechanism. Human answers retain imported user-decision provenance. Review never edits or removes requirement statements or executable checks.

Only one review challenge may remain unresolved at a time. Two challenges per session are allowed; another evidence-backed challenge escalates to the human. This is a bounded prototype policy, not a measured optimum. Review cannot bypass a strategy pause or escalation.

Persist `contract.reviewed` and `contract.escalated` events in the existing transaction. Replay reconstructs review and uncertainty state. Public `next` gains `review` routed to the working agent after clarification and context sufficiency, before execute/verify/complete. `runCheck` enforces the same gate.

CLI: `review --kind accept|challenge --version N --rationale TEXT --items ID,ID [--requirement R1 --owner human|local]`. The adapter adds only the command name. The checkpoint skill instructs actual review, evidence-backed challenge, and honoring returned gates. MCP stays read-only and inherits the new action through the public runtime.

## Scope and proof

Update runtime types, schema, reducer, policy, API, CLI, exports; adapter command and real CLI integration; runtime and verifier test setup; public examples, checkpoint instructions, and handoff. Existing demonstration reports remain historical evidence and are not rewritten to imply they exercised review.

Tests must prove blocked unreviewed execution and completion claims, durable acceptance, local and human challenge resolution, stale-version/citation rejection without events, immutable requirements/checks, old-log pending defaults, and bounded escalation. Run all tests, strict typecheck, compiler lint, build, and an actual CLI integration cycle.

Natural-language provider integration, broader relationship graphs, native host hooks, and comparative efficiency evaluation remain separate work. No dependency or hosted service is required for this change. Git remains unavailable because this session cannot write `.git`.
