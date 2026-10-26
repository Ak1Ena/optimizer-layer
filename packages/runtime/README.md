# Local optimizer runtime

Standalone TypeScript library and `optimizer` CLI. Node.js 24.18.x required. SQLite is built into Node.js. The only runtime dependency is Zod for boundary validation.

See the repository README for goal syntax, CLI workflow, trust boundaries, and the demonstration. This package owns goal/context intelligence, events, decision policies, persistence, and verification. Adapters and optional MCP tools call this API; they do not own optimizer state.

```js
import { Runtime } from '@optimizer-layer/runtime';

const runtime = new Runtime('/absolute/project');
try {
  const session = runtime.start({
    request: '- R1: parseCount handles numbers\nAcceptance R1: parseCount passes independent checks',
    checks: [{ id: 'acceptance', requirementIds: ['R1'], argv: ['node', '/trusted/acceptance.mjs'], timeoutMs: 5000 }],
  });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, {
    kind: 'sufficient',
    rationale: 'Explain why these sources cover the requirement and what uncertainty remains.',
    itemIds: context.items.map(item => item.id),
  });
  runtime.review(session.id, {
    kind: 'accept',
    goalVersion: runtime.get(session.id).goal.version,
    rationale: 'The requirement and acceptance preserve the requested numeric parsing behavior.',
    itemIds: context.items.map(item => item.id),
  });
  // Honor runtime.next(session.id) before further work.
} finally {
  runtime.close();
}
```

An explicitly read-only `new Runtime(project, { readOnly: true })` opens an existing store without initialization or measurement writes. Mutating operations fail. Normal read operations such as status/next are instrumented in writable mode.

Verification checks are trusted, operator-selected argv commands. Register them separately from goal text. They run with this process's privileges and environment; this library is not an arbitrary-command sandbox. Referenced verifier files are pinned; add `artifactFiles: ["/trusted/helper.mjs"]` for helper dependencies not visible in argv. The runtime computes their digests. Changed artifacts require a new operator-registered contract. The current Node executable is trusted as part of the optimizer runtime.

Single-host transactions serialize state and checks. A check holds a write transaction for its bounded duration (at most 30 seconds); other writers fail after a two-second busy wait. No automatic retry executes a command twice. Reads/replay load the session's full event history; this slice targets bounded coding tasks.

Measurements separate registered child-process duration from measured library operation time. Measurement persistence and process startup are not fully included; CLI wall-time measurements in the demonstration capture process overhead separately. Token counts remain unknown when the host supplies none.

Project commands for the Claude Code hooks: `optimizer enable --project P --check CMD [--check CMD ...] [--timeout-ms N] [--yes]` stores user-approved checks (argv split without a shell, shell metacharacters rejected, argv[0] resolved to an absolute path, verifier artifacts pinned) in `.optimizer/project.json` (mode 0600) with a per-project hook token; `disable` turns it off. `start` then accepts no `--checks`: each project check covers every requirement of the new goal, the session becomes the project's active session, and an unfinished active session requires `--replace` (recorded as `session.replaced` on the old session). `current` returns `{enabled, sessionId, action, summary}` with a summary of at most 2,000 characters. `prompt --file F` appends a hook-captured user prompt to `.optimizer/prompts.jsonl` and requires `OPTIMIZER_HOOK_TOKEN`; `resolve --source prompt:ID` resolves a human question from such a row as a whole message. Each row has its own digest, so later prompts keep earlier decisions fresh while editing a row makes it stale. Rows not captured by the hook, or not from the user, carry no authority. The prompt log is capped at the 4 MiB transcript limit.
