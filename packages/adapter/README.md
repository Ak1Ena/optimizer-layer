# Coding-agent checkpoint adapter

`@optimizer-layer/agent-adapter` is a thin, dependency-free Node.js 24 transport for the standalone optimizer CLI. It includes the installable `optimizer-checkpoint` skill. The runtime owns all state, decisions, and verification policy.

## Install

Build and pack from the repository root:

```sh
npm run build
npm pack ./dist/npm/adapter
npm install /absolute/path/to/optimizer-layer-agent-adapter-0.1.0.tgz
```

Install the runtime package separately and configure its absolute executable path. For Codex, copy the packaged `skill/optimizer-checkpoint` directory into your chosen skill directory (normally `~/.codex/skills/optimizer-checkpoint`), then start a new session. Other coding agents can load the same `SKILL.md` as explicit task instructions. For Claude Code, copy it to `~/.claude/skills/optimizer-checkpoint`. The `optimizer` and `optimizer-mcp` binaries use `#!/usr/bin/env node`; if the agent's default `node` is older than 24.18, `node:sqlite` is missing, so put a wrapper on `PATH` that runs the binary with an explicit Node.js 24 executable. The package modifies host configuration only when you run `optimizer-claude-hook install`, and installs no background service.

## Claude Code hooks

The package exposes `optimizer-claude-hook`. Run `optimizer-claude-hook install [--settings PATH]` once; it merges `UserPromptSubmit`, `PreToolUse` (`Edit|Write|MultiEdit|NotebookEdit|Bash`), `Stop`, `SubagentStart` (contract context for subagents during an active session) and `SessionStart` (`startup|resume`, running `optimizer-claude-hook ensure --settings PATH`) entries into `~/.claude/settings.json` (or `PATH`), writes `PATH.optimizer-backup` first, replaces its own entries on re-install (including entries whose paths moved), and leaves every other key and hook alone. `ensure` is silent and changes nothing when all entries are in place, otherwise reinstalls them; it never prints to stdout and always exits 0. `optimizer-claude-hook uninstall [--settings PATH]` removes only its entries. The hook command pins `process.execPath` (Node.js 24) and the runtime executable: `OPTIMIZER_BIN` at install time, else `optimizer` on `PATH`. The hook also puts its own Node.js first on `PATH` for the runtime child, so a `#!/usr/bin/env node` runtime binary does not pick up an older default `node`.

Without arguments the bin handles one hook event from stdin. With `OPTIMIZER_DISABLED=1`, or when the project's per-user record (`$XDG_CONFIG_HOME/optimizer-layer/projects/<sha256 of the root>.json`, default under `~/.config`) says `enabled: false`, it exits silently. A `.optimizer/project.json` inside the project is ignored. The project root is the nearest ancestor of the hook `cwd` that has `.optimizer/` (home only when `cwd` is home), else `cwd`; never the filesystem root or a path inside `.optimizer/`. `UserPromptSubmit` calls the runtime's `prompt` (which creates project state on first use) and `current`, and injects context: the captured prompt ID, a pending check proposal's argv with its `approve check CODE` phrase, and either the no-contract guidance (including `propose-check` when no checks are approved) or the active session's summary and checkpoint. `PreToolUse` and `Stop` read the active-session pointer from the per-user record and do not spawn the runtime without one, so nothing is blocked before a task starts. With an active session: edit denials while the action is clarify/review/retrieve/reconsider/escalate, and Stop blocks while the task is unverified (loop guard in `.optimizer/hook-state.json`, at most three consecutive blocks). Edits to `.optimizer/` outside the root's `drafts/` or into the per-user store, and the Bash guard, apply always; `propose-check` passes the guard. The adapter holds no policy beyond mapping runtime actions to hook responses. Internal errors fail open with one stderr line.

## Transport

```js
import { runOptimizer } from '@optimizer-layer/agent-adapter';

const result = runOptimizer({
  executable: '/absolute/path/to/optimizer',
  projectRoot: '/absolute/path/to/project',
  sessionId: 'session-returned-by-start',
  command: 'next',
});

if (result.kind === 'response') {
  // Inspect the runtime response and exitCode, including nonzero check results.
  console.log(result.value);
} else {
  console.error(result);
}
```

For a source checkout, use `executable: process.execPath` and `args: ['/absolute/path/to/packages/runtime/src/cli.ts']`. Optional `options` passes command options as individual argv values, for example `{ check: 'acceptance' }`. Routing options `project` and `session` belong in the top-level input. No shell is used.

The synchronous transport returns one of four results:

- `response`: parsed JSON object or array, original `exitCode`, and stderr. A failed registered check is a valid response with a nonzero exit code. Parse `value` as the runtime's command-specific contract before using it; its type is `unknown`.
- `runtime-error`: nonzero exit with empty stdout; stderr contains the runtime's diagnostic. This includes rejected commands, such as execution during a pause.
- `protocol-error`: malformed, missing, or scalar JSON response. It retains the process exit code and stderr.
- `transport-error`: spawn failure, signal, deadline, or output overflow. The exit code can be null.

Executable and project paths must be absolute. Invalid routing options and deadlines throw `TypeError` before process creation. Output is bounded to 1 MiB per stream by Node's child-process buffer limit. The default transport deadline is 60 seconds; set `timeoutMs` above the total expected check time when `verify` runs several checks. A transport timeout interrupts the runtime process; an in-flight verifier may continue until its own timeout. Inspect running work and use `status` before retrying rather than assuming a check was recorded. Keep `events` requests bounded with `limit` and `after`.

## Cooperative limits

The skill provides the complete context, clarification, contract review, execution, reconsideration, and verification cycle using an ordinary command tool. Accept or challenge the current `goal.version` through the runtime's `review` command; the adapter owns no review policy. Challenges require cited requirement evidence and are resolved as local or human questions. It supports real imported user decisions and independent registered checks. It does not scrape unrelated conversations, infer permission from documents, or create human decisions.

Without the hooks this is checkpoint cooperation: it cannot preempt a host agent, intercept every tool call, or enforce pauses if the host ignores the skill. The Claude Code hooks enforce edit-tool denials and Stop blocks, but do not intercept Bash file edits; those surface later as stale context and failed verification. There is no hosted CLI integration, MCP dependency, second policy engine, or adapter-owned state store. The runtime's evidence proves the registered acceptance contract, not arbitrary unstated intent.

## Development

From the repository root:

```sh
node --test packages/adapter/test/*.test.ts
npm run typecheck
```

Transport tests use real Node child processes. Hook tests feed real hook JSON to the bin against the real runtime CLI, with `HOME` and `XDG_CONFIG_HOME` set to temporary directories, and run the installer and `ensure` on a temporary settings file. The integration test runs the real runtime CLI through clarification, review blocking, a cited challenge and resolution, acceptance, three failed independent checks, pause, justified reconsideration, code edits, refreshed local evidence and review, and passing verification.
