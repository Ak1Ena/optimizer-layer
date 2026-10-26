# Coding-agent checkpoint adapter

`@optimizer-layer/agent-adapter` is a thin, dependency-free Node.js 24 transport for the standalone optimizer CLI. It includes the installable `optimizer-checkpoint` skill. The runtime owns all state, decisions, and verification policy.

## Install

Build and pack from the repository root:

```sh
npm run build
npm pack ./dist/npm/adapter
npm install /absolute/path/to/optimizer-layer-agent-adapter-0.1.0.tgz
```

Install the runtime package separately and configure its absolute executable path. For Codex, copy the packaged `skill/optimizer-checkpoint` directory into your chosen skill directory (normally `~/.codex/skills/optimizer-checkpoint`), then start a new session. Other coding agents can load the same `SKILL.md` as explicit task instructions. For Claude Code, copy it to `~/.claude/skills/optimizer-checkpoint`. The `optimizer` and `optimizer-mcp` binaries use `#!/usr/bin/env node`; if the agent's default `node` is older than 24.18, `node:sqlite` is missing, so put a wrapper on `PATH` that runs the binary with an explicit Node.js 24 executable. The package does not modify host configuration or install a background service.

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

This is checkpoint cooperation: it cannot preempt a host agent, intercept every tool call, or enforce pauses if the host ignores the skill. There is no hosted CLI integration, MCP dependency, second policy engine, or adapter-owned state store. The runtime's evidence proves the registered acceptance contract, not arbitrary unstated intent.

## Development

From the repository root:

```sh
node --test packages/adapter/test/*.test.ts
npm run typecheck
```

Transport tests use real Node child processes. The integration test runs the real runtime CLI through clarification, review blocking, a cited challenge and resolution, acceptance, three failed independent checks, pause, justified reconsideration, code edits, refreshed local evidence and review, and passing verification.
