# Always-on mode and local dashboard

Date: 2026-10-26. Status: approved by user. Amends [Claude Code hook integration](2026-10-26-claude-hooks-design.md); everything not changed here stays as specified there.

## Goal

Work like headroom: install once, then the optimizer is present in every Claude Code session without per-project setup. A local dashboard shows what it is doing.

## Install modes

Amended later on 2026-10-26: public installs are opt-in by default, and always-on is an explicit choice. Everything below describes always-on mode unless it says otherwise.

- `optimizer-claude-hook install` installs opt-in hooks; `install --always-on` installs always-on hooks. The mode is pinned in the hook command as `OPTIMIZER_MODE='opt-in'` or `'always-on'`, so the hook needs no extra file. Re-running `install` without `--always-on` switches back to opt-in.
- Opt-in: a folder is handled only when its per-user record carries `optedIn: true`, which only the user's `optimizer enable --project P` sets (a record created by always-on capture does not count). Elsewhere `UserPromptSubmit`, `PreToolUse`, `Stop` and `SubagentStart` are silent and create nothing (no `.optimizer/`, no capture, no record, no registry entry, no git exclude) and never spawn the runtime; only the spawn-free `PreToolUse` guards (Bash guard, per-user store and `.optimizer/` edits) still apply, so the agent cannot enable a folder itself.
- `enable` works without `--check` and without a `package.json` test script: it turns the project on with its current checks (none at first) and creates `.optimizer/` so subfolder sessions resolve to it; the agent then uses `propose-check` and the user approves by code. `enable --check` and `--yes` behave as before.
- `ensure` reinstalls in the mode the existing entries record. An existing entry without a marker predates modes and behaved always-on, so it is repaired as always-on; with no entries at all `ensure` installs opt-in.

## User decisions

1. **Always on, every project.** No `optimizer enable` step is required. `optimizer disable --project P` remains as a per-project opt-out; `OPTIMIZER_DISABLED=1` in the environment turns all hooks into no-ops.
2. **Any folder is a project.** Project root = the nearest ancestor of the hook `cwd` that already has `.optimizer/`, else the `cwd` itself. Exception: never use the filesystem root or a path inside `.optimizer/` itself. Home directory is allowed. When the project is inside a git work tree, add `.optimizer/` to that repo's `.git/info/exclude` (once, idempotent) so state never shows up in `git status`. Never edit tracked `.gitignore` files.
3. **Block only after a task starts.** With no active (unfinished) session: PreToolUse makes no decision (edits go through) and Stop allows. UserPromptSubmit still injects the facts: no contract exists; for a code-change request the agent should draft one, show it, and start after approval. With an active unfinished session: blocking exactly as in the hooks spec (edits gated by action, Stop blocked until verified, loop guard).
4. **Check approval by code typed by the user.**
   - `optimizer propose-check --project P --check CMD [--check CMD ...] [--timeout-ms N]`: Callable by the agent. Same argv splitting, metacharacter rejection and absolute argv[0] resolution as `enable`. Stores a **pending** proposal with a random 4-hex-char code (crypto random) in project config; replaces any earlier pending proposal. Returns the code and argv.
   - The UserPromptSubmit hook, whenever a pending proposal exists, injects: the exact argv, and that the user approves by replying with `approve check <code>`.
   - When `prompt` captures a user prompt (hook path, token-checked) containing `approve check <code>` (case-insensitive, whole words) matching the pending proposal, the runtime activates those checks as the project checks (replacing old ones, artifacts pinned) and clears the proposal. The capture result reports `checkApproved: true` so the hook can mention it in the injected context. No other path activates proposed checks.
   - `enable --check` still works for users who prefer the CLI; it activates directly.
   - `start` on a project without active checks fails with a clear error naming `propose-check`.
   - Bash guard: `propose-check` must stay allowed for the agent (it is the intended path), while `enable`, `disable`, `prompt` stay denied. Make sure the word-match for `prompt` does not deny `propose-check`... (it does not contain the word `prompt`, but test it).

## Changes to existing behaviour

- Hook fast path: previously "no enabled config, exit silently". Now: if `OPTIMIZER_DISABLED=1` or the project is disabled, exit silently. Otherwise proceed. Keep the hook cheap for the common case: UserPromptSubmit spawns the runtime (capture + current); PreToolUse and Stop must not spawn the runtime when there is no active session pointer file. Read the active-session pointer and disabled flag directly from files before spawning.
- The runtime creates `.optimizer/` (runtime data only) and the project's per-user record lazily on first `prompt` capture; the per-project hook token is created in the per-user record at that moment if absent (not only at `enable`). See Trust anchor. Mode 0700 dir / 0600 files as today.
- Project registry for the dashboard: whenever the runtime creates a project's `.optimizer/`, it records the canonical project root in `~/.config/optimizer-layer/projects.json` (respect `XDG_CONFIG_HOME`; 0600; atomic write; dedupe; tolerate a corrupt file by rebuilding from scratch). Do not use `~/.optimizer` for global state, because the home directory can itself be a project.
- Installer: unchanged command, but add a `SessionStart` hook entry (matcher `startup|resume`) running `optimizer-claude-hook ensure`, which re-installs/repairs the other entries if they are missing or point to a moved path, like headroom's `init hook ensure`. `ensure` must be fast and silent when everything is in place, and must never fail the session (exit 0).
- Docs: README quick start loses the mandatory `enable` step; describe first-use check approval, opt-out, `OPTIMIZER_DISABLED`, and the dashboard.

## Trust anchor (security review amendment)

`.optimizer/` sits inside the project, so a cloned repository can commit any file there. Always-on mode means nobody runs `enable` before the hooks act, so nothing in the project may carry trust.

- Per-project secrets and approvals live in the per-user store: `$XDG_CONFIG_HOME/optimizer-layer/projects/<sha256(canonical root)>.json` (default `~/.config/...`, 0600, atomic writes). It holds the canonical root (checked on read), hook token, approved checks (argv, timeouts, pinned artifacts), disabled flag, pending proposal and code, and active session pointer.
- In-repo `.optimizer/` keeps only runtime data: `runtime.sqlite`, `prompts.jsonl`, `drafts/`, `hook-state.json`. A `.optimizer/project.json` in the project is ignored.
- Each captured prompt row carries `mac` = HMAC-SHA256(per-user token, row fields). Only rows with a valid `mac` count as human decisions, so committed rows never do. The token is created in the per-user store before the first row is written.
- `start` re-validates stored check argv with the `enable` rules (no shell metacharacters, absolute executable argv[0]). `check` runs only when the session check's argv and timeout match a currently approved project check, because the runtime database could also come from a committed file.
- Hook fast paths read the per-user record, not the project. Without an active session pointer, they still never spawn the runtime. Edit/Write into the per-user store is denied, and the Bash guard also denies `optimizer-layer/projects`.
- When a per-user record exists and the project is opted out, `check` refuses to run. Folders with no record (plain CLI with explicit `--checks`) keep the old behaviour, which is documented as trusted-directory only.
- Writes into `.optimizer/` never follow symlinks: hook-state uses `O_NOFOLLOW`, the prompt log already did, and the SQLite database and its `-wal`/`-shm`/`-journal` files are refused when they are symlinks.
- A session that reaches verified `complete` clears the active-session pointer.
- Remaining limit: a process running as the same user can read or change the per-user store. The agent guards are best-effort.

## Dashboard

`optimizer dashboard [--port N]` starts a local read-only web page.

- `node:http`, no dependencies, no build step; one HTML page with inline CSS/JS plus a JSON endpoint. Bind `127.0.0.1` only. Default port 8790 (headroom uses 8787); `--port 0` picks a free one. Print the URL.
- Security: generate a random token at start; the URL is `http://127.0.0.1:PORT/?token=...`; every request needs the token and a `Host` header of `127.0.0.1:PORT` or `localhost:PORT` (DNS-rebinding guard). Read-only: open every project runtime with `readOnly: true`; no endpoint mutates anything.
- Content, for each registered project that still exists:
  - project path, enabled/disabled, approved checks (argv), pending check proposal (argv only; never show the code), active session id;
  - sessions, newest first: goal version, requirements with acceptance, open questions, review state, current next action, control state (running/paused/escalated + reason), check runs (outcome, duration, time), completion, and timing from `measurements` (optimizer time vs external time).
  - Never render captured prompt text, check stdout/stderr, or the hook token. Requirement and acceptance text are shown (the user wrote them), escaped as text, never as HTML.
- Auto-refresh every 5 s via the JSON endpoint. Works in light and dark mode. Plain, readable layout; no external assets.
- The runtime needs a way to list a project's sessions; add a small read-only method if none exists.

## Verification

- Trust tests: a project with a crafted `.optimizer/project.json` (checks + token) and pre-seeded `prompts.jsonl` gets no approved checks, `start` fails naming `propose-check`, seeded rows are rejected as human decisions, and the hook does not treat it as having checks or being disabled; `start` rejects stored argv that breaks the `enable` rules.
- Runtime tests: propose-check validation, code approval only via token-checked capture with matching code, wrong code / no code / agent-run `enable`-less flows rejected, proposal replacement, `start` without checks error, lazy init + token creation, registry write/dedupe/corrupt recovery, `.git/info/exclude` idempotence and no-git case, session listing.
- Adapter tests: no-session PreToolUse/Stop silent and without spawning the runtime; active-session blocking unchanged; `OPTIMIZER_DISABLED` and disabled project silent; injected context shows pending proposal argv and approval phrase; `ensure` repairs a missing entry and is silent when intact; Bash guard allows `propose-check`.
- Dashboard tests: starts on port 0, rejects missing/wrong token and foreign Host header, serves JSON for a seeded project, escapes HTML in requirement text, never includes prompt text or token.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` pass.
