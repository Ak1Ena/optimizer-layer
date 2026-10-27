import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
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
    const systemPrompt = protocol(root, session.id, summary, `${checkpoint.decision}: ${checkpoint.reason}`, checkpoint.tier === 'light' && checkpoint.decision === 'PROCEED');
    const agentStarted = performance.now();
    const agent = spawnSync(input.claude, [
      '-p', '--settings', settings, '--append-system-prompt', systemPrompt,
      '--max-turns', String(input.maxTurns), '--output-format', 'json', ...(input.claudeArgs ?? []),
    ], { cwd: root, input: input.prompt, encoding: 'utf8', shell: false, timeout: input.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OPTIMIZER_MODE: 'managed', OPTIMIZER_MANAGED_RUN: '1' } });
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
