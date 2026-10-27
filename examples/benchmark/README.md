# A/B/C benchmark

Measures the adaptive-execution acceptance criteria AC1/AC2 ([spec](../../docs/superpowers/specs/2026-10-27-adaptive-execution-design.md)).

- **A** plain agent: `claude -p --output-format json` with `OPTIMIZER_DISABLED=1` (your global optimizer hooks become no-ops).
- **B** all mandatory gates: `optimizer run --tier standard` (standard tier forced; recorded as `tier.decided standard`, trigger `forced by run option (optimizer run --tier standard)`).
- **C** adaptive: `optimizer run` (light tier when eligible).

Every run gets a fresh copy of `tasks/NAME/repo` in a temporary directory (`git init`, one commit). For B and C the runner enables that copy with the task's `check` through the runtime's own `enableProject` (it is operator code run from your terminal; `optimizer run` itself still refuses to start inside an agent). Same task text, model, permissions (`--claude-args`), turn budget and timeout for all arms. After the agent exits, `tasks/NAME/hidden/acceptance.mjs COPY` runs from outside the copy, so the agent never sees it.

## Tasks (`tasks.json` order; `--tasks 4` takes the first four, one per class)

Each task folder has `task.txt` (the request), `check` (the approved check: a visible test weaker than or equal to the hidden one), `repo/`, `hidden/`, `solution/` (reference fix) and sometimes `decoy/` (a plausible wrong fix). Its `README.md` says what it probes. `solution/` and `decoy/` are used only by the fake agent and the suite self-test.

| task | class |
|---|---|
| parse-count | straightforward |
| invoice-total | ambiguous |
| user-nickname | multi-file |
| week-of | misleading |
| clamp-range | straightforward |
| csv-quote | straightforward |
| dedupe-users | ambiguous |
| max-attempts | multi-file |

## Run (spends model quota; only from your own terminal)

```sh
node scripts/benchmark-run.mjs --tasks 4 --reps 2 --model sonnet --out benchmark-results/small        # prints the plan (24 runs), runs nothing
node scripts/benchmark-run.mjs --tasks 4 --reps 2 --model sonnet --out benchmark-results/small --yes  # small: 4 x 3 x 2 = 24 runs
node scripts/benchmark-run.mjs --tasks 8 --reps 3 --model sonnet --out benchmark-results/medium --yes # medium: 8 x 3 x 3 = 72 runs
node scripts/benchmark-report.mjs benchmark-results/small/results.jsonl
```

Options: `--claude PATH` (`fake` = `fake-claude.mjs`), `--model NAME`, `--max-turns N` (30), `--timeout-ms N` (900000 per run), `--claude-args="..."` (default `--permission-mode acceptEdits --allowedTools Bash`), `--out DIR` (`benchmark-results`), `--keep` (keep the run copies). Re-running with the same `--out` skips rows already in `results.jsonl`, so an interrupted run resumes. Arm order rotates per rep.

## What a row records (real sources only; missing values stay `null`)

Wall clock around the arm; `turns`, `totalCostUsd` and `tokens` (input, cache read, cache write, output, total) from Claude Code's JSON (`usage`, verbatim through `optimizer run` for B/C); for B/C the `optimizer run` outcome, tier with triggers, rework, injected bytes, timings and overhead (start + verify + hook wall clock, and its share of the run); `hiddenPassed`, `visiblePassed`; `claimedDone` (A: Claude Code reported no error; B/C: outcome `VERIFIED`) and `falseDone` (claimed done, hidden test failed). The report prints per-arm and per-class verified rate, false-done count, token median/mean (and each component), wall clock, cost per verified success, overhead share, and AC1/AC2 PASS/FAIL/n/a with the numbers.

## Dry run without a model

```sh
node scripts/benchmark-run.mjs --claude fake --tasks 4 --reps 1 --yes --out /tmp/bench-dry
node scripts/benchmark-report.mjs /tmp/bench-dry/results.jsonl
```

The fake writes `decoy/` when present (invoice-total, week-of, dedupe-users) and `solution/` otherwise, runs the managed hooks like Claude Code, and reports deterministic usage. Its numbers say nothing about real cost.
