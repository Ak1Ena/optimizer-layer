# Optimizer Layer handoff

Updated 2026-10-26. Workspace: `/Users/m129/code/optimizer-layer`.

## Goal and user direction

Build a **standalone local optimization runtime + thin, installable agent plugins/adapters + optional MCP tools**.

The user rejected an observation-only first milestone. The first delivery must exercise the complete cycle:

**Understand Goal → Retrieve Context → Resolve Critical Uncertainty → Execute → Observe → Reconsider if Needed → Verify Goal.**

Keep minimal but real Goal Intelligence, Context Intelligence, Context Sufficiency Gate, Runtime Observer/Decision Engine, Adaptive Strategy Evaluation, and Goal Verification together. Preserve **Pause → Reconsider → Resolve**. The optimizer may request reconsideration; it cannot force an alternative plan or silently change the user's goal.

Prefer deterministic local algorithms, working integrations, independent verification, and measured overhead. Do not claim efficiency improvements without credible comparative evidence. The latest user instruction also stresses avoiding smelly code: focused modules, simple control flow, no placeholders or speculative abstractions.

The user authorized implementation and reversible engineering decisions without another design approval round. Ask for consequential user-dependent choices. Push, PR creation, deployment, messages, and data deletion still require explicit approval. Replies use concise professional English with the caveman skill at lite level.

## Current state

The contract-review follow-up is implemented from CONTEXT.md v0.5 sections 5 and 19. `Runtime.review` and CLI/adapter `review` explicitly accept or challenge the current `goal.version` before checks or completion. Challenges cite requirement evidence, become critical local/human questions, and preserve original requirements and operator-selected checks. Two challenges are allowed; a further challenge escalates with its submitted evidence retained in the event log. Imported authority, resolved answers, and challenges advance the version and invalidate acceptance. Source edits can reopen cited local answers, requiring resolution and a fresh review. Old sessions default to pending review.

The current follow-up design and plan are [contract review design](docs/superpowers/specs/2026-10-26-contract-review-design.md) and [implementation plan](docs/superpowers/plans/2026-10-26-contract-review.md). Follow-up validation: 58/58 tests, strict typecheck, compiler lint, build, and a compiled-runtime review-to-verification smoke check passed. A fresh review found no remaining concrete blocker. The expanded root README covers the project and its current workflow. The saved coding-agent and packaging reports below predate this gate; they remain historical evidence and were not rewritten to imply they exercised review.

A functional restricted-domain vertical slice is implemented. It was exercised through an actual coding-agent workflow using the installable cooperative checkpoint adapter. A separate actual agent completed the baseline task without optimizer guidance. Both artifacts passed the same independent acceptance runner.

The implementation is local and reviewed. Nothing was published, pushed, deployed, or installed into the user's agent configuration.

**Git initialized on `main` (2026-10-26).** No commits yet unless the log shows otherwise.

The previous turn was interrupted during the last installed-package smoke check. That process was subsequently collected successfully with exit code 0. It verified the current compiled runtime, the `artifactFiles` API, installed adapter calls, and installed MCP handshake/status/events. Its durable report exists below.

## Where to read first

- [AGENTS.md](AGENTS.md) contains current development commands and working rules.
- [CONTEXT.md](CONTEXT.md) contains project vision and updated architecture version 0.5.
- [Binding vertical-slice design](docs/superpowers/specs/2026-10-26-complete-optimizer-design.md) supersedes the older observation-only delivery target.
- [Implementation plan](docs/superpowers/plans/2026-10-26-vertical-slice.md) and [implementation ledger](docs/runs/2026-10-26-implementation.md) track the delivered work.
- [README.md](README.md) documents setup, goal syntax, trust boundaries, workflow, and limitations.
- [Coding-agent evidence report](docs/runs/2026-10-26-vertical-slice-results.json) records the actual demonstration and baseline.
- [Packaging evidence report](docs/runs/2026-10-26-packaging-results.json) records clean offline installation and installed-component checks.

The older [runtime foundation design](docs/superpowers/specs/2026-10-26-local-runtime-design.md) is retained as historical architecture background and explicitly marked superseded. Do not use its deferred-intelligence scope as the implementation target.

## Implemented ownership

| Area | Files and behavior |
|---|---|
| Public runtime | `packages/runtime/src/index.ts`, `runtime.ts`. Owns application operations, freshness, observation, control, and verification orchestration. |
| Domain and parsing | `types.ts`, `schema.ts`. Version 1 typed events, versioned goal contracts, schema-derived review responses, strict boundary validation with Zod, separate operator check registration and stored artifact digests. |
| Goal and decision policies | `intelligence.ts`. Requirement/acceptance extraction, critical questions, conservative sufficiency and contract-review gates, routing, shared requirement-verification policy. |
| Context | `context.ts`. Bounded lexical and filename retrieval, requirement links, explicit conversation decision import, provenance, supersession, source/project hashing. |
| Persistence | `store.ts`. Project-bound SQLite, append-only events, transactional replay/update, idempotent event delivery, measurements, and actual read-only mode. |
| Verification | `process.ts`, `verification.ts`. Trusted argv execution without a shell, output/time bounds, pinned verifier files/helpers, source-mutation detection. |
| CLI | `cli.ts`. JSON commands for the complete workflow. Errors go to stderr; failed checks retain structured stdout and nonzero exit status. |
| Thin adapter | `packages/adapter/src/index.ts`. Bounded CLI transport, no optimizer policy or parallel state. |
| Installable skill | `packages/adapter/skill/optimizer-checkpoint/SKILL.md`. Real cooperative agent workflow, current citations, clarification, pause and justified reconsideration. |
| Optional MCP | `packages/mcp`. Official SDK stdio server with two strictly read-only, project-bound, sanitized status/event tools. |
| Demonstration | `examples/vertical-slice`, `scripts/demo-prepare.mjs`, `scripts/demo-report.mjs`. Matched coding fixtures, independent acceptance, and evidence reporting. |
| Packaging | `scripts/package.mjs`. Stages compiled packages in `dist/npm` and removes source-only development exports from staged manifests. |

Only the runtime owns SQLite and policy. Keep adapters and MCP thin.

## Toolchain and exact commands

The default shell uses Node.js 20, which is too old. Node.js **24.18.0** is already installed. Use `nvm use` or prepend its existing installation for this shell only:

```sh
export PATH="/Users/m129/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version
npm test
npm run typecheck
npm run lint
npm run build
node packages/runtime/src/cli.ts --help
```

Verified local versions: TypeScript 5.9.3, `@types/node` 24.13.1, SQLite 3.53.1, Zod 4.6.5, official MCP SDK 1.32.1.

`lint` is explicitly additional TypeScript compiler checking, not ESLint. It checks return paths, fallthrough, unreachable code, and unused labels. Strict configuration also rejects unused imports/variables. Tests use Node's native test runner and TypeScript support.

`npm ci` is the portable setup command. Registry/model DNS was unavailable during implementation. Existing installed packages were copied into ignored local `node_modules` for offline work. A conventional portable `package-lock.json` now has the complete dependency closure and integrity metadata. Do not replace it with machine-specific file dependencies.

## Verification completed

- **49/49 tests passed** in the original vertical-slice suite after the `artifactFiles` change. Follow-up results are recorded separately in the implementation ledger.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed on that source state.
- Real tests cover SQLite restart/replay, idempotent/conflicting events, invalid input, project isolation, context provenance/freshness, gate outcomes, cooperative pause/reconsideration, failed/timed-out/output-bounded subprocesses, requirement coverage, source mutation, and stale verifier evidence.
- The adapter's full CLI integration test executes the complete gated cycle. It distinguishes a failed check from a malformed protocol or runtime rejection.
- Five official-SDK stdio integration tests validate initialization, both tools, pagination bounds, read-only behavior, redaction, cross-project isolation, and uninitialized startup.
- Clean offline installation into a temporary prefix passed using actual product/dependency tarballs and a conventional temporary local-tarball lock. Installed CLI, adapter, and MCP checks passed.
- The last installed smoke check confirmed the installed `runtime.js` digest equals the current built runtime and exercised the new `artifactFiles` registration API.
- Two independent reviews found no remaining concrete blocker at the intended bounded checkpoint workload. Reviewers independently inspected actual demo state and reran acceptance.

Three correctness issues were fixed with regression coverage:

1. Appending user decisions previously changed the whole transcript digest and prevented re-import. Stable decision identity now permits a provenance-digest refresh while rejecting semantic same-ID rewrites.
2. Directly executed verifier scripts in `argv[0]` previously escaped artifact pinning. Direct path verifier executables are now pinned; the optimizer's own Node executable remains part of the trusted runtime.
3. Changed verifier artifacts previously blocked completion but could leave requirement labels appearing verified. Current-state evidence now excludes those stale proofs too.

A clean **registry-backed** `npm ci`, 58/58 tests, build, packed-tarball install, installed CLI start/retrieve/next, and installed MCP initialize/tools-list passed on 2026-10-26. No hosted Codex/Claude CLI run was completed; authenticated Codex was installed, but hosted-model DNS was unavailable. Do not conflate those limits with the real coding-agent harness and installed-package tests that did run.

## Actual coding-agent demonstration

The task repaired a small `parseCount` module against a pinned external acceptance runner. It tested 8 valid and 22 invalid inputs covering requirements R1, R2, and R3.

Both actual coding agents started with identical source. Each was deliberately given three unchanged pre-repair failing acceptance runs. This is a **controlled fault-injection protocol**, not a measurement of natural agent retry frequency.

The optimized agent used the actual `runOptimizer` adapter. It:

1. Observed a critical human clarification gate.
2. Imported the selected fixture conversation, retrieved code/docs/user-decision context, and resolved human/local questions with actual source IDs.
3. Recorded a reasoned sufficiency assessment with citations.
4. Ran the registered acceptance check three times, triggering a pause.
5. Honored the pause and justified retaining its own strategy. The optimizer did not supply a replacement plan.
6. Repaired code, refreshed stale source context and the affected local answer, and reassessed sufficiency.
7. Passed acceptance, recorded a completion claim, and passed explicit independent verification.

The report was independently reconstructed from SQLite and the final code was retested. It includes **all five command observations**, including failed attempts that are no longer in the current-state evidence set after clarification refresh.

Recorded diagnostics:

- Baseline agent interval: about **35.61 seconds**.
- Optimized agent interval: about **274.01 seconds**.
- Optimized adapter calls: **28**, totaling about **14.34 seconds**, including registered child checks.
- All five registered child checks: about **1.53 seconds**.
- Adapter wall time excluding those child checks: about **12.81 seconds**.
- Instrumented library work plus database opens: about **0.73 seconds** across 65 measurement records. This excludes measurement persistence and some host/process overhead; it is not total optimizer cost.
- Optimizer-owned LLM calls: **0**. Working-agent token counts: unavailable.

The optimized run used more coordination/checks and was slower in these recorded intervals. Timing scopes differ, order was not randomized, and there is only one task pair. **No improved efficiency or quality advantage has been established.** The demonstrated result is functional integration with independently verified outcomes.

The imported history is explicitly synthetic fixture data, not a recovered decision from an actual historical user session. Provenance and role boundaries were exercised; automatic native transcript conversion was not implemented.

## Artifacts and temporary state

Durable evidence is in the two repository JSON reports linked above. The coding-agent report embeds final source, context/provenance, assessments, strategy response, all command evidence, timings, and event metadata.

Raw demonstration files currently live in `/private/tmp/optimizer-slice-20261026`:

- `manifest.json` records paths and session setup.
- `optimized/.optimizer/runtime.sqlite` contains the actual project-bound event history.
- `baseline-result.json` and `optimized-result.json` are the agents' raw reports. The optimized report is large; inspect selected fields rather than dumping it.
- The active demonstration session is `session-44582a52-d2ae-4868-b097-f7c992b06183`.

Temporary package-install scripts, tarballs, logs, and prefix are in `/private/tmp/optimizer-package-validation`. Its `locked-prefix` contains the validated installed packages.

Temporary directories may disappear. SQLite is bound to its canonical project path; copying the database to a different root will correctly fail project-identity checks. Do not modify the old fixture/history/acceptance runner casually; their hashes are evidence. Use a fresh demo directory for a new run.

The existing raw demonstration predates mandatory contract review. Under the current runtime it opens with pending review, so the report command below rejects completion until the real working agent reviews that contract against current evidence. Prefer a fresh demonstration through the updated checkpoint skill. Do not fabricate a review to reproduce the old report or overwrite historical evidence as though it had exercised the new gate.

To generate a report after a current-policy demonstration completes:

```sh
node scripts/demo-report.mjs /private/tmp/optimizer-slice-20261026
```

To prepare another scenario:

```sh
npm run demo:prepare -- /absolute/new/demo-directory
```

The preparation script creates fixtures and a session; an actual coding agent still performs each task. It must not be replaced with a script that pretends to implement agent reasoning.

## Known limits and next work

1. **Close out and preserve this slice first.** Read this handoff and evidence before changing architecture. Foundation code and the complete cycle already exist; do not rebuild them or revert to an observation-only milestone.
2. **Restore normal development access when available.** Git and registry-backed `npm ci` are done. Live hosted-agent integration remains unverified. Do not push or open a PR without explicit approval.
3. **Improve real goal/history coverage next.** Goal extraction uses a documented Markdown dialect, not general natural-language interpretation. Context uses bounded lexical/filename matching plus agent assessment. History import accepts normalized JSONL and explicit user `Decision:` statements, not provider-native transcript formats.
4. **Broaden evaluation before claiming value.** Add representative task categories, repeated controlled trials, comparable timing boundaries, optimizer-inclusive token/cost accounting, and unmodified native-agent baselines.
5. **Keep cooperative capabilities honest.** The working integration is an installable skill/CLI adapter, not a native hook plugin, automatic lifecycle observer, or preemptive interruption mechanism. Actual subprocess results are observed; agent work outside checkpoints is not automatically intercepted.
6. **Respect current bounds.** Retrieval is capped; incomplete scans cannot establish sufficiency. Event queries/replay load full session history, so this is for bounded tasks. A registered check holds a write transaction for up to its 30-second bound; competing writers wait at most two seconds and then fail clearly. Adapter timeout cannot guarantee immediate termination of an already running verifier.
7. **Build hygiene.** `npm run build` runs `npm run clean` first, removing `dist/` and `packages/*/dist/`.

Verifier commands are explicitly operator-selected and trusted, run without a shell but with the caller's environment/privileges, and are not a generic command sandbox. Helper files outside argv can be pinned with `artifactFiles`. Same-OS-user tampering with the optimizer itself is outside this boundary. Subjective criteria and semantic correctness beyond the registered checks are not automatically proven.

No unresolved required approval or running implementation task is being handed off. The next session should start by checking the saved evidence, the Node version, and workspace state, then select the next concrete improvement from the limits above.
