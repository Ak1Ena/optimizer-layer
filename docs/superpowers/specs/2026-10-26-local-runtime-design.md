# Local optimization runtime foundation

Date: 2026-10-26
Status: Superseded by [the complete optimizer vertical slice](2026-10-26-complete-optimizer-design.md). Retained as architectural background; its observation-only milestone is no longer the delivery target.

## Goal and constraints

Build a standalone local optimization runtime with thin, installable agent adapters and optional MCP tools. Preserve the goal, evidence, authority, and quality constraints in `CONTEXT.md`.

The runtime must be usable from a terminal without an agent host, MCP server, cloud account, API key, or LLM inference. Integrations provide observation and supported communication; the runtime owns policy and persistent state.

This document specifies the first executable milestone and the boundaries later work must preserve. It does not claim that telemetry alone improves agent performance. Goal interpretation, context retrieval, independent verification, and comparative evaluation remain subsequent milestones.

## Verified starting point

- Only `AGENTS.md` and `CONTEXT.md` existed when work began.
- No code, dependency manifest, build configuration, or test commands exist.
- The active shell has Node.js 20.20.0, npm 10.8.2, and Python 3.14.8; no `tsc` executable was found on PATH.
- `git init -b main` failed with `.git: Operation not permitted`. Git metadata writes are protected in this session; the directory is not yet a Git repository.

## Proposed choices

These are implementation recommendations, not previously confirmed user decisions:

- TypeScript, ESM, npm workspaces, and Node.js 24 as the initial runtime target. The installed Node.js 20 must be replaced or supplemented before verification.
- Built-in SQLite through `node:sqlite`, avoiding a native third-party database dependency. Verify the API and its experimental status on the exact selected Node.js version before implementation; do not use APIs found only in newer Node.js versions.
- A command-driven runtime initially. Each invocation performs a bounded transaction and exits. No background service is required.
- Claude Code as the first native plugin target because its documented plugin and hook interfaces support a small observational integration. Codex and OpenHands integrations follow separately after their actual interfaces are checked.
- A separate optional MCP package using the official TypeScript SDK. No hand-written JSON-RPC implementation.

## Caller experience

The commands below specify intended behavior; they are not available yet.

```sh
optimizer init --project /path/to/project
optimizer session start --project /path/to/project --agent manual
optimizer event ingest --project /path/to/project < event.json
optimizer status --project /path/to/project --session SESSION_ID
optimizer events --project /path/to/project --session SESSION_ID
```

`init` creates a private `.optimizer/` state directory only in an explicitly selected project. Repeating initialization preserves existing history. Commands return structured JSON on stdout; diagnostics go to stderr. The initial runtime does not execute tools, launch agents, or install integrations automatically.

The CLI supports a manual producer so the runtime can be exercised before a provider is connected. Agent hooks use an explicit `optimizer adapter claude-code hook` command that reads host JSON from stdin, validates it, translates supported fields, and invokes the runtime application API.

The native plugin is loadable from its local directory for development and distributable through the host's normal plugin mechanism. It references an explicitly configured runtime executable; hooks must not download packages or run an unpinned `npx` command.

## Ownership and package boundaries

Planned workspace layout:

```text
packages/runtime/             Domain types, application API, SQLite store, CLI
packages/adapter-claude-code/ Host payload validation and normalization
plugins/claude-code/          Native plugin manifest, hooks, concise usage docs
packages/mcp/                 Optional stdio MCP server
```

Only the runtime package owns the database schema and writes state. Adapters and MCP import its public application API; they cannot import storage internals. The CLI is the process boundary for native hooks. Separate processes share SQLite transactions, not a second state cache.

The public API hides validation, persistence, retry handling, projection, and policy evaluation behind these operations:

```text
openRuntime(projectRoot) -> Runtime
Runtime.startSession(agent, externalSessionId?) -> Session
Runtime.ingest(event) -> { accepted | duplicate, state, advisories }
Runtime.getSession(sessionId) -> SessionState
Runtime.listEvents(sessionId, afterSequence?, limit?) -> EventPage
Runtime.close() -> void
```

These signatures are design notation, not source scaffolding. Unknown input is parsed at CLI, adapter, and MCP boundaries; internal code receives validated domain values.

## Events and reconstructed state

Protocol version 1 has a common envelope: event ID, session ID, source, source timestamp and sequence when available, event kind, and a kind-specific payload. The runtime adds the canonical project scope, receive timestamp, and monotonic local sequence. Use discriminated payloads rather than an untyped attribute bag.

Initial event kinds cover session start/end, tool start/success/failure, completion claims, and usage reports. A completion claim changes the observed agent state; it never sets verified goal completion. Verification is unavailable until a separate evidence contract and verifier exist.

Normalize usage to cumulative input/output token counts only when a provider supplies reliable values. Unknown usage remains unknown. Do not mix cumulative snapshots with per-call increments or infer wall-clock savings from hook execution times.

Persist normalized metadata needed for observation: provider session/tool correlation IDs, tool name, normalized error category, and optional usage. Do not retain full prompts, transcripts, tool arguments, tool outputs, or secrets by default. Error fingerprints use bounded metadata rather than raw command/output text.

Each accepted event and its derived advisory records commit in one transaction. Replaying ordered events reconstructs session state; no authoritative in-memory state is required between commands. Cross-project and unknown-session events are rejected. An end event is idempotent; late observations can be recorded without reopening an ended session. Events after an apparent tool finish must not fabricate a missing start.

Local sequence defines ingestion order, not necessarily execution order. Preserve producer order metadata and tool correlation IDs. The initial repeated-failure policy operates on received tool results; report this limitation when a producer cannot guarantee ordered delivery.

Deduplication keys are scoped to the project and producer. Retrying an identical event ID returns a duplicate receipt; reusing an ID with different normalized content is an error. Provider inputs without stable unique IDs must document their deduplication limitation rather than inventing reliable exactly-once delivery.

Use SQLite WAL, bounded busy handling, and explicit transactions. Concurrent CLI writers either commit completely or return an actionable retryable error; ingestion must not acknowledge uncommitted data. Partial schema initialization must be recoverable. Unknown newer schema or protocol versions must fail clearly.

## First optimization policy

Provide one deterministic, observe-and-advise policy: report repeated failures of the same tool and normalized error category after three consecutive matching failures in one session. A successful tool result resets the streak. A different failure starts a new streak. Emit once per streak rather than on every subsequent failure.

The advisory asks the working agent to reconsider using the observed evidence; it cannot block commands, replace a strategy, or claim that three failures prove stagnation. Three is an initial demonstrator threshold, not an evaluated optimum. Advice output is distinct from ordinary successful hook output; only host-supported channels may deliver it to the agent.

## Adapter behavior

The Claude Code plugin observes supported session and tool lifecycle hooks. A Stop hook means the agent has stopped responding or claims completion, not that the user's goal is verified. SessionEnd represents host session termination.

The adapter advertises only capabilities implemented and verified against the target host version. Initial capabilities are observation and, where supported, advisory feedback. Pause/resume, arbitrary context injection, command blocking, and agent launching are not advertised.

Hook integration must preserve normal agent execution when the observer is unavailable or receives unsupported data: bound input and elapsed time, diagnose on stderr, and avoid turning infrastructure failure into a blocking host exit code. Direct CLI ingestion still reports errors to its caller. Unknown hook types are ignored with a concise diagnostic; malformed recognized payloads are rejected before persistence.

The adapter derives project identity from the host's working directory and resolves it against an initialized project root; it never trusts a payload-provided database path. Concurrent host sessions map separately through provider name and external session ID. Restart/resume uses that mapping rather than silently creating a new session every hook call.

## Optional MCP surface

The optional stdio server is explicitly bound to one initialized project root at startup. Initial tools are read-only: `optimizer_session_status` and `optimizer_session_events`, with bounded pagination. It forwards to the runtime application API and owns no state or policy. MCP is not the event transport required by hooks.

Do not accept arbitrary filesystem roots or SQL in tool arguments. Preserve normal SDK negotiation, tool input validation, error responses, and stdout framing. Diagnostic output goes to stderr. Mutating MCP tools, generic shell execution, and background monitoring are outside the first milestone.

## Alternatives and synthesis

**Command-driven application API with SQLite:** chosen as the initial shape. Callers need an executable or a small library API. Transactions own consistency. It avoids service installation, stale sockets, startup ordering, and daemon shutdown behavior while delivering persisted local observation.

**Daemon with local IPC:** a viable later shape for live subscriptions, process supervision, or coordinated interruption. It centralizes writes, but introduces authentication, socket lifecycle, client retry, service discovery, and recovery before those capabilities are needed. Keep domain and store code independent of the CLI so a future daemon can reuse them.

**Host plugin as the runtime:** rejected. It ties state lifetime and policy to one agent and makes independent use and cross-agent comparisons harder. Optional MCP-only orchestration has the same ownership problem and cannot guarantee automatic lifecycle observation.

Accept per-invocation startup overhead and bounded SQLite writer contention in exchange for a smaller install and recovery surface. Measure that overhead before deciding a daemon is necessary.

## Verifiable delivery sequence

1. Establish the Node.js toolchain, strict TypeScript package boundaries, test runner, lint, and typecheck commands. Check: compile a minimal public entry point and run the commands; record only verified commands in `AGENTS.md`.
2. Implement project initialization, versioned event validation, SQLite ingestion, replay, and CLI queries. Check: real subprocess round trip, process restart recovery, malformed/cross-project rejection, concurrent ingestion, and duplicate/conflicting event IDs.
3. Implement the repeated-failure advisory. Check: exact output after three matching failures, no duplicate advice, reset on success, and no verified-completion claim after an agent completion event.
4. Implement and package the thin Claude Code adapter/plugin. Check: recorded host payloads through the real CLI; local plugin load and one real host session when the host is available; preserve host behavior during runtime failure. Fixture checks alone must be reported as partial integration validation.
5. Add the optional MCP package. Check: official SDK client negotiation and read-only queries reproduce CLI state, invalid/cross-project requests fail, and runtime/plugin operation works without installing the MCP package.
6. Review install artifacts. Check: build and pack the npm packages, install into a temporary clean prefix, run the installed executable against a temporary project, and verify native plugin files and paths. Local packaging is authorized; publishing and changes to the user's installed agent configuration require separate approval.

The milestone is done when an installed local runtime can ingest a host lifecycle/tool trace, survive restart, reconstruct project-isolated state, emit the expected advisory, and expose matching results through CLI and optional MCP. Any unavailable live-host validation remains explicitly incomplete.

## Deferred scope and risks

Codex/OpenHands adapters, goal interpretation, context graphs, embeddings, dashboards, model routing, pause/reconsider control, autonomous verification, learned policies, and optimization benchmarks follow the foundation. Do not stub them or advertise their capabilities now.

The Node.js version change is a prerequisite. SQLite API maturity, hook coverage, payload stability, missing stable event IDs, and process startup overhead need verification during implementation. No efficiency or quality improvement is established until controlled comparisons include optimizer overhead and failed runs.

## Sources checked

- [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html): built-in database API; verify the version-specific subset before coding.
- [Claude Code plugin overview](https://code.claude.com/docs/en/plugins) and [manifest reference](https://code.claude.com/docs/en/plugins-reference): native plugin packaging and component ownership.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): lifecycle inputs and event-specific control behavior.
- [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server): optional tools and stdio output discipline.
