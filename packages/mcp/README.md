# Optimizer MCP

Optional read-only stdio access to one initialized local optimizer project. Requires Node.js 24.18.0 and `@optimizer-layer/runtime` 0.2.0. MCP is not needed to run the optimizer or adapter.

```sh
optimizer-mcp --project /absolute/path/to/project
```

Initialize the project and create a session with the runtime CLI first. Startup requires an explicit project; it never creates `.optimizer` or a database. The runtime opens SQLite in read-only mode and omits measurements during reads. Project scope is fixed for the process lifetime, with no per-call root override. Stdio is the only transport. Diagnostics use stderr.

## Tools

`optimizer_session_status({ sessionId })` returns session ID, control kind/round count, next action kind/route, completion claim, requirement count, unresolved uncertainty count, current context availability/item count/completeness/assessment kind, check count, and command observation count. Counts are observations, not proof of completion; use the returned next action kind for the runtime's current decision.

`optimizer_session_events({ sessionId, afterSequence?, limit? })` returns metadata only: sequence, timestamp, and event kind. The sequence cursor is exclusive. `limit` defaults to 25 and must be an integer from 1 to 100. `afterSequence` defaults to zero and must be a nonnegative safe integer. `nextAfterSequence` is the last returned sequence when another page exists, otherwise `null`. Sequence numbers are project-global and can have gaps within one session.

Both tools return JSON text plus matching `structuredContent`. They exclude goal and acceptance text, file paths, imported decisions, command arguments and output, excerpts, rationales, and free-text control/action reasons. There is no opt-in tool argument for exposing these fields. Unknown or unreadable sessions return a generic error; root/SQL/unknown arguments and invalid pagination fail schema validation. No tools execute commands or mutate sessions.

Responses are bounded, but the current Runtime API reconstructs state and reads a session's event history before slicing a page. Very large histories therefore still cost memory and replay time.

## Verification and dependency provenance

The implementation uses the official `@modelcontextprotocol/sdk` 1.32.1 `McpServer`, `StdioServerTransport`, `Client`, and `StdioClientTransport` APIs, with Zod 4.6.5. Integration tests spawn the real server, negotiate protocol `2025-11-25`, initialize, list tools, call tools, and validate project isolation, pagination, read-only state, private command output, and uninitialized startup. No hand-written JSON-RPC or mock transport is used.

From the workspace:

```sh
node --conditions=development --test packages/mcp/test/*.test.ts
```

Source tests use the runtime workspace package's `development` export. Built packages import the regular `@optimizer-layer/runtime` distribution; no external filesystem paths appear in package manifests.

Installation from the registry with the declared dependencies, and a stdio initialize/tools-list handshake against the installed binary, were verified on 2026-10-26. HTTP transports and SDK features outside these tools were not tested.
