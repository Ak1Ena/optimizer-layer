# Coding-agent checkpoint adapter

`@optimizer-layer/agent-adapter` is a thin, dependency-free Node.js 24 transport for the standalone optimizer CLI. It includes the installable `optimizer-checkpoint` skill. The runtime owns all state, decisions, and verification policy.

## Install

Build and pack from the repository root:

```sh
npm run build
npm pack ./dist/npm/adapter
npm install /absolute/path/to/optimizer-layer-agent-adapter-0.3.0.tgz
```

Install the runtime package separately and configure its absolute executable path. For Codex, copy the packaged `skill/optimizer-checkpoint` directory into your chosen skill directory (normally `~/.codex/skills/optimizer-checkpoint`), then start a new session. Other coding agents can load the same `SKILL.md` as explicit task instructions. For Claude Code, copy it to `~/.claude/skills/optimizer-checkpoint`. The `optimizer` and `optimizer-mcp` binaries use `#!/usr/bin/env node`; if the agent's default `node` is older than 24.18, `node:sqlite` is missing, so put a wrapper on `PATH` that runs the binary with an explicit Node.js 24 executable. The package modifies host configuration only when you run `optimizer-claude-hook install`, and installs no background service.

## Claude Code hooks

The package exposes `optimizer-claude-hook`. Run `optimizer-claude-hook install [--always-on] [--settings PATH]` once. The default is opt-in: the hooks act only in folders you turned on with `optimizer enable --project P`. `--always-on` makes every folder a project with no enable step. The mode is pinned in the hook command as `OPTIMIZER_MODE='opt-in'` or `'always-on'`, and re-running `install` without `--always-on` switches back to opt-in. It merges `UserPromptSubmit`, `PreToolUse` (`Edit|Write|MultiEdit|NotebookEdit|Bash`), `Stop`, `SubagentStart` (contract context for subagents during an active session) and `SessionStart` (`startup|resume`, running `optimizer-claude-hook ensure --settings PATH`) entries into `~/.claude/settings.json` (or `PATH`), writes `PATH.optimizer-backup` first, replaces its own entries on re-install (including entries whose paths moved), and leaves every other key and hook alone. `ensure` is silent and changes nothing when all entries are in place, otherwise reinstalls them in the mode the existing entries record (entries without a mode marker predate modes and behaved always-on, so they stay always-on; with no entries it installs opt-in); it never prints to stdout and always exits 0. `optimizer-claude-hook uninstall [--settings PATH]` removes only its entries. The hook command pins `process.execPath` (Node.js 24) and the runtime executable: `OPTIMIZER_BIN` at install time, else `optimizer` on `PATH`. The hook also puts its own Node.js first on `PATH` for the runtime child, so a `#!/usr/bin/env node` runtime binary does not pick up an older default `node`.

Without arguments the bin handles one hook event from stdin. With `OPTIMIZER_DISABLED=1`, or when the project's per-user record (`$XDG_CONFIG_HOME/optimizer-layer/projects/<sha256 of the root>.json`, default under `~/.config`) says `enabled: false`, it exits silently. In opt-in mode it also exits silently, creating nothing and never spawning the runtime, unless that record carries the `optedIn` flag that only `optimizer enable` sets; the spawn-free `PreToolUse` guards below still apply there. A `.optimizer/project.json` inside the project is ignored. The project root is the nearest ancestor of the hook `cwd` that has `.optimizer/` (home only when `cwd` is home), else `cwd`; never the filesystem root or a path inside `.optimizer/`. The hooks hold no policy of their own: they ask the runtime controller (`gate`, `decide`, `blocked`) and map its answers to hook responses. A *managed* project is a tracked one with at least one user-approved check.

- `UserPromptSubmit` calls the runtime's `prompt` (which creates project state on first use), `current` and, with an open session, `decide`, and injects context: the captured prompt ID, a pending check proposal's argv with its `approve check CODE` phrase, and either the active session's phase, structured decision (`PROCEED`, `REVIEW_CONTRACT`, `ASK_HUMAN`, ...) and checkpoint, or the no-contract guidance. That guidance says a managed project starts a contract automatically on the first protected action, and tells an unmanaged project's agent that nothing can be verified until it proposes a check with `propose-check`.
- `PreToolUse` (`Edit|Write|MultiEdit|NotebookEdit|Bash`; read tools never reach the hook) first applies spawn-free guards: edits to `.optimizer/` outside the root's `drafts/` or into the per-user store, and Bash commands that touch runtime state or the hook, invoke `optimizer`/`cli.ts` with a hook-only subcommand (`enable`, `disable`, `prompt`, `start-from-prompt`, `blocked`, `run`) under any wrapper or spelling, or build such a command at runtime, are denied in every folder (`propose-check`, repository paths and `prompt.txt` pass; see `src/bash-guard.ts`). Edits outside the project root pass. In a managed project, or while a session pointer is active, it then calls `gate` with the tool input. The gate classifies the call (file edits and any Bash command not on its read-only allowlist are protected) and allows it only when the decision is `PROCEED`, `RUN_VERIFICATION` or `COMPLETE`. A protected action in a managed project with no open session makes the runtime start a contract from the latest captured user prompt (R1 = the prompt verbatim, accepted when every approved check passes); the hook denies that action with the controller's next checkpoint, so the agent never has to call `start` itself. Unmanaged projects with no session never spawn the runtime.
- `Stop` (only with an active session pointer) calls `current` and `decide`. It allows the stop when there is no session or the decision is `COMPLETE`, reports `ASK_HUMAN` as waiting on the user, and otherwise blocks while the task is unverified (loop guard in `.optimizer/hook-state.json`: at most three consecutive blocks, never twice on unchanged state). When that budget is exhausted it calls `blocked`, which records phase `blocked`, and says the task is blocked and unverified, never complete. A recorded block stays until a checkpoint command moves the session on; Stop then reports it instead of looping.
- `SubagentStart` gives a subagent the active session's phase, decision and summary.

**Failures.** Every runtime call has a 15 s deadline and installed entries set Claude Code's hook `timeout` to 60 s. If the runtime cannot be spawned, times out or fails while a session pointer is active, `PreToolUse` denies Edit/Write/MultiEdit/NotebookEdit and every Bash command with an `optimizer unavailable` reason (the hook does not classify Bash itself), while Read, Grep and Glob keep working. Outside a managed task, and for every other event, internal errors fail open with one stderr line.

**Limitations.** Enforcement exists only while the hooks are installed and the agent runs under them: an agent started with hooks uninstalled, `OPTIMIZER_DISABLED=1` or another settings file is not gated. The Bash allowlist cannot see writes made inside an allowlisted program, such as the approved check command or a script it runs. Checkpoints happen at tool boundaries, so the host is never truly paused; a denied agent keeps its turn and may end it. A same-user process can still read the per-user record, call the runtime directly or edit state outside the hooks; the string-matching Bash guard is best effort and a variable, alias or script file gets around it.

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
