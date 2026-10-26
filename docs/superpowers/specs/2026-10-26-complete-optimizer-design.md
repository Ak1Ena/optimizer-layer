# Complete optimizer vertical slice

Date: 2026-10-26
Status: Implementation authorized by the user's revised milestone instructions.

## Delivery target

Demonstrate Understand Goal, Retrieve Context, Resolve Critical Uncertainty, Execute, Observe, Reconsider if Needed, and Verify Goal in one actual coding-agent task. Infrastructure and intelligence land incrementally within this milestone. Event collection alone is insufficient.

Keep a standalone TypeScript/Node.js 24 runtime library and CLI, project-local SQLite, versioned events, thin installable adapters, and optional MCP access. No daemon, external database, embeddings, learned policy, or mandatory optimizer LLM calls.

## Minimum real intelligence

Goal extraction recognizes requirement bullets and acceptance lines in a small documented Markdown dialect. Plain prose becomes a requirement with an unresolved acceptance uncertainty, rather than a fabricated executable specification. Explicit human/local questions become critical uncertainties. Each requirement retains its source text and acceptance statement. Runtime inference is deterministic; the working agent can help the human write richer contracts.

Executable checks are separately registered by the operator as argv arrays mapped to requirement IDs. Goal text and retrieved documents never become executable commands. Uncovered requirements prevent completion. Checks are independent of agent completion claims.

Context retrieval searches bounded project code and documents using goal/acceptance terms. It imports explicitly selected previous harness conversations, extracts only user-authored `Decision:` statements, and stores provenance including transcript path, line, digest, timestamp, role, and project. It links retrieved evidence to requirements and uncertainties. Documents and assistant statements are untrusted evidence, never authorization. Superseded decisions are excluded. Symlinks, private state, environment files, dependency directories, and oversized files are excluded with coverage diagnostics.

The sufficiency gate returns proceed, investigate, or clarify. Critical human uncertainties require an explicit answer with a source reference. Missing evidence, stale context, incomplete scans, and unresolved technical questions route to investigation. Keyword matches alone do not establish semantic sufficiency; the agent explicitly assesses retrieved evidence, citing current item IDs and explaining sufficiency or missing context.

The observer persists actual subprocess outcomes, completion claims, and strategy responses. The decision engine routes local retrieval, human clarification, agent execution/reconsideration, and independent verification. Activity is distinct from verified progress.

Three consecutive unsuccessful checks with the same signature request a pause at the next cooperative checkpoint. A justified agent response may retain or change its strategy. The optimizer never forces a replacement plan. Bounded reconsideration rounds escalate persistent failure to the human. The state transition is Pause, Reconsider, Resolve; execution must not continue while a pause is unresolved.

Verification runs operator-registered commands without a shell, with timeout and output bounds. It records exit status, output digest/excerpt, check identity, requirement links, and project content digest. Completion requires every requirement to have passing registered evidence at the current project digest, all critical uncertainties resolved, and no pending reconsideration. Agent claims cannot satisfy criteria. Checks changing project files invalidate their results. Tests outside the working agent's fixture are preferred for independent acceptance coverage.

## Boundaries and recovery

`packages/runtime` owns types, extraction, retrieval, gates, policies, SQLite, process execution, and CLI. Public Runtime operations cover goal creation, history import, retrieval, assessment, clarification, next action, tool/check execution, reconsideration, verification, and state/events. Only runtime writes optimizer state.

`packages/adapter` provides a thin checkpoint integration and installable coding-agent skill. The agent requests context, records a reasoned assessment, executes checks through runtime, honors pause/clarification, and supplies justified strategy responses. It does not implement policy or impersonate human approval. The current coding-agent harness can exercise it; a hosted CLI integration is an additional target subject to network availability.

Optional MCP tools are read-only public API views using the official SDK if an offline installed copy is available. MCP is unnecessary for the central demonstration. Report its delivery status explicitly; no protocol placeholders.

Each project has `.optimizer/runtime.sqlite`, bound to its canonical path. SQLite transactions persist versioned events and state together. Identical event retries are idempotent; conflicting reuse fails. State is reconstructable from events. Unknown schema versions fail before writes. WAL and bounded busy handling support independent command processes.

Recheck source hashes before proceeding; changed files require new retrieval and assessment. Project digests cover the documented eligible file set. Cross-project imports, traversal, symlinks, malformed payloads, stale decisions, scan limits, and stale checks are explicit failure cases.

## Demonstration and measurement

Use a coding fixture with independent acceptance tests, a prior user decision in an imported conversation, and a critical question resolved before execution. Exercise actual failing commands, reconsideration, agent code edits, and passing checks. Negative tests cover unresolved uncertainty and stale evidence.

Run an equivalent clean baseline without optimizer guidance when the harness permits it. Record setup, harness identity, elapsed time, requirement counts, failures, and unknown token counts. Record optimizer operation time separately from child command time and agent waiting time. Include failed attempts. A single pair is demonstration evidence, not proof of efficiency improvement.

## Verifiable units

1. Toolchain and intelligence. Test extraction, provenance, retrieval, and all gate outcomes.
2. SQLite runtime. Test replay/restart, idempotency, isolation, cooperative transitions, and real subprocess observations.
3. Independent verification and adapter. Test coverage, stale evidence, bounds, and false completion claims.
4. Actual coding-agent demonstration with retained evidence and baseline where available.
5. Packaging, documented commands, complete checks, and independent code review.

## Decisions and limits

Keep command-driven runtime. A daemon adds service lifecycle and IPC without improving this checkpoint workflow. Skills provide cooperative control, not preemptive interruption. Semantic understanding is restricted to the documented goal dialect plus working-agent assessment. Import history explicitly rather than scraping unrelated sessions. Subjective criteria remain unverified without suitable human evidence.

Node.js 24.18.0 and built-in SQLite were verified locally. Registry and hosted-model domains currently fail DNS resolution. Git metadata writes are protected. These constraints do not justify mocks or unperformed validation claims.
