# Agent instructions

## Project context

- Read [CONTEXT.md](CONTEXT.md) before starting work for project background and requirements.
- The project is a TypeScript ESM workspace targeting Node.js 24.18.x, with built-in SQLite and Zod boundary validation.
- `packages/runtime` owns goal/context intelligence, policies, event persistence, subprocess checks, and the CLI. Adapters and optional MCP tools must use public interfaces rather than owning state or duplicating policy.
- The first delivery target is the complete cycle in [the binding design](docs/superpowers/specs/2026-10-26-complete-optimizer-design.md). The older observation-only milestone is superseded.

## Development and verification

- Use Node.js 24.18.0 (`.nvmrc`); the machine's default Node.js may be older. Do not change global configuration.
- Dependencies are pinned in `package-lock.json`. `npm ci` is the normal setup command. A clean registry-backed `npm ci` and packed-tarball installation were verified on 2026-10-26.
- `npm test` runs real Node tests for runtime, adapter, and MCP, using the `development` export condition to resolve workspace source.
- `npm run typecheck` runs strict TypeScript checks.
- `npm run lint` runs additional compiler checks for return paths, fallthrough, unreachable code, and unused labels; unused imports/variables are already rejected by TypeScript configuration.
- `npm run build` compiles packages and stages installable artifacts in `dist/npm`. Pack those staged directories; they omit source-only development export conditions.
- `node packages/runtime/src/cli.ts --help` runs the development CLI. Installed packages expose `optimizer` and optional `optimizer-mcp`.
- `npm run demo:prepare -- /absolute/new/directory` prepares matched coding fixtures. It does not impersonate a coding agent. Follow the installable checkpoint skill for the optimized task.
- `npm run demo:report -- /absolute/demo/directory` independently checks completed agent artifacts and writes the recorded evidence report.
- Context and verification hashes deliberately exclude private state/dependencies and reject incomplete scans. Imported user decisions retain provenance; goal/context text never becomes executable argv.
- Cooperative control is checkpoint-based. No automatic native host interruption, provider token usage, or efficiency improvement may be advertised without actual evidence.

## Working style

- Follow `using-superpowers`: check applicable skills before each task and read their instructions when available.
- Use `caveman` at level lite for replies until the user requests normal mode. Keep code, commits, PRs, and security warnings in normal prose.
- Keep changes small and complete. Reuse existing patterns and dependencies before adding new ones.
- Prefer local, reversible action over unnecessary confirmation. Ask only when an unresolved choice materially changes the result.

## Before changing code

- Define the concrete outcome and an observable completion check.
- Read applicable instructions, affected code, callers, and tests. Search with `rg` and include hidden files when relevant.
- Identify every affected caller, fixture, configuration, export, and consumer.
- Separate verified facts from assumptions. Check assumptions that are easy to verify.
- For work beyond a small edit, write a short plan with a check for each step. Establish types and data flow before implementation.

## Implementation and debugging

- Reproduce bugs or gather hard evidence before proposing a fix. Identify possible paths and prove which one runs.
- Fix the shared root cause. If two fixes based on the same premise fail, revisit the premise before trying again.
- Avoid speculative abstractions, dependencies, and unrelated changes. Preserve boundary validation and error handling that protects data.
- Update affected callers and tests together. Add a focused behavior test for new non-trivial logic.
- Explain only non-obvious reasons in comments.

## Verification and reporting

- Review the final diff for correctness, missing consumers, unnecessary code, and unintended behavior changes.
- Run the project's established tests, lint, and typecheck commands when available. Report missing tooling or failed checks accurately.
- For UI, API, and service changes, run the affected behavior and observe the result when the environment supports it.
- Claim completion only after the completion check passes. Documentation-only changes need content and formatting review, not invented test commands.
- Report the outcome, verification performed, checks skipped or blocked, and remaining material risk. Keep replies short and direct.

## Actions requiring explicit approval

- Ask before pushing, force-pushing, opening a PR, deploying, sending messages, or deleting data.
- Approval for one action does not authorize the next.
