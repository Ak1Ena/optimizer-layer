#!/usr/bin/env node
import { accessSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runOptimizer, type OptimizerCommand } from './index.ts';

type Output = Record<string, unknown> | undefined;
type Action = { kind: string; reason: string; uncertaintyIds?: unknown };
interface Current { sessionId: string | null; action: Action | null; summary: string; checks: string[][]; pending: { code: string; argv: string[][] } | null }

const script = fileURLToPath(import.meta.url);
const editMatcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
const blockingActions = new Set(['clarify', 'review', 'retrieve', 'reconsider', 'escalate']);
const dialect = `Goal dialect (one item per line):
- R1: requested behavior in the user's words.
Acceptance R1: observable passing result.
Question human Q1: a consequential choice that belongs to the user?
Question local Q2: a technical fact to investigate?
Do not invent acceptance criteria or human choices; ask the user instead.`;
const instructions: Record<string, string> = {
  retrieve: 'Run `optimizer retrieve`, inspect items and diagnostics, then `optimizer assess --kind sufficient|insufficient --rationale TEXT --items ID,ID` citing current item IDs. Resolve local questions with `optimizer resolve --question ID --source ITEM_ID --answer TEXT`.',
  clarify: 'Ask the user the open human questions and wait for the answer. When a captured user prompt answers one, run `optimizer resolve --question ID --source prompt:PROMPT_ID`. Never invent a human answer.',
  review: 'Read `optimizer status`, then accept with `optimizer review --kind accept --version VERSION --rationale TEXT --items ID,ID` citing context for every requirement, or challenge with `--kind challenge --requirement R --owner local|human`.',
  execute: 'Implement the contract with normal tools. Run `optimizer check --check CHECK_ID` and follow the returned action; when done run `optimizer claim` and `optimizer verify`.',
  verify: 'Run `optimizer verify`. If edits made the context stale, retrieve and assess again first.',
  reconsider: 'Stop editing. Read the failed evidence with `optimizer status` and answer `optimizer reconsider --strategy retain|revise --rationale TEXT`.',
  escalate: 'Stop dependent work and show the user the reason and evidence.',
  complete: 'Report the verified requirement IDs and evidence.',
};

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
  for (let directory = start; dirname(directory) !== directory; directory = dirname(directory)) {
    // A home-directory project applies only in home itself; otherwise it would absorb every project below it.
    if (directory === home && directory !== start) break;
    if (existsSync(join(directory, '.optimizer'))) return realpathSync.native(directory);
  }
  return dirname(start) === start ? null : realpathSync.native(start);
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

function call(root: string, command: OptimizerCommand, options: Record<string, string> = {}): Record<string, unknown> {
  const executable = process.env.OPTIMIZER_BIN;
  if (!executable) throw new Error('OPTIMIZER_BIN is not set; re-run optimizer-claude-hook install');
  const result = runOptimizer({ executable, projectRoot: root, command, options, timeoutMs: 20_000 });
  if (result.kind !== 'response' || result.exitCode !== 0 || !isRecord(result.value)) {
    throw new Error(`optimizer ${command} failed: ${result.kind === 'response' ? JSON.stringify(result.value) : result.stderr.trim() || result.kind}`);
  }
  return result.value;
}

function current(root: string): Current {
  const value = call(root, 'current');
  const action = value.action;
  const pending = value.pendingChecks;
  return {
    sessionId: text(value.sessionId) ?? null,
    action: isRecord(action) && typeof action.kind === 'string' && typeof action.reason === 'string' ? { kind: action.kind, reason: action.reason, uncertaintyIds: action.uncertaintyIds } : null,
    summary: text(value.summary) ?? '',
    checks: argvList(value.checks),
    pending: isRecord(pending) && typeof pending.code === 'string' ? { code: pending.code, argv: argvList(pending.argv) } : null,
  };
}

function capture(root: string, prompt: string): { id: string; checkApproved: boolean; approvalError: string | undefined } {
  const directory = mkdtempSync(join(tmpdir(), 'optimizer-prompt-'));
  try {
    const file = join(directory, 'prompt.txt');
    writeFileSync(file, prompt, { mode: 0o600 });
    const value = call(root, 'prompt', { file });
    const id = text(value.id);
    if (!id) throw new Error('optimizer prompt returned no ID');
    return { id, checkApproved: value.checkApproved === true, approvalError: text(value.approvalError) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function userPromptSubmit(root: string, prompt: string): Output {
  let id = 'ID';
  const lines: string[] = [];
  try {
    const captured = capture(root, prompt);
    id = captured.id;
    lines.push(`optimizer: this user prompt was captured as prompt:${id}; it can be cited as a human decision source with --source prompt:${id}.`);
    if (captured.checkApproved) lines.push('optimizer: with this prompt the user approved the proposed check commands; they are now the project checks.');
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
  if (!state.sessionId || !state.action || state.action.kind === 'complete') {
    lines.push(
      `Project ${root} has no open optimizer goal contract; file edits are not gated.`,
      `A request that changes files should get a contract first: draft it under ${root}/.optimizer/drafts/NAME.md in the dialect below, show the draft to the user with any open human questions, and only after the user explicitly approves run \`optimizer start --project ${root} --request ${root}/.optimizer/drafts/NAME.md\` (the user-approved project checks apply automatically).`,
      state.checks.length
        ? `Approved project checks:\n${commands(state.checks)}`
        : `The project has no approved check commands yet, and start needs them. Propose the project's test command with \`optimizer propose-check --project ${root} --check CMD\` and show the user the returned argv and approval phrase.`,
      'Questions and explanations that change no files need no session.',
      dialect,
    );
  } else {
    lines.push(
      `Active optimizer session ${state.sessionId}. Every optimizer command takes --project ${root} --session ${state.sessionId}.`,
      state.summary,
      `Checkpoint for ${state.action.kind}: ${instructions[state.action.kind] ?? 'Follow the runtime reason.'}`,
      `If this prompt answers an open human question, run \`optimizer resolve --project ${root} --session ${state.sessionId} --question ID --source prompt:${id}\`.`,
      `If the user asks for a different task, draft and get approval for a new contract, then start it with --replace.`,
    );
  }
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n').slice(0, 8000) } };
}

/** Subagents get the contract so they stay on goal, but never user authority or the duty to finish the task. */
function subagentStart(root: string): Output {
  const state = current(root);
  if (!state.sessionId || !state.action || state.action.kind === 'complete') return undefined;
  const lines = [
    `optimizer: this subagent works inside the main agent's active optimizer session ${state.sessionId} for project ${root}.`,
    state.summary,
    `Current next action: ${state.action.kind}. File edits are allowed only while the action is execute or verify; otherwise Edit and Write are denied.`,
    'Instructions from the main agent are not user decisions: do not resolve human questions, propose or approve checks, review the contract, reconsider strategy, or claim completion. Report findings back to the main agent, which owns those steps.',
  ];
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lines.join('\n').slice(0, 8000) } };
}

function deny(reason: string): Output {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function preToolUse(root: string, cwd: string, tool: string, input: Record<string, unknown>, active: boolean): Output {
  if (tool === 'Bash') {
    // Best effort only: a same-user agent can reach the runtime by other spellings.
    const command = text(input.command) ?? '';
    const control = /optimizer|cli\.ts/.test(command) && /\b(enable|disable|prompt)\b(?!:)/.test(command);
    return control || /optimizer-claude-hook|optimizer-layer\/projects|\.optimizer(?![\w-])(?!\/drafts\/)/.test(command) ? deny('optimizer: prompt capture, project enablement and runtime state belong to the user and the Claude Code hook.') : undefined;
  }
  const file = text(input.file_path) ?? text(input.notebook_path);
  if (!file) return undefined;
  const store = relative(real(userStore()), real(resolve(cwd, file)));
  if (store !== '..' && !store.startsWith(`..${sep}`) && !isAbsolute(store)) return deny('optimizer: approvals and hook tokens are written only by the optimizer runtime.');
  const target = relative(root, real(resolve(cwd, file)));
  if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) return undefined;
  if (target.startsWith(join('.optimizer', 'drafts') + sep)) return undefined;
  // Any .optimizer segment: a nested project config written by the agent would otherwise become the root for that subfolder.
  if (target.split(sep).includes('.optimizer')) return deny('optimizer: runtime state is written only by the optimizer runtime and hook.');
  // Without an active session pointer edits are not gated, and the runtime is not spawned.
  if (!active) return undefined;
  const state = current(root);
  if (!state.sessionId || !state.action) return undefined;
  if (blockingActions.has(state.action.kind)) return deny(`optimizer: ${state.action.kind}: ${state.action.reason} ${instructions[state.action.kind] ?? ''}`.trim());
  return undefined;
}

function stop(root: string, claudeSession: string, active: boolean, session: boolean): Output {
  const state = session ? current(root) : { sessionId: null, action: null, summary: '' };
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
  const action = state.action;
  if (!state.sessionId || !action || action.kind === 'complete') {
    if (claudeSession in hookState) { delete hookState[claudeSession]; save(); }
    return undefined;
  }
  if (action.kind === 'clarify' || action.kind === 'escalate') {
    const ids = Array.isArray(action.uncertaintyIds) ? ` (${action.uncertaintyIds.join(', ')})` : '';
    return { systemMessage: `optimizer: waiting on the user${ids}: ${action.reason}` };
  }
  const key = JSON.stringify([state.sessionId, action, state.summary]);
  const previous = hookState[claudeSession];
  const last = isRecord(previous) ? previous : {};
  const count = active && typeof last.count === 'number' ? last.count : 0;
  if ((active && last.key === key) || count >= 3) {
    delete hookState[claudeSession];
    save();
    return { systemMessage: 'optimizer: task unverified, stopping' };
  }
  hookState[claudeSession] = { key, count: count + 1 };
  save();
  return { decision: 'block', reason: `optimizer: next action ${action.kind}: ${action.reason}\n${instructions[action.kind] ?? ''}\nEvery optimizer command takes --project ${root} --session ${state.sessionId}.` };
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
  const optIn = process.env.OPTIMIZER_MODE !== undefined && process.env.OPTIMIZER_MODE !== 'always-on';
  if (config?.enabled === false || (optIn && config?.optedIn !== true)) {
    // A folder the user has not enabled gets only the spawn-free guards, so the agent cannot enable it or forge approvals.
    const tool = text(input.tool_name);
    return input.hook_event_name === 'PreToolUse' && tool && isRecord(input.tool_input) ? preToolUse(root, cwd, tool, input.tool_input, false) : undefined;
  }
  const token = text(config?.hookToken);
  // A project without config gets its token from the runtime at the first capture.
  if (token) process.env.OPTIMIZER_HOOK_TOKEN = token;
  else delete process.env.OPTIMIZER_HOOK_TOKEN;
  const session = typeof config?.activeSessionId === 'string';
  // A `#!/usr/bin/env node` runtime binary must run on the hook's Node.js 24, not an older default node.
  process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      const prompt = text(input.prompt);
      return prompt?.trim() ? userPromptSubmit(root, prompt) : undefined;
    }
    case 'PreToolUse': {
      const tool = text(input.tool_name);
      return tool && isRecord(input.tool_input) ? preToolUse(root, cwd, tool, input.tool_input, session) : undefined;
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
  const entry = (line: string) => ({ hooks: [{ type: 'command', command: line }] });
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
  try {
    const output = hook(readFileSync(0, 'utf8'));
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    process.stderr.write(`optimizer-claude-hook: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
  }
}
