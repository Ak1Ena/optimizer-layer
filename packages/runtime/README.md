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

Project commands for the always-on Claude Code hooks. Any folder is a project; on first use the runtime creates `.optimizer/` (0700) for runtime data only and the per-user record `$XDG_CONFIG_HOME/optimizer-layer/projects/<sha256 of the canonical root>.json` (default under `~/.config`, 0600) holding the hook token, approved checks with pinned artifacts, pending proposal, opt-out flag and active session pointer. Anything inside the project, including a committed `.optimizer/project.json`, is never trusted. It records the root in `optimizer-layer/projects.json` (atomic, deduplicated, rebuilt if corrupt), and adds `.optimizer/` to the enclosing repository's `.git/info/exclude` once. `prompt --file F` appends a hook-captured user prompt to `.optimizer/prompts.jsonl` with an HMAC made with the per-user token; once the per-user record exists it requires `OPTIMIZER_HOOK_TOKEN`, and it returns `{id, checkApproved}`. Rows without a valid HMAC carry no authority. `propose-check --check CMD [--check CMD ...] [--timeout-ms N]` stores a pending proposal with a random four-hex-digit code, replacing an earlier one. A token-checked capture whose text contains `approve check CODE` (case-insensitive, whole words) for the pending code makes those checks the project checks, pins verifier artifacts and clears the proposal; nothing else activates it. `enable --check CMD [...] [--timeout-ms N] [--yes]` sets checks directly; `disable` opts the project out. Check commands are split into argv without a shell, shell metacharacters are rejected and argv[0] is resolved to an absolute path. `start` takes no `--checks` once a project has a per-user record, re-validates stored argv with the `enable` rules, and `check` runs only argv that matches a currently approved check (refused entirely when the project is opted out; folders without a per-user record keep the explicit `--checks` behaviour, so use those only in trusted directories). A session reaching verified `complete` clears the active pointer. `runtime.sqlite` and its `-wal`/`-shm`/`-journal` companions are refused when they are symlinks: each approved check covers every requirement of the new goal, and without approved checks it fails naming `propose-check`. The session becomes the project's active session, and an unfinished active session requires `--replace` (recorded as `session.replaced` on the old session). `current` returns `{enabled, checks, pendingChecks, sessionId, action, summary}` with a summary of at most 2,000 characters. `resolve --source prompt:ID` resolves a human question from a captured row as a whole message. Each row has its own digest, so later prompts keep earlier decisions fresh while editing a row makes it stale. Rows not captured by the hook, or not from the user, carry no authority. The prompt log is capped at the 4 MiB transcript limit. `runtime.sessions()` lists session IDs newest first.

`optimizer dashboard [--port N]` (default 8790, `0` for a free port) serves a read-only page and JSON endpoint on `127.0.0.1` for every registered project. It requires a random per-start token and a `127.0.0.1:PORT` or `localhost:PORT` Host header, opens each store with `readOnly: true`, and never returns captured prompts, resolved answers, check output, or the hook token.
