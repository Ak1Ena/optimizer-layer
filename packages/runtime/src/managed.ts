import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendCapturedPrompt } from './context.ts';
import { managedProject } from './controller.ts';
import { readProjectConfig, sessionSummary } from './project.ts';
import { Runtime } from './runtime.ts';
import { canonicalRoot } from './user-store.ts';

export interface ManagedRunInput {
  project: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  claude: string;
  /** Absolute path of the Claude Code hook script (`optimizer-claude-hook`). */
  hook: string;
  /** Absolute path of an executable that runs this runtime CLI; the hooks call it. */
  runtimeBin: string;
  /** Extra `claude` arguments, e.g. `--permission-mode acceptEdits`; already split without a shell. */
  claudeArgs?: string[];
  /** Operator-only: 'standard' skips the light tier and records the forced trigger (benchmark arm B). */
  tier?: 'standard';
}

/** Splits `--claude-args` on whitespace without a shell; quoting and shell syntax are refused rather than interpreted. */
export function claudeArgs(text: string): string[] {
  if (/[|;&$><`\\'"(){}*?\[\]!#~]/.test(text)) throw new Error('--claude-args must be plain whitespace-separated arguments without quotes or shell metacharacters');
  const args = text.trim().split(/\s+/).filter(Boolean);
  // These are owned by the managed run: replacing them would drop the enforcing hooks or the bounds.
  const owned = args.find(item => /^--(settings|setting-sources|append-system-prompt|system-prompt|max-turns|output-format|dangerously-skip-permissions)(=|$)/.test(item) || item === '-p' || item === '--print');
  if (owned) throw new Error(`--claude-args cannot set ${owned}; optimizer run owns it`);
  return args;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** First executable named `name` on PATH, resolved through symlinks (npm installs bins as links). */
export function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(item => isAbsolute(item))) {
    try {
      const candidate = join(directory, name);
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

/** Hash of the runtime's TypeScript sources (`.ts` files only, so editor and OS files never change it). */
export function sourceBuildId(directory: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter(item => item.endsWith('.ts')).sort()) {
    const path = join(directory, name);
    if (statSync(path).isFile()) hash.update(`${name}\0`).update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

/**
 * This runtime's build identity, the same for the sources and for a dist built from them (`npm run build` writes
 * `build-id`): two installs that report the same version can still differ. A dist without `build-id` throws.
 */
export function runtimeBuild(moduleUrl: string = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  if (moduleUrl.endsWith('.ts')) return sourceBuildId(directory);
  const id = readFileSync(join(directory, 'build-id'), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`${join(directory, 'build-id')} is not a build id`);
  return id;
}

const realpath = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Optimizer executables that would also run during a managed run but are not this build: the hooks' runtime and every
 * OPTIMIZER_BIN that the Claude Code settings the agent loads set, in hook commands or the env block. User settings
 * are probed with `build`; a repository's own `.claude` settings are never executed, only compared by real path.
 * A build that cannot report its identity counts as a conflict.
 */
export function buildConflicts(runtimeBin: string, root?: string): string[] {
  const own = runtimeBuild();
  const ours = realpath(runtimeBin);
  const user = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const files = [
    ...['settings.json', 'settings.local.json'].map(name => ({ file: join(user, name), trusted: true })),
    ...(root ? ['settings.json', 'settings.local.json'].map(name => ({ file: join(root, '.claude', name), trusted: false })) : []),
  ];
  const probes = new Map<string, string>([[runtimeBin, 'the managed hooks']]);
  const conflicts: string[] = [];
  for (const { file, trusted } of files.filter(item => existsSync(item.file))) {
    let settings: Record<string, unknown> | null;
    try {
      settings = record(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      settings = null;
    }
    if (!settings) {
      conflicts.push(`${file} is not a readable settings object, so its hooks cannot be checked`);
      continue;
    }
    const commands = Object.values(record(settings.hooks) ?? {}).flatMap(groups => Array.isArray(groups) ? groups : [])
      .flatMap(group => { const inner = record(group)?.hooks; return Array.isArray(inner) ? inner : []; })
      .map(hook => record(hook)?.command).filter(command => typeof command === 'string');
    const fromEnv = record(settings.env)?.OPTIMIZER_BIN;
    const bins = [
      ...(fromEnv === undefined ? [] : [String(fromEnv)]),
      // Only a hook that sets OPTIMIZER_BIN runs the optimizer; one that merely mentions it does not.
      ...commands.flatMap(command => [...command.matchAll(/(?:^|[\s;&|])OPTIMIZER_BIN=('[^']*'|"[^"]*"|[^\s;&|'"]*)/g)].map(match => (match[1] ?? '').replace(/^(['"])(.*)\1$/, '$2'))),
    ];
    for (const bin of bins) {
      if (!isAbsolute(bin)) conflicts.push(`OPTIMIZER_BIN ${JSON.stringify(bin)} in ${file} is not an absolute path`);
      else if (trusted) probes.set(bin, `set in ${file}`);
      else if (ours === null || realpath(bin) !== ours) conflicts.push(`${bin} (set in repository settings ${file}; not executed) is not this run's runtime ${runtimeBin}`);
    }
  }
  for (const [bin, source] of probes) {
    const probe = spawnSync(bin, ['build'], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '' } });
    let build: unknown;
    try {
      build = (JSON.parse(probe.stdout) as { build?: unknown }).build;
    } catch {
      build = undefined;
    }
    if (build !== own) conflicts.push(`${bin} (${source}) is ${typeof build === 'string' ? `build ${build.slice(0, 12)}` : 'a build that cannot report its identity'}, not this build ${own.slice(0, 12)}`);
  }
  return conflicts;
}

/** Private settings whose hooks always enforce, whatever mode the user's global install uses. */
export function managedSettings(hook: string, runtimeBin: string) {
  const command = `OPTIMIZER_MODE='managed' OPTIMIZER_BIN=${quote(runtimeBin)} ${quote(process.execPath)} ${quote(hook)}`;
  const entry = { hooks: [{ type: 'command', command, timeout: 60 }] };
  return { hooks: {
    UserPromptSubmit: [entry],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', ...entry }],
    Stop: [entry],
    SubagentStart: [entry],
  } };
}

function protocol(root: string, sessionId: string, summary: string, decision: string, light: boolean): string {
  if (light) {
    return [
      `You are running under the optimizer's Managed Execution Mode. The optimizer started light-tier goal contract ${sessionId} for project ${root} from the user's request; the user-approved checks define done.`,
      `Edit with normal tools, then run \`optimizer verify --project ${root} --session ${sessionId}\` (or \`optimizer check --check CHECK_ID\`); only outcome VERIFIED counts as done. Never try to change the optimizer, its hooks or its state.`,
    ].join('\n');
  }
  return [
    `You are running under the optimizer's Managed Execution Mode. The optimizer already started goal contract ${sessionId} for project ${root} from the user's request and retrieved project context.`,
    summary,
    `Current decision: ${decision}.`,
    `Every optimizer command takes --project ${root} --session ${sessionId}. Reads and read-only commands always work; file edits and other Bash commands are denied until the contract checkpoints pass.`,
    'Protocol: `optimizer status`; `optimizer retrieve`; `optimizer assess --kind sufficient|insufficient --rationale TEXT --items ID,ID`; `optimizer review --kind accept|challenge --version N --rationale TEXT --items ID,ID`; implement; `optimizer retrieve`/`assess`/`review` again when edits make context stale; `optimizer check --check CHECK_ID`; `optimizer claim`; `optimizer verify`. Follow the decision each command returns.',
    'After you exit the optimizer verifies the result independently; only outcome VERIFIED counts as done. Never claim completion otherwise, and never try to change the optimizer, its hooks or its state.',
  ].join('\n');
}

interface AgentReport {
  finalMessage: string | null; turns: number | null; usage: Record<string, unknown> | null; isError: boolean | null;
  totalCostUsd: number | null; durationMs: number | null; durationApiMs: number | null; modelUsage: Record<string, unknown> | null;
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Reads Claude Code `--output-format json`; absent fields stay null, never invented. */
function agentReport(stdout: string): AgentReport {
  try {
    const value = record(JSON.parse(stdout));
    if (!value) throw new Error('not an object');
    const { result, num_turns: turns, is_error: isError } = value;
    return {
      finalMessage: typeof result === 'string' ? result.slice(0, 20_000) : null,
      turns: Number.isSafeInteger(turns) && Number(turns) >= 0 ? Number(turns) : null,
      usage: record(value.usage),
      isError: typeof isError === 'boolean' ? isError : null,
      totalCostUsd: amount(value.total_cost_usd), durationMs: amount(value.duration_ms), durationApiMs: amount(value.duration_api_ms), modelUsage: record(value.modelUsage),
    };
  } catch {
    return { finalMessage: stdout.trim() ? stdout.trim().slice(0, 20_000) : null, turns: null, usage: null, isError: null, totalCostUsd: null, durationMs: null, durationApiMs: null, modelUsage: null };
  }
}

/** Decision 7: the controller starts the task, launches the agent under enforced hooks, then verifies independently. */
export function managedRun(input: ManagedRunInput) {
  // A hook or a managed agent's own tools carry these; a run started from inside an agent is refused.
  if (process.env.OPTIMIZER_MANAGED_RUN || process.env.OPTIMIZER_HOOK_TOKEN) throw new Error('optimizer run cannot be started from inside an optimizer-managed agent or hook');
  const started = performance.now();
  const root = canonicalRoot(input.project);
  const config = readProjectConfig(root);
  if (!config || !managedProject(config, 'managed')) throw new Error('optimizer run needs a managed project: enable it and approve at least one check');
  for (const [name, path] of [['claude', input.claude], ['hook', input.hook], ['runtime', input.runtimeBin]] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} executable must be an absolute path`);
  }
  accessSync(input.runtimeBin, constants.X_OK);
  // Another build reading this run's state fails on events it does not know and fails closed, denying the agent's work.
  const conflicts = buildConflicts(input.runtimeBin, root);
  if (conflicts.length) throw new Error(`optimizer run refused: another optimizer build would also run: ${conflicts.join('; ')}. Point those hooks and OPTIMIZER_BIN at this build, or remove them, then retry.`);
  let runtime: Runtime | null = new Runtime(root);
  let settingsDirectory: string | null = null;
  try {
    if (config.activeSessionId && runtime.next(config.activeSessionId).kind !== 'complete') {
      throw new Error(`Project has an unfinished active session ${config.activeSessionId}; finish it or replace it with \`optimizer start --replace\``);
    }
    // A controller row identifies the request but never carries human authority; approval codes are not processed.
    const promptId = `run:${appendCapturedPrompt(root, input.prompt, config.hookToken, 'controller')}`;
    const { session } = runtime.startFromPrompt(promptId, { forceStandard: input.tier === 'standard' });
    const checkpoint = runtime.decide(session.id);
    const summary = sessionSummary(runtime.get(session.id), runtime.next(session.id));
    // The agent's hooks write through their own runtime processes; this one holds no connection meanwhile.
    runtime.close();
    runtime = null;
    const startMs = performance.now() - started;
    settingsDirectory = mkdtempSync(join(tmpdir(), 'optimizer-run-'));
    const settings = join(settingsDirectory, 'settings.json');
    writeFileSync(settings, JSON.stringify(managedSettings(input.hook, input.runtimeBin), null, 2) + '\n', { mode: 0o600 });
    // The agent's own `optimizer` commands (from the protocol) must reach this build, not whichever is first on PATH.
    const agentBin = join(settingsDirectory, 'bin');
    mkdirSync(agentBin);
    writeFileSync(join(agentBin, 'optimizer'), `#!/bin/sh\nexec ${quote(input.runtimeBin)} "$@"\n`, { mode: 0o755 });
    const systemPrompt = protocol(root, session.id, summary, `${checkpoint.decision}: ${checkpoint.reason}`, checkpoint.tier === 'light' && checkpoint.decision === 'PROCEED');
    const agentStarted = performance.now();
    const agent = spawnSync(input.claude, [
      '-p', '--settings', settings, '--append-system-prompt', systemPrompt,
      '--max-turns', String(input.maxTurns), '--output-format', 'json', ...(input.claudeArgs ?? []),
    ], { cwd: root, input: input.prompt, encoding: 'utf8', shell: false, timeout: input.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: [agentBin, process.env.PATH].filter(Boolean).join(delimiter), OPTIMIZER_BIN: input.runtimeBin, OPTIMIZER_MODE: 'managed', OPTIMIZER_MANAGED_RUN: '1' } });
    const agentMs = performance.now() - agentStarted;
    const timedOut = agent.error !== undefined && 'code' in agent.error && agent.error.code === 'ETIMEDOUT';
    const report = agentReport(agent.stdout ?? '');
    const verifyStarted = performance.now();
    runtime = new Runtime(root);
    runtime.recordAgentUsage(session.id, {
      systemPromptBytes: Buffer.byteLength(systemPrompt), turns: report.turns, totalCostUsd: report.totalCostUsd,
      durationMs: report.durationMs, durationApiMs: report.durationApiMs, usage: report.usage, modelUsage: report.modelUsage,
    });
    const verified = runtime.verify(session.id);
    const verifyMs = performance.now() - verifyStarted;
    return {
      sessionId: session.id, promptId, outcome: verified.outcome, phase: verified.phase, verifiedRequirementIds: verified.verifiedRequirementIds,
      evidence: verified.evidence.map(({ checkId, result, at }) => ({ checkId, outcome: result.outcome, exitCode: result.exitCode, at })),
      agentExitCode: agent.status, agentSignal: agent.signal, timedOut,
      ...(agent.error && !timedOut ? { agentError: agent.error.message } : {}),
      turns: report.turns, usage: report.usage, agentReportedError: report.isError, finalMessage: report.finalMessage,
      timings: { startMs, agentMs, verifyMs, totalMs: performance.now() - started },
      cost: runtime.cost(session.id),
    };
  } finally {
    runtime?.close();
    if (settingsDirectory) rmSync(settingsDirectory, { recursive: true, force: true });
  }
}
