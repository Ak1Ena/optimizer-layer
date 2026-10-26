# Claude Code hook integration

Date: 2026-10-26. Status: approved by user (choices below). Extends the binding complete-optimizer design; does not replace the runtime, CLI, adapter transport, or MCP.

## Goal

The user works in Claude Code in plain language. No skill invocation, no optimizer commands typed per task. Like headroom/rtk, the optimizer attaches through Claude Code hooks: it records the user's prompts, injects the current goal state and next action into the agent's context on every prompt, blocks edits when the contract says the agent must not proceed, and refuses to let the turn end while a started task is unverified.

## User decisions

1. **Activation: per-project opt-in.** Hooks are installed globally once, but do nothing (exit 0, no output, no DB open) unless the project has been enabled.
2. **Natural language: the working agent drafts the goal.** No model call in the runtime. The hook injects instructions; Claude drafts the goal dialect from the user's words, shows it, and starts the session only after the user approves in chat.
3. **Strictness: block.** PreToolUse denies file edits while the contract forbids them; Stop blocks ending the turn while a task is unverified.
4. **Checks: approved once per project** by the user at enable time, reused by every task in that project.

## User experience

One-time machine setup:

```sh
optimizer hooks install        # merges hook entries into ~/.claude/settings.json (backup written, idempotent)
```

One-time project setup, run by the user (`! optimizer enable ...` from Claude Code also works; typing it is the approval):

```sh
optimizer enable --project . --check 'npm test'
```

Then the user simply chats: "parseCount should stop turning garbage into 0 ...". Claude drafts the contract, asks open human questions, user says "yes, throw RangeError", Claude starts the session and works; hooks keep it on the contract until `complete`.

`optimizer disable --project .` turns it off (keeps history). `optimizer hooks uninstall` removes only the entries it added.

## Components

### Runtime (owns all state and policy)

New CLI commands, all JSON in/out like the existing ones:

- `enable --project P --check CMD [--check CMD ...] [--timeout-ms N]`: Writes project config in the runtime store (or `.optimizer/project.json`, mode 0600). `CMD` is split into argv **without a shell** by a simple whitespace/quote tokenizer; reject shell metacharacters (`|;&$><\``) with a clear error rather than interpreting them. argv[0] resolved to an absolute path via PATH at enable time and stored absolute. Each project check covers all requirements of any task (`requirementIds: "*"` semantics resolved at `start`). Verifier artifacts pinned as today (`registerArtifacts`). Re-running `enable` replaces config. If `--check` omitted and `package.json` has `scripts.test`, print the proposed command and require `--yes` to accept; never auto-accept.
- `disable --project P`: marks disabled.
- `prompt --project P --file F`: Appends one captured user prompt (from the hook) to the runtime-owned prompt log `.optimizer/prompts.jsonl` with row `{id, projectRoot, role: "user", content, timestamp, capturedBy: "hook"}`. Content verbatim, size-bounded (reuse transcript limits).
- `start` changes: `--checks` becomes optional when the project is enabled; project checks are expanded so `requirementIds` = every requirement ID in the extracted goal. Starting sets the project's **active session** pointer. Starting while another active session is not `complete` requires `--replace` (records an event on the old session; does not delete it).
- `current --project P`: returns `{enabled, sessionId|null, action|null, summary}` where summary is a compact, bounded (≤ 2,000 chars) text of goal version, requirement IDs + acceptance, open questions, review state, control state, last check outcome. This is what hooks inject.
- Human decisions from captured prompts: `resolve --question Q --source prompt:<rowId>` resolves a human question from a **hook-captured** user prompt as a whole message (no `Decision:` prefix needed). Only rows in the runtime-owned prompt log with `capturedBy: "hook"` and `role: "user"` qualify; agent-written files never do. Freshness: the row must still exist with the same digest. The existing `Decision:` JSONL import path is unchanged.

Keep `importConversation` semantics for external transcripts untouched. Implement captured-prompt decisions as a separate small function reusing its row parsing and digest logic.

### Adapter: `optimizer-claude-hook` (thin; no policy)

New bin in `packages/adapter`, `src/claude-hook.ts`. Reads hook JSON from stdin, uses `runOptimizer` (absolute executable from `OPTIMIZER_BIN` env or sibling `optimizer` resolved at install time) to talk to the runtime, writes hook JSON to stdout. Must never crash Claude Code: any internal error yields exit 0 with no output (fail open) plus a one-line stderr diagnostic, **except** where noted. Must be fast when the project is not enabled: check for `.optimizer/` + enabled flag by file existence before spawning the runtime.

Project root = hook `cwd` resolved up to the nearest directory containing `.optimizer/` (stop at filesystem root / home).

Events:

1. **UserPromptSubmit** (enabled projects only):
   - Write prompt to a temp file, call `prompt` to capture it. Capture returns the row ID.
   - Call `current`. Emit `additionalContext` (facts, not imperatives, per Claude Code guidance; ≤ 8,000 chars):
     - Always: captured prompt ID (`prompt:<id>`), so the agent can cite it as a human decision source.
     - No active session, or active session complete: the goal dialect reference, the rule that a code-change request needs a drafted contract shown to the user and explicit approval before `optimizer start --project P --request DRAFT` (draft under `.optimizer/drafts/`), and that questions/explanations that change no files need no session.
     - Active session: the `current` summary and next action with the matching checkpoint instruction (condensed from `optimizer-checkpoint` SKILL.md), plus: if this prompt answers an open human question, resolve it with `--source prompt:<id>`.
2. **PreToolUse**, matcher `Edit|Write|MultiEdit|NotebookEdit`:
   - Target file outside project root or inside `.optimizer/drafts/`: no decision.
   - No active session (enabled project): **deny** with reason "No approved goal contract; draft it and get user approval first."
   - Active session action in `clarify | review | retrieve | reconsider | escalate`: **deny** with the action reason.
   - `execute | verify | complete`: no decision.
   - Bash is not intercepted (documented cooperative gap; shell edits are caught later by source-digest staleness and verification).
3. **Stop**:
   - No active session, or action `complete`: allow.
   - Action `clarify` with human route, or `escalate`: allow (waiting on the user is legitimate); add `systemMessage` naming the open question.
   - Otherwise **block** with reason = next action + instruction. Loop guard: if `stop_hook_active` is true and the action and its evidence are unchanged since the last block (track a small `.optimizer/hook-state.json` per Claude `session_id`), allow and emit `systemMessage` "optimizer: task unverified, stopping" so it never loops forever. Max 3 consecutive blocks per Claude session.

### Installer: `optimizer hooks install|uninstall`

Runtime CLI command (the runtime package ships the adapter? No: keep it in the adapter package as `optimizer-claude-hook install|uninstall`, documented as `optimizer-claude-hook install`). Merges into `~/.claude/settings.json` (or `--settings PATH` for tests): adds the three hook entries pointing to the absolute `process.execPath` + hook script path (so Node 24 is pinned; this also fixes the v20 `node` shebang problem). Writes `settings.json.optimizer-backup` first. Idempotent: entries tagged by command path; re-install replaces them; uninstall removes only them. Preserve all other keys and hooks byte-for-byte semantically (JSON round-trip OK).

## Trust boundaries (unchanged in spirit)

- Check commands come only from `enable`, which the user runs. Goal text, prompts, drafts and retrieved code never register commands.
- Human authority comes only from hook-captured user prompts or explicitly imported user transcripts. The agent cannot write to the prompt log through any CLI path except `prompt`, which the hook calls; document that a same-user agent could call `prompt` itself via Bash. Mitigation: the hook PreToolUse also matches `Bash` and denies commands that mention the optimizer (or `cli.ts`) together with the words `enable`, `disable` or `prompt`, plus commands touching `.optimizer` outside `.optimizer/drafts/` (string match, documented as best-effort). `prompt` requires an env token `OPTIMIZER_HOOK_TOKEN`: a per-project random token created by `enable` and stored in `.optimizer/project.json` (0600), which the hook reads and passes to the runtime child; it is never put into agent-visible context. (An installer-written token cannot work: the installer runs once per machine and cannot reach each project's config.) Enabled projects reject `start --checks`; checks come only from `enable`.
- Fail open on hook infrastructure errors (never brick Claude Code), fail closed on policy decisions the runtime actually returned.

## Out of scope

- Model calls in the runtime; semantic goal parsing.
- Intercepting Bash file edits.
- MCP changes (existing read-only MCP stays optional).
- Codex hooks.

## Verification

- Runtime unit tests: enable/disable/config validation (metacharacter rejection, `--yes` requirement, absolute argv), prompt capture and token check, `prompt:<id>` human resolution incl. staleness and rejection of non-hook rows, `start` with project checks and `--replace`, `current` summary bounds.
- Adapter tests: feed real hook stdin JSON to the bin for each event and each action branch; assert exact stdout JSON / silence; disabled-project fast path does not create `.optimizer/`; Stop loop guard; installer merge/idempotence/uninstall on a temp settings file preserving unrelated hooks.
- End-to-end: real Claude Code in tmux on a fresh fixture copy with hooks installed via a temp `--settings` file is NOT possible (Claude reads ~/.claude/settings.json); main thread runs that trial after install.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass.
