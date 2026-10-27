#!/usr/bin/env node
import { accessSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { injected, runOptimizer, type OptimizerCommand } from './index.ts';
import { deniedBash } from './bash-guard.ts';

type Output = Record<string, unknown> | undefined;
interface Current { sessionId: string | null; checkpoint: Decision | null; summary: string; checks: string[][]; pending: { code: string; argv: string[][] } | null }
interface Decision { decision: string; reason: string; phase: string; requiredBy: string; uncertaintyIds: unknown; tier: string }

const script = fileURLToPath(import.meta.url);
// Only these tools reach the hook, so reads cost no runtime spawn; other tools (MCP, web) are not gated.
const gatedTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const editMatcher = gatedTools.join('|');
// Claude Code kills a hook after this many seconds and then proceeds; each runtime call stays well below it.
const hookTimeoutSeconds = 60;
const callTimeoutMs = 15_000;
const dialect = `Goal dialect (one item per line):
- R1: requested behavior in the user's words.
Acceptance R1: observable passing result.
Question human Q1: a consequential choice that belongs to the user?
Question local Q2: a technical fact to investigate?
Do not invent acceptance criteria or human choices; ask the user instead.`;
/** How to satisfy each runtime controller decision. */
const instructions: Record<string, string> = {
  RETRIEVE_CONTEXT: 'Run `optimizer retrieve`, inspect items and diagnostics, then `optimizer assess --kind sufficient|insufficient --rationale TEXT --items ID,ID` citing current item IDs. Resolve local questions with `optimizer resolve --question ID --source ITEM_ID --answer TEXT`.',
  INVESTIGATE: 'Run `optimizer retrieve` again, inspect the stale or missing items, then `optimizer assess` citing current item IDs. Resolve local questions with `optimizer resolve --question ID --source ITEM_ID --answer TEXT`.',
  ASK_HUMAN: 'Ask the user the open human questions (or show the escalation reason and evidence) and wait for the answer. When a captured user prompt answers one, run `optimizer resolve --question ID --source prompt:PROMPT_ID`. Never invent a human answer.',
  REVIEW_CONTRACT: 'Read `optimizer status`, then accept with `optimizer review --kind accept --version VERSION --rationale TEXT --items ID,ID` citing context for every requirement, or challenge with `--kind challenge --requirement R --owner local|human`.',
  PROCEED: 'Implement the contract with normal tools. Run `optimizer check --check CHECK_ID` and follow the returned action; when done run `optimizer claim` and `optimizer verify`.',
  RUN_VERIFICATION: 'Run `optimizer verify`; the task is complete only when its outcome is VERIFIED. If edits made the context stale, retrieve and assess again first.',
  REQUEST_RECONSIDERATION: 'Stop editing. Read the failed evidence with `optimizer status` and answer `optimizer reconsider --strategy retain|revise --rationale TEXT`.',
  BLOCK_ACTION: 'Report the blocker to the user, or resume through an optimizer checkpoint command.',
  COMPLETE: 'Report the verified requirement IDs and evidence.',
};
/** A light-tier session needs nothing from the agent but the edit and a verification run. */
const lightInstruction = 'Edit with normal tools, then run `optimizer verify` (or `optimizer check --check CHECK_ID`); only outcome VERIFIED completes the task.';

function instruction(checkpoint: Decision): string {
  const light = checkpoint.tier === 'light' && (checkpoint.decision === 'PROCEED' || checkpoint.decision === 'RUN_VERIFICATION');
  return light ? lightInstruction : instructions[checkpoint.decision] ?? 'Follow the runtime reason.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Real path of the nearest existing ancestor, so not-yet-created files compare against the real project root. */
function real(path: string): string {
  try {
    // native realpath canonicalizes letter case on case-insensitive filesystems.
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/** Any folder is a project: the nearest ancestor that already has .optimizer/, else cwd; never the filesystem root or runtime state itself. */
function findRoot(cwd: string): string | null {
  const parts = resolve(cwd).split(sep);
  const inside = parts.indexOf('.optimizer');
  const start = inside === -1 ? resolve(cwd) : parts.slice(0, inside).join(sep) || sep;
  const home = resolve(homedir());
  let nearest: string | null = null;
  for (let directory = start; dirname(directory) !== directory; directory = dirname(directory)) {
    // A home-directory project applies only in home itself; otherwise it would absorb every project below it.
    if (directory === home && directory !== start) break;
    if (!existsSync(join(directory, '.optimizer'))) continue;
    const root = realpathSync.native(directory);
    // An enabled per-user record wins over a nearer bare .optimizer, which anyone (the agent included) can create to escape the gate.
    if (readConfig(root)?.enabled === true) return root;
    nearest ??= root;
  }
  return nearest ?? (dirname(start) === start ? null : realpathSync.native(start));
}

/** Mirrors the runtime's per-user store; a project.json inside the project is never trusted. */
function userStore(): string {
  const base = process.env.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(homedir(), '.config'), 'optimizer-layer');
}

function readConfig(root: string): Record<string, unknown> | null {
  try {
    const path = join(userStore(), 'projects', `${createHash('sha256').update(root).digest('hex')}.json`);
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(config) && config.projectRoot === root ? config : null;
  } catch {
    return null;
  }
}

function argvList(value: unknown): string[][] {
  return Array.isArray(value) ? value.filter(item => Array.isArray(item)).map(item => item.map(String)) : [];
}

/** This invocation's overhead, appended to the project's hook-metrics.jsonl for `optimizer metrics`; bytes and time, never invented tokens. */
const trace: { root: string | null; event: string; sessionId: string | null; calls: { command: string; elapsedMs: number; ok: boolean }[] } = { root: null, event: '', sessionId: null, calls: [] };

function call(root: string, command: OptimizerCommand, options: Record<string, string> = {}, sessionId?: string): Record<string, unknown> {
  const executable = process.env.OPTIMIZER_BIN;
  if (!executable) throw new Error('OPTIMIZER_BIN is not set; re-run optimizer-claude-hook install');
  const started = performance.now();
  const result = runOptimizer({ executable, projectRoot: root, command, options, timeoutMs: callTimeoutMs, ...(sessionId === undefined ? {} : { sessionId }) });
  trace.calls.push({ command, elapsedMs: performance.now() - started, ok: result.kind === 'response' && result.exitCode === 0 });
  if (result.kind !== 'response' || result.exitCode !== 0 || !isRecord(result.value)) {
    throw new Error(`optimizer ${command} failed: ${result.kind === 'response' ? JSON.stringify(result.value) : result.stderr.trim() || ('reason' in result ? result.reason : result.kind)}`);
  }
  return result.value;
}

/** Passes hook input to the runtime through a private temporary file, never through argv. */
function withFile<T>(content: string, use: (file: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'optimizer-hook-'));
  try {
    const file = join(directory, 'input');
    writeFileSync(file, content, { mode: 0o600 });
    return use(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function current(root: string): Current {
  const value = call(root, 'current');
  trace.sessionId = text(value.sessionId) ?? trace.sessionId;
  const pending = value.pendingChecks;
  return {
    sessionId: text(value.sessionId) ?? null,
    // `current` carries the structured decision, saving a second runtime spawn per prompt or Stop.
    checkpoint: isRecord(value.checkpoint) ? decision(value.checkpoint) : null,
    summary: text(value.summary) ?? '',
    checks: argvList(value.checks),
    pending: isRecord(pending) && typeof pending.code === 'string' ? { code: pending.code, argv: argvList(pending.argv) } : null,
  };
}

function decision(value: Record<string, unknown>): Decision | null {
  const kind = text(value.decision);
  if (!kind) return null;
  const action = isRecord(value.action) ? value.action : {};
  return { decision: kind, reason: text(value.reason) ?? '', phase: text(value.phase) ?? 'unknown', requiredBy: text(value.requiredBy) ?? 'agent', uncertaintyIds: action.uncertaintyIds, tier: text(value.tier) ?? 'standard' };
}

function capture(root: string, prompt: string): { id: string; checkApproved: boolean; changeApproved: string | undefined; approvalError: string | undefined } {
  return withFile(prompt, file => {
    const value = call(root, 'prompt', { file });
    const id = text(value.id);
    if (!id) throw new Error('optimizer prompt returned no ID');
    return { id, checkApproved: value.checkApproved === true, changeApproved: text(value.changeApproved), approvalError: text(value.approvalError) };
  });
}

function outside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
}

/** Silent unless something needs the agent: an approval outcome, a pending proposal, or an open checkpoint. */
function userPromptSubmit(root: string, prompt: string): Output {
  let id = 'ID';
  const lines: string[] = [];
  try {
    // Captured even when silent: the controller starts a contract from this prompt at the first protected action.
    const captured = capture(root, prompt);
    id = captured.id;
    if (captured.checkApproved) lines.push('optimizer: with this prompt the user approved the proposed check commands; they are now the project checks.');
    if (captured.changeApproved) lines.push(`optimizer: with this prompt the user approved \`optimizer ${captured.changeApproved}\`; it is now applied.`);
    if (captured.approvalError) lines.push(`optimizer: the user typed the approval code, but the proposed checks could not be activated: ${captured.approvalError}. Propose a corrected check.`);
  } catch (error) {
    process.stderr.write(`optimizer-claude-hook: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
    lines.push('optimizer: this prompt could not be captured, so it cannot be cited as a human decision.');
  }
  const state = current(root);
  const commands = (rows: string[][]) => rows.map(argv => `  ${JSON.stringify(argv)}`).join('\n');
  if (state.pending) {
    lines.push(`Pending check proposal (argv, run without a shell):\n${commands(state.pending.argv)}\nThe user approves it by replying with \`approve check ${state.pending.code}\`; nothing else activates it.`);
  }
  const checkpoint = state.sessionId ? state.checkpoint : null;
  if (state.sessionId && checkpoint && checkpoint.decision !== 'COMPLETE') {
    if (checkpoint.tier === 'light' && (checkpoint.decision === 'PROCEED' || checkpoint.decision === 'RUN_VERIFICATION')) {
      lines.push(`optimizer: light-tier session ${state.sessionId} is open. ${lightInstruction} Commands take --project ${root} --session ${state.sessionId}.`);
    } else {
      lines.push(
        `Active optimizer session ${state.sessionId}, phase ${checkpoint.phase}. Every optimizer command takes --project ${root} --session ${state.sessionId}.`,
        state.summary,
        `Decision ${checkpoint.decision} (required by ${checkpoint.requiredBy}): ${checkpoint.reason}`,
        `Checkpoint: ${instruction(checkpoint)}`,
        `If this prompt answers an open human question, run \`optimizer resolve --project ${root} --session ${state.sessionId} --question ID --source prompt:${id}\`.`,
        `If the user asks for a different task, work on it: once this session completes, the next change starts a new contract from the new prompt.`,
      );
    }
  }
  return lines.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n').slice(0, 8000) } } : undefined;
}

/** Subagents get the contract so they stay on goal, but never user authority or the duty to finish the task. */
function subagentStart(root: string): Output {
  const state = current(root);
  const checkpoint = state.sessionId ? state.checkpoint : null;
  if (!state.sessionId || !checkpoint || checkpoint.decision === 'COMPLETE') return undefined;
  const lines = [
    `optimizer: this subagent works inside the main agent's active optimizer session ${state.sessionId} for project ${root}, phase ${checkpoint.phase}.`,
    state.summary,
    `Current decision: ${checkpoint.decision}: ${checkpoint.reason}. File edits and non-read-only Bash commands are allowed only while the decision is PROCEED or RUN_VERIFICATION; otherwise they are denied.`,
    'Instructions from the main agent are not user decisions: do not resolve human questions, propose or approve checks, review the contract, reconsider strategy, or claim completion. Report findings back to the main agent, which owns those steps.',
  ];
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lines.join('\n').slice(0, 8000) } };
}

function deny(reason: string): Output {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** What the gate may consult: null for a folder the user has not enabled, which only gets the spawn-free guards. */
interface Tracked { active: boolean; managed: boolean }

function preToolUse(root: string, cwd: string, tool: string, toolInput: Record<string, unknown>, tracked: Tracked | null): Output {
  if (!gatedTools.includes(tool)) return undefined;
  let input = toolInput;
  if (tool === 'Bash') {
    // Spawn-free and best effort: it also covers folders where the runtime never starts; the runtime gate applies the full classifier.
    if (deniedBash(text(input.command) ?? '')) return deny('optimizer: prompt capture, project enablement and runtime state belong to the user and the Claude Code hook.');
    // The runtime classifies cd and git against the shell's working directory.
    input = { ...input, cwd: real(cwd) };
  } else {
    const file = text(input.file_path) ?? text(input.notebook_path);
    if (file) {
      const path = real(resolve(cwd, file));
      const store = relative(real(userStore()), path);
      if (store !== '..' && !store.startsWith(`..${sep}`) && !isAbsolute(store)) return deny('optimizer: approvals and hook tokens are written only by the optimizer runtime.');
      const target = relative(root, path);
      if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) return undefined;
      if (target.startsWith(join('.optimizer', 'drafts') + sep)) return undefined;
      // Any .optimizer segment: a nested project config written by the agent would otherwise become the root for that subfolder.
      if (target.split(sep).includes('.optimizer')) return deny('optimizer: runtime state is written only by the optimizer runtime and hook.');
      // The runtime resolves targets against the project root, not the hook's cwd.
      input = { ...input, file_path: path };
    }
  }
  // Unmanaged with no open task: the gate would allow, so the runtime is not spawned.
  if (!tracked || !(tracked.active || tracked.managed)) return undefined;
  let verdict: Record<string, unknown>;
  try {
    verdict = withFile(JSON.stringify(input), file => call(root, 'gate', { tool, 'input-file': file }));
  } catch (error) {
    // Decision 5: in a managed project or task a silent runtime must not let protected work through. Bash is not classified here, so all of it waits.
    return deny(`optimizer unavailable: a managed task is active and the runtime could not answer (${error instanceof Error ? error.message : String(error)}), so file edits and Bash commands are denied. Read, Grep and Glob still work; ask the user to check the optimizer installation.`.replaceAll('\n', ' '));
  }
  const sessionId = text(verdict.sessionId);
  trace.sessionId = sessionId ?? trace.sessionId;
  if (verdict.allow === true) return undefined;
  const reason = text(verdict.reason) ?? 'action denied';
  const checkpoint = isRecord(verdict.checkpoint) ? decision(verdict.checkpoint) : null;
  const lines = [reason.startsWith('optimizer') ? reason : `optimizer: ${reason}`];
  if (verdict.started === true) lines.push(`The optimizer started goal contract ${sessionId ?? ''} from the latest user prompt: R1 is the prompt verbatim and is accepted when every approved project check passes. Add requirements with evidence through \`optimizer review --kind challenge\`; R1 cannot be removed.`);
  if (checkpoint) lines.push(`Phase ${checkpoint.phase}. Next checkpoint (${checkpoint.decision}): ${instruction(checkpoint)}`);
  if (sessionId) lines.push(`Every optimizer command takes --project ${root} --session ${sessionId}.`);
  // The goal dialect only when the agent must draft a contract itself.
  else if (reason.includes('optimizer start')) lines.push(`Draft the goal under ${root}/.optimizer/drafts/NAME.md, show it to the user, and only after the user approves run \`optimizer start --project ${root} --request FILE\`.`, dialect);
  return deny(lines.join('\n'));
}

function stop(root: string, claudeSession: string, active: boolean, session: boolean): Output {
  const state = session ? current(root) : null;
  const checkpoint = state?.sessionId ? state.checkpoint : null;
  const statePath = join(root, '.optimizer', 'hook-state.json');
  let hookState: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    if (isRecord(parsed)) hookState = parsed;
  } catch {
    // Missing or corrupt loop-guard state starts a fresh count.
  }
  const save = () => {
    // A cloned repository can plant symlinks in .optimizer/; never write through one.
    if (lstatSync(join(root, '.optimizer')).isSymbolicLink()) throw new Error('Runtime directory must not be a symlink');
    const descriptor = openSync(statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(descriptor, JSON.stringify(hookState) + '\n');
    } finally {
      closeSync(descriptor);
    }
  };
  if (!state?.sessionId || !checkpoint || checkpoint.decision === 'COMPLETE') {
    if (claudeSession in hookState) { delete hookState[claudeSession]; save(); }
    return undefined;
  }
  const sessionId = state.sessionId;
  if (checkpoint.decision === 'ASK_HUMAN') {
    const ids = Array.isArray(checkpoint.uncertaintyIds) ? ` (${checkpoint.uncertaintyIds.join(', ')})` : '';
    return { systemMessage: `optimizer: waiting on the user${ids}: ${checkpoint.reason}` };
  }
  const blocked = `optimizer: task ${sessionId} is BLOCKED and unverified, not complete`;
  // An already recorded block stays until a checkpoint command moves it; blocking Stop again would only loop.
  if (checkpoint.phase === 'blocked') return { systemMessage: `${blocked}: ${checkpoint.reason}` };
  const key = JSON.stringify([sessionId, checkpoint, state.summary]);
  const previous = hookState[claudeSession];
  const last = isRecord(previous) ? previous : {};
  const count = active && typeof last.count === 'number' ? last.count : 0;
  if ((active && last.key === key) || count >= 3) {
    // Decision 6: an exhausted Stop budget is recorded as blocked, never presented as a finished task.
    try {
      call(root, 'blocked', { reason: `Stop budget exhausted at ${checkpoint.decision}: ${checkpoint.reason}` }, sessionId);
    } catch (error) {
      // Recording failed: block once more with the reason instead of letting the stop pass silently; the next stop is let through as unverified.
      if (last.recordFailed !== true) {
        hookState[claudeSession] = { key, count, recordFailed: true };
        save();
        return { decision: 'block', reason: `optimizer: the task is unverified and the optimizer could not record it as blocked (${error instanceof Error ? error.message : String(error)}). Tell the user the task is BLOCKED and unverified, not complete.`.replaceAll('\n', ' ') };
      }
      delete hookState[claudeSession];
      save();
      return { systemMessage: `${blocked}; the optimizer could not record the block.` };
    }
    delete hookState[claudeSession];
    save();
    return { systemMessage: `${blocked}: the agent stopped at ${checkpoint.decision} (${checkpoint.reason}). Run \`optimizer verify\`; only outcome VERIFIED completes it.` };
  }
  hookState[claudeSession] = { key, count: count + 1 };
  save();
  return { decision: 'block', reason: `optimizer: task not verified (phase ${checkpoint.phase}). Decision ${checkpoint.decision}: ${checkpoint.reason}\n${instruction(checkpoint)}\nEvery optimizer command takes --project ${root} --session ${sessionId}.` };
}

function hook(raw: string): Output {
  const input: unknown = JSON.parse(raw);
  if (!isRecord(input)) throw new Error('Hook input must be a JSON object');
  const cwd = text(input.cwd);
  if (!cwd || !isAbsolute(cwd)) throw new Error('Hook input needs an absolute cwd');
  if (process.env.OPTIMIZER_DISABLED === '1') return undefined;
  const root = findRoot(cwd);
  if (!root) return undefined;
  const config = readConfig(root);
  // Only an install without a mode marker (always-on behaviour) leaves this unset; any unrecognised marker fails closed to opt-in.
  // `managed` comes only from the private settings of `optimizer run`: tracked and enforced whatever the user's global install mode.
  const mode = process.env.OPTIMIZER_MODE;
  const optIn = mode !== undefined && mode !== 'always-on' && mode !== 'managed';
  // A `#!/usr/bin/env node` runtime binary must run on the hook's Node.js 24, not an older default node.
  process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  const projectDir = text(process.env.CLAUDE_PROJECT_DIR);
  const tool = text(input.tool_name);
  if (input.hook_event_name === 'PreToolUse' && tool && gatedTools.includes(tool) && projectDir && isAbsolute(projectDir)) {
    // The session's project stays the anchor: a `cd` (even through a symlink) must not move the agent out of a managed project.
    const anchor = findRoot(projectDir);
    const anchored = anchor ? readConfig(anchor) : null;
    const managedAnchor = anchored?.enabled === true && (!optIn || anchored.optedIn === true) && Array.isArray(anchored.checks) && anchored.checks.length > 0;
    if (anchor && managedAnchor && outside(anchor, real(cwd))) {
      return deny(`optimizer: the shell's working directory ${real(cwd)} is outside the managed project ${anchor}. Return with \`cd ${anchor}\`; edits and commands from outside the project are denied.`);
    }
  }
  if (config?.enabled === false || (optIn && config?.optedIn !== true)) {
    // The user's `approve enable CODE` reply must reach the runtime even for a folder that is not enabled yet.
    const prompt = text(input.prompt);
    if (input.hook_event_name === 'UserPromptSubmit' && config && prompt && /\bapprove\s+enable\s+[0-9a-f]{4}\b/i.test(prompt)) {
      process.env.OPTIMIZER_HOOK_TOKEN = text(config.hookToken) ?? '';
      try {
        const captured = capture(root, prompt);
        if (captured.changeApproved) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `optimizer: with this prompt the user approved \`optimizer enable\` for ${root}; it is now applied.` } };
      } catch (error) {
        process.stderr.write(`optimizer-claude-hook: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
      }
      return undefined;
    }
    // A folder the user has not enabled gets only the spawn-free guards, so the agent cannot enable it or forge approvals.
    return input.hook_event_name === 'PreToolUse' && tool && isRecord(input.tool_input) ? preToolUse(root, cwd, tool, input.tool_input, null) : undefined;
  }
  trace.root = root;
  trace.event = text(input.hook_event_name) ?? '';
  trace.sessionId = text(config?.activeSessionId) ?? null;
  const token = text(config?.hookToken);
  // A project without config gets its token from the runtime at the first capture.
  if (token) process.env.OPTIMIZER_HOOK_TOKEN = token;
  else delete process.env.OPTIMIZER_HOOK_TOKEN;
  const session = typeof config?.activeSessionId === 'string';
  // Mirrors the runtime's managedProject(): the fast path above already settled tracking, so only approved checks remain.
  const managed = config?.enabled === true && Array.isArray(config.checks) && config.checks.length > 0;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      const prompt = text(input.prompt);
      return prompt?.trim() ? userPromptSubmit(root, prompt) : undefined;
    }
    case 'PreToolUse': {
      return tool && isRecord(input.tool_input) ? preToolUse(root, cwd, tool, input.tool_input, { active: session, managed }) : undefined;
    }
    case 'Stop': return stop(root, text(input.session_id) ?? '', input.stop_hook_active === true, session);
    case 'SubagentStart': return session ? subagentStart(root) : undefined;
    default: return undefined;
  }
}

/** Matches entries written by any install of this hook, including one whose paths have since moved. */
function isOurs(hook: unknown): boolean {
  return isRecord(hook) && typeof hook.command === 'string'
    && (hook.command.includes(script) || /^(?:OPTIMIZER_MODE='[\w-]+' )?OPTIMIZER_BIN='.*' '.*\/claude-hook\.[jt]s'(?: ensure --settings '.*')?$/.test(hook.command));
}

function withoutOurs(hooks: unknown): Record<string, unknown> {
  if (hooks === undefined) return {};
  if (!isRecord(hooks)) throw new Error('settings.hooks must be an object');
  const result: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      result[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const inner = group.hooks.filter((item: unknown) => !isOurs(item));
      if (inner.length === group.hooks.length) return [group];
      return inner.length ? [{ ...group, hooks: inner }] : [];
    });
    if (kept.length || !groups.length) result[event] = kept;
  }
  return result;
}

function runtimeExecutable(): string {
  const configured = process.env.OPTIMIZER_BIN;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('OPTIMIZER_BIN must be an absolute path');
    return configured;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(item => isAbsolute(item))) {
    const candidate = join(directory, 'optimizer');
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error('optimizer executable not found on PATH; install it with `npm install -g @optimizer-layer/runtime`, or set OPTIMIZER_BIN to its absolute path');
}

type Mode = 'opt-in' | 'always-on';

function hookCommand(mode: Mode): string {
  return `OPTIMIZER_MODE=${quote(mode)} OPTIMIZER_BIN=${quote(runtimeExecutable())} ${quote(process.execPath)} ${quote(script)}`;
}

function entries(command: string, path: string): [string, Record<string, unknown>][] {
  const entry = (line: string) => ({ hooks: [{ type: 'command', command: line, timeout: hookTimeoutSeconds }] });
  return [
    ['UserPromptSubmit', entry(command)],
    ['PreToolUse', { matcher: editMatcher, ...entry(command) }],
    ['Stop', entry(command)],
    ['SubagentStart', entry(command)],
    ['SessionStart', { matcher: 'startup|resume', ...entry(`${command} ensure --settings ${quote(path)}`) }],
  ];
}

function readSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const settings: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(settings)) throw new Error('Claude Code settings must be a JSON object');
  return settings;
}

function configure(mode: 'install' | 'uninstall', path: string, hookMode: Mode) {
  const existing = readSettings(path);
  if (mode === 'uninstall' && !existing) return { settings: path, mode, command: null };
  const settings = existing ?? {};
  const hooks = withoutOurs(settings.hooks);
  let command: string | null = null;
  if (mode === 'install') {
    command = hookCommand(hookMode);
    for (const [event, group] of entries(command, path)) {
      const groups = hooks[event];
      hooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    }
  }
  const next: Record<string, unknown> = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  // Keep the first backup: a later install would otherwise overwrite the original with already-merged settings.
  if (existing && !existsSync(`${path}.optimizer-backup`)) copyFileSync(path, `${path}.optimizer-backup`);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic, because ensure can run from several sessions starting at once.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n');
  renameSync(temporary, path);
  return { settings: path, mode, ...(command ? { hookMode } : {}), command };
}

/** SessionStart repair: silent and unchanged when every entry is in place, otherwise a fresh install in the installed mode. */
function ensure(path: string): boolean {
  const settings = readSettings(path);
  const hooks = isRecord(settings?.hooks) ? settings.hooks : {};
  const ours = Object.values(hooks).flatMap(groups => Array.isArray(groups) ? groups : [])
    .filter(group => isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs));
  const installed = ours.flatMap(group => isRecord(group) && Array.isArray(group.hooks) ? group.hooks.filter(isOurs) : [])
    .map(hook => String(isRecord(hook) ? hook.command : ''));
  // An entry without a marker predates install modes and behaved always-on; keep that rather than silently switching.
  const legacy = installed.length > 0 && installed.every(command => !command.startsWith('OPTIMIZER_MODE='));
  const alwaysOn = installed.length > 0 && installed.every(command => command.startsWith("OPTIMIZER_MODE='always-on' "));
  // Unmarked entries predate install modes and behaved always-on; any other or unknown marker repairs as opt-in.
  const mode: Mode = legacy || alwaysOn ? 'always-on' : 'opt-in';
  const expected = entries(hookCommand(mode), path);
  const intact = ours.length === expected.length && expected.every(([event, group]) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some(item => JSON.stringify(item) === JSON.stringify(group));
  });
  if (intact) return false;
  configure('install', path, mode);
  return true;
}

const parsed = parseArgs({ allowPositionals: true, options: { settings: { type: 'string' }, 'always-on': { type: 'boolean' } } });
const [mode, ...extra] = parsed.positionals;
const settingsPath = resolve(parsed.values.settings ?? join(homedir(), '.claude', 'settings.json'));
if (mode === 'ensure') {
  // SessionStart stdout becomes session context, so ensure prints nothing there and never fails the session.
  try {
    if (ensure(settingsPath)) process.stderr.write('optimizer-claude-hook: repaired hook entries\n');
  } catch (error) {
    process.stderr.write(`optimizer-claude-hook: ensure: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
  }
} else if (mode === 'install' || mode === 'uninstall') {
  try {
    if (extra.length) throw new Error('Unexpected positional arguments');
    if (parsed.values['always-on'] && mode !== 'install') throw new Error('--always-on applies only to install');
    // Installed hooks pin this Node.js; an older one would keep running a stale copy of the adapter.
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (mode === 'install' && (major < 24 || (major === 24 && minor < 18))) {
      throw new Error(`Node.js ${process.versions.node} is too old; run the installer with Node.js 24.18 or newer`);
    }
    process.stdout.write(JSON.stringify(configure(mode, settingsPath, parsed.values['always-on'] ? 'always-on' : 'opt-in')) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exitCode = 1;
  }
} else if (mode !== undefined) {
  process.stderr.write('Usage: optimizer-claude-hook install [--always-on] [--settings PATH] | uninstall [--settings PATH] | ensure [--settings PATH]; without a command it handles one Claude Code hook event on stdin.\n');
  process.exitCode = 1;
} else {
  // Never break Claude Code on hook infrastructure errors: fail open with a one-line diagnostic.
  let output: Output;
  try {
    output = hook(readFileSync(0, 'utf8'));
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    process.stderr.write(`optimizer-claude-hook: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
  }
  writeTrace(output);
}

/** Appends one line per invocation of a tracked project; metrics never break a hook or create .optimizer/. */
function writeTrace(output: Output): void {
  // shortcut: invocations outside a session are not attributable, so not written; the file is never rotated, add rotation if it grows large.
  if (!trace.root || !trace.sessionId) return;
  try {
    const directory = join(trace.root, '.optimizer');
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
    const shown = injected(output);
    // performance.now() counts from process start, so Node.js startup is part of the hook's cost.
    const line = { at: new Date().toISOString(), sessionId: trace.sessionId, event: trace.event, elapsedMs: performance.now(), injectedAs: shown.as, injectedBytes: shown.bytes, calls: trace.calls };
    const descriptor = openSync(join(directory, 'hook-metrics.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(descriptor, JSON.stringify(line) + '\n');
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Overhead metrics are best effort.
  }
}
