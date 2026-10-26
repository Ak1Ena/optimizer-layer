# Optimizer Layer

A local optimization and coordination layer for existing coding agents. Its goal is to reduce the total work needed to reach a verified user outcome: execution, context retrieval, retries, verification, human coordination, and the optimizer's own overhead.

The working agent implements the task. Optimizer Layer maintains the goal contract, retrieves evidence, coordinates decisions, observes registered checks, and verifies completion. The user retains authority over requirements and consequential choices.

The current prototype delivers a bounded goal-to-verification cycle. Improved efficiency remains a research hypothesis; the recorded demonstration does not establish a speed, token, or quality advantage.

## How it works

1. **Define the goal.** Extract requirements, acceptance criteria, and unresolved questions from an explicitly selected request.
2. **Retrieve evidence.** Find relevant project files and explicitly imported prior user decisions, retaining source references and freshness checks.
3. **Review the contract.** Resolve consequential uncertainty, assess context sufficiency, and let the working agent accept or challenge the goal contract.
4. **Execute and observe.** The agent performs the authorized task. The runtime executes registered checks and records their actual outcomes.
5. **Reconsider when justified.** Repeated check failures request a cooperative pause. The agent explains whether to retain or revise its strategy.
6. **Verify the outcome.** Completion requires current passing evidence for every requirement and registered check. An agent's completion claim is recorded separately.

## Architecture

The project is a TypeScript ESM workspace on Node.js 24.18.x. SQLite stores project-bound events and reconstructable session state; Zod validates external inputs. Core behavior runs locally without a model API key.

| Package | Responsibility |
| --- | --- |
| [Runtime](packages/runtime/README.md) | Goal/context intelligence, contract review, decision policies, persistence, subprocess checks, verification, public API, and `optimizer` CLI. |
| [Agent adapter](packages/adapter/README.md) | Thin CLI transport and an installable checkpoint skill for a working coding agent. |
| [MCP](packages/mcp/README.md) | Optional read-only session status and event views through the official MCP SDK. |

The runtime owns state and policy. Adapters and MCP use its public interfaces. Each project stores its private runtime database at `.optimizer/runtime.sqlite`.

## Current capabilities

Implemented: structured goal extraction, versioned contract review and challenge, bounded lexical context retrieval, provenance-aware decision import, context sufficiency assessment, durable event replay, cooperative reconsideration, and independent registered-command verification.

The shipped integrations are explicit skill/CLI checkpoints and opt-in Claude Code hooks (below). The runtime can gate its own checks. The hooks deny file-edit tools and block ending a turn according to the runtime's next action; they are tested with real hook JSON on stdin, not yet in a live Claude Code session. Bash file edits are not intercepted, and Codex hooks are not implemented.

Broader natural-language interpretation through a replaceable model provider, richer code relationships, native conversation import, and repeated comparative evaluation remain future work. The current goal syntax and limits are documented below.

## Repository layout

```text
CONTEXT.md                    Project vision and confirmed architecture decisions
packages/runtime/             Runtime API, CLI, policy, storage, and tests
packages/adapter/             Checkpoint transport, installable skill, and tests
packages/mcp/                 Optional read-only MCP server and tests
examples/vertical-slice/      Coding fixture, goal, and independent acceptance runner
scripts/                     Packaging and demonstration tools
docs/superpowers/             Designs and implementation plans
docs/runs/                    Implementation ledger and recorded evidence
handoff.md                    Current state and continuation notes
```

## Setup and checks

Use Node.js 24.18.0 (`nvm use` reads `.nvmrc`). Then:

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
node packages/runtime/src/cli.ts --help
```

Tests use real files, SQLite, subprocesses, and the official MCP client/server. `lint` uses TypeScript's unused-code, fallthrough, return-path, unreachable-code, and unused-label checks. Build emits compiled modules and installable package directories under `dist/npm/{runtime,adapter,mcp}`.

A clean registry-backed `npm ci` followed by tests and build passed on 2026-10-26. `npm run build` removes previous generated output first, so deleted or renamed modules leave no stale files.

To create local installable tarballs after building:

```sh
npm pack ./dist/npm/runtime
npm pack ./dist/npm/adapter
npm pack ./dist/npm/mcp
```

The runtime package exposes `optimizer`; the optional MCP package exposes `optimizer-mcp`. Pack the staged `dist/npm` directories so installed packages use compiled JavaScript. See the package READMEs for embedding the runtime, configuring the adapter, and running MCP.

## Goal contract

Write a goal file using this deliberately small dialect:

```text
- R1: parseCount accepts nonnegative integer counts.
Acceptance R1: Valid decimal digit strings preserve their numeric value.
- R2: parseCount handles invalid input according to the confirmed policy.
Acceptance R2: Invalid values match the prior user decision.
Question human Q1: What is the invalid-input policy?
Question local Q2: Which module implements parseCount?
```

Plain prose is retained as a requirement and triggers a critical missing-acceptance question. Unsupported semantics are not guessed. Critical human questions need actual user decisions; local questions need current source evidence. Context scores alone do not grant permission to proceed. The working agent must cite sources and explain sufficiency.

Register independent checks in a separate operator-selected JSON file:

```json
[
  {
    "id": "acceptance",
    "requirementIds": ["R1", "R2"],
    "argv": ["node", "/trusted/acceptance.mjs", "/absolute/project"],
    "timeoutMs": 5000
  }
]
```

These trusted commands run without a shell but with the caller's privileges. Retrieved code, goal text, and transcripts cannot register commands. Every requirement needs checks; every registered check must have current passing evidence before completion.

## Coding-agent workflow

During development replace `optimizer` below with `node packages/runtime/src/cli.ts`. After building, use `node packages/runtime/dist/cli.js` or an installed package's `optimizer` binary. All paths are explicit.

```sh
optimizer start --project /absolute/project --request /trusted/goal.md --checks /trusted/checks.json
optimizer history --project /absolute/project --session SESSION --file /trusted/conversation.jsonl
optimizer retrieve --project /absolute/project --session SESSION
optimizer resolve --project /absolute/project --session SESSION --question Q1 --source prior-user:decision:1
optimizer resolve --project /absolute/project --session SESSION --question Q2 --source CONTEXT_ITEM_ID --answer 'parseCount.mjs exports the parser'
optimizer assess --project /absolute/project --session SESSION --kind sufficient --items ITEM_ID,ITEM_ID --rationale 'Explain how the cited sources resolve the next decision.'
optimizer next --project /absolute/project --session SESSION
optimizer status --project /absolute/project --session SESSION
optimizer review --project /absolute/project --session SESSION --kind accept --version VERSION --items ITEM_ID,ITEM_ID --rationale 'Explain why the contract preserves the requested requirements and acceptance.'
optimizer check --project /absolute/project --session SESSION --check acceptance
```

Use the returned state to select actual current item IDs and the latest `state.goal.version` for VERSION. `next` routes to local retrieval, human clarification/escalation, agent contract review/work/reconsideration, local verification, or completion. When a source edit invalidates context, retrieve and assess again. Unresolved questions, pending review, and pauses prevent registered checks from executing.

Contract acceptance is explicit and cites context covering every requirement. Challenge a technical contradiction or consequential missing decision with:

```sh
optimizer review --project /absolute/project --session SESSION --kind challenge --version VERSION --items ITEM_ID --requirement R1 --owner local --rationale 'Describe the requirement concern supported by this evidence.'
```

Use `--owner human` for user-owned decisions. Each challenge creates a critical `review:N` question; resolve it through the same cited local-answer or imported user-decision flow. The runtime preserves requirement statements and registered checks. A response for a stale version, missing citation, or unresolved challenge is rejected. Imported authority, resolved answers, and new challenges advance the contract version and require fresh acceptance. Source edits alone require fresh context; if they reopen a cited local answer, resolve it and review the updated contract. Two challenges are allowed before another challenge escalates to the human. This bound is a prototype policy, not an evaluated optimum.

Existing event logs without review data reopen with pending review. Earlier completion evidence and completion claims cannot bypass this checkpoint.

Three matching failed check outcomes request Pause. The working agent reviews evidence and may retain its strategy with justification:

```sh
optimizer reconsider --project /absolute/project --session SESSION --strategy retain --rationale 'Explain why the plan still holds and what the evidence changes.'
optimizer claim --project /absolute/project --session SESSION
optimizer verify --project /absolute/project --session SESSION
optimizer metrics --project /absolute/project --session SESSION
```

Two reconsideration rounds are allowed; persistent failure then escalates to the human. `claim` never proves success. Verification detects stale source/check evidence and source mutations during a check. Independent verifier file hashes are pinned at registration. Helpers outside argv should be explicitly registered as artifacts. This does not defend against a malicious process with the same OS account modifying the optimizer itself.

Install the adapter's [checkpoint skill](packages/adapter/skill/optimizer-checkpoint/SKILL.md) in the coding agent's skill directory using its normal local installation mechanism. Installation is explicit; the runtime does not rewrite host configuration. See [adapter documentation](packages/adapter/README.md). For Claude Code, the opt-in hooks below replace typing these checkpoints by hand.

## Claude Code hooks

The adapter's `optimizer-claude-hook` lets you chat in plain language while the runtime keeps the agent on a goal contract. One-time machine setup (writes `settings.json.optimizer-backup` first, idempotent, preserves other settings and hooks):

```sh
optimizer-claude-hook install                        # merges into ~/.claude/settings.json
optimizer-claude-hook install --settings /path/settings.json
optimizer-claude-hook uninstall                      # removes only its own entries
```

The installer pins the current Node.js executable and the runtime executable (`OPTIMIZER_BIN`, else `optimizer` on `PATH`) into the hook command. Hooks do nothing until a project is enabled. You run this yourself, which is your approval of the check commands:

```sh
optimizer enable --project . --check 'npm test' [--check 'node test/acceptance.mjs'] [--timeout-ms 30000]
optimizer disable --project .                        # keeps history
```

Check commands are split into argv without a shell; the shell metacharacters ``| ; & $ > < ` `` are rejected, and the executable is resolved to an absolute path at enable time. Without `--check`, a `package.json` test script is proposed and needs `--yes`. Each project check covers every requirement of every task.

Then chat normally. On each prompt the hook captures your message into `.optimizer/prompts.jsonl` and injects the current contract state. With no open contract, Claude drafts one under `.optimizer/drafts/`, shows it, and runs `optimizer start --project P --request DRAFT` after you approve (`--replace` supersedes an unfinished session). Edit tools are denied while there is no contract or while the action is clarify, review, retrieve, reconsider, or escalate. Stop is blocked while a started task is unverified, at most three consecutive times and never twice for unchanged state. A captured prompt can answer a human question with `optimizer resolve --question Q1 --source prompt:ID`; only rows written by the hook's `prompt` capture, which needs the per-project hook token, carry that authority. A same-user agent could still read the token and call the runtime directly; the Bash matcher denies commands that mention `optimizer` or `cli.ts` together with the words `enable`, `disable` or `prompt`, and commands that mention `.optimizer` outside `.optimizer/drafts/`. This is a string match and best-effort only: an agent can still get around it, for example with a variable, an alias, or a script file, and the Read tool is not intercepted. Enabled projects reject `start --checks`; checks come only from `optimizer enable`. Hook infrastructure failures fail open with a one-line stderr diagnostic.

## Previous conversation decisions

Explicitly import normalized JSONL from the selected harness conversation:

```json
{"id":"prior-user","projectRoot":"/absolute/project","role":"user","content":"Decision: Invalid counts must throw RangeError.","timestamp":"2026-10-25T12:00:00Z"}
```

Only user-authored `Decision:` lines gain user-decision provenance. Assistant suggestions remain untrusted and are ignored as decisions. Extracted IDs are `ROW_ID:decision:1`, with incrementing suffixes for multiple decisions. Optional `supersedes` lists replace earlier row or decision IDs. Transcript path, line, timestamp, role, and digest are retained and rechecked. Changed/superseded sources reopen affected questions. Import is an explicit operator action, not an identity-authentication mechanism. Automatic native transcript conversion is outside this slice.

## Optional MCP

`optimizer-mcp --project /absolute/project` opens an initialized runtime read-only. The official SDK serves only `optimizer_session_status` and `optimizer_session_events`. Tool arguments cannot select another filesystem root or submit SQL. Responses contain status counts and event metadata; private code/output/rationale is omitted. See [MCP documentation](packages/mcp/README.md).

## Demonstration and limits

```sh
npm run demo:prepare -- /absolute/new/demo-directory
```

This prepares matched baseline/optimized fixtures and a pinned external acceptance runner. An actual coding agent follows the checkpoint skill on the optimized fixture; an independent agent repairs the baseline without optimizer guidance. The preparation script does not pretend to implement the agent. Both runs receive three controlled pre-repair failures to exercise recovery. `npm run demo:report -- /absolute/demo-directory` independently checks final artifacts and records results.

The goal is a working restricted-domain optimizer, not arbitrary natural-language interpretation. Retrieval uses bounded lexical/source-name matches plus explicit agent assessment; there is no semantic search model. Decisions are imported explicitly. Three failures are a demonstrator threshold, not an evaluated optimum. No quality or efficiency advantage has been established by a single fixture comparison. Saved demonstration reports describe the earlier implementation; new or resumed demonstrations must also pass contract review before reporting completion.

## Design and evidence

- [Project context](CONTEXT.md): vision, authority boundaries, components, milestones, and research hypotheses.
- [Binding vertical-slice design](docs/superpowers/specs/2026-10-26-complete-optimizer-design.md) and [implementation plan](docs/superpowers/plans/2026-10-26-vertical-slice.md).
- [Contract review design](docs/superpowers/specs/2026-10-26-contract-review-design.md) and [implementation plan](docs/superpowers/plans/2026-10-26-contract-review.md).
- [Implementation and verification ledger](docs/runs/2026-10-26-implementation.md).
- Historical [coding-agent demonstration](docs/runs/2026-10-26-vertical-slice-results.json) and [packaging evidence](docs/runs/2026-10-26-packaging-results.json).
- [Handoff](handoff.md): delivered scope, remaining limits, and continuation priorities.
