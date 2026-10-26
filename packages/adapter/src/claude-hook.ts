#!/usr/bin/env node
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runOptimizer, type OptimizerCommand } from './index.ts';

type Output = Record<string, unknown> | undefined;
type Action = { kind: string; reason: string; uncertaintyIds?: unknown };
interface Current { sessionId: string | null; action: Action | null; summary: string }

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

function findRoot(cwd: string): string | null {
  const home = homedir();
  for (let directory = resolve(cwd); directory !== home; directory = dirname(directory)) {
    if (existsSync(join(directory, '.optimizer', 'project.json'))) return realpathSync.native(directory);
    if (dirname(directory) === directory) return null;
  }
  return null;
}

function hookToken(root: string): string | null {
  try {
    const config: unknown = JSON.parse(readFileSync(join(root, '.optimizer', 'project.json'), 'utf8'));
    return isRecord(config) && config.enabled === true ? text(config.hookToken) ?? null : null;
  } catch {
    return null;
  }
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
  return {
    sessionId: text(value.sessionId) ?? null,
    action: isRecord(action) && typeof action.kind === 'string' && typeof action.reason === 'string' ? { kind: action.kind, reason: action.reason, uncertaintyIds: action.uncertaintyIds } : null,
    summary: text(value.summary) ?? '',
  };
}

function capture(root: string, prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'optimizer-prompt-'));
  try {
    const file = join(directory, 'prompt.txt');
    writeFileSync(file, prompt, { mode: 0o600 });
    const id = text(call(root, 'prompt', { file }).id);
    if (!id) throw new Error('optimizer prompt returned no ID');
    return id;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function userPromptSubmit(root: string, prompt: string): Output {
  let id = 'ID';
  const lines: string[] = [];
  try {
    id = capture(root, prompt);
    lines.push(`optimizer: this user prompt was captured as prompt:${id}; it can be cited as a human decision source with --source prompt:${id}.`);
  } catch (error) {
    process.stderr.write(`optimizer-claude-hook: ${error instanceof Error ? error.message : String(error)}\n`.replaceAll(/\n(?!$)/g, ' '));
    lines.push('optimizer: this prompt could not be captured, so it cannot be cited as a human decision.');
  }
  const state = current(root);
  if (!state.sessionId || !state.action || state.action.kind === 'complete') {
    lines.push(
      `Project ${root} is optimizer-enabled and has no open goal contract.`,
      `A request that changes files needs a contract first: draft it under ${root}/.optimizer/drafts/NAME.md in the dialect below, show the draft to the user with any open human questions, and only after the user explicitly approves run \`optimizer start --project ${root} --request ${root}/.optimizer/drafts/NAME.md\` (the user-approved project checks apply automatically).${state.sessionId ? '' : ' File edits outside drafts are denied until then.'}`,
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

function deny(reason: string): Output {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function preToolUse(root: string, cwd: string, tool: string, input: Record<string, unknown>): Output {
  if (tool === 'Bash') {
    // Best effort only: a same-user agent can reach the runtime by other spellings.
    const command = text(input.command) ?? '';
    const control = /optimizer|cli\.ts/.test(command) && /\b(enable|disable|prompt)\b(?!:)/.test(command);
    return control || /optimizer-claude-hook|\.optimizer(?![\w-])(?!\/drafts\/)/.test(command) ? deny('optimizer: prompt capture, project enablement and runtime state belong to the user and the Claude Code hook.') : undefined;
  }
  const file = text(input.file_path) ?? text(input.notebook_path);
  if (!file) return undefined;
  const target = relative(root, real(resolve(cwd, file)));
  if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) return undefined;
  if (target.startsWith(join('.optimizer', 'drafts') + sep)) return undefined;
  if (target === '.optimizer' || target.startsWith(`.optimizer${sep}`)) return deny('optimizer: runtime state is written only by the optimizer runtime and hook.');
  const state = current(root);
  if (!state.sessionId || !state.action) return deny('No approved goal contract; draft it and get user approval first.');
  if (blockingActions.has(state.action.kind)) return deny(`optimizer: ${state.action.kind}: ${state.action.reason} ${instructions[state.action.kind] ?? ''}`.trim());
  return undefined;
}

function stop(root: string, claudeSession: string, active: boolean): Output {
  const state = current(root);
  const statePath = join(root, '.optimizer', 'hook-state.json');
  let hookState: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    if (isRecord(parsed)) hookState = parsed;
  } catch {
    // Missing or corrupt loop-guard state starts a fresh count.
  }
  const save = () => writeFileSync(statePath, JSON.stringify(hookState) + '\n', { mode: 0o600 });
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
  const root = findRoot(cwd);
  if (!root) return undefined;
  const token = hookToken(root);
  if (!token) return undefined;
  process.env.OPTIMIZER_HOOK_TOKEN = token;
  // A `#!/usr/bin/env node` runtime binary must run on the hook's Node.js 24, not an older default node.
  process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      const prompt = text(input.prompt);
      return prompt?.trim() ? userPromptSubmit(root, prompt) : undefined;
    }
    case 'PreToolUse': {
      const tool = text(input.tool_name);
      return tool && isRecord(input.tool_input) ? preToolUse(root, cwd, tool, input.tool_input) : undefined;
    }
    case 'Stop': return stop(root, text(input.session_id) ?? '', input.stop_hook_active === true);
    default: return undefined;
  }
}

function isOurs(hook: unknown): boolean {
  return isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(script);
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
  throw new Error('optimizer executable not found on PATH; set OPTIMIZER_BIN to its absolute path');
}

function configure(mode: 'install' | 'uninstall', path: string) {
  const exists = existsSync(path);
  if (mode === 'uninstall' && !exists) return { settings: path, mode, command: null };
  const settings: unknown = exists ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!isRecord(settings)) throw new Error('Claude Code settings must be a JSON object');
  const hooks = withoutOurs(settings.hooks);
  let command: string | null = null;
  if (mode === 'install') {
    command = `OPTIMIZER_BIN=${quote(runtimeExecutable())} ${quote(process.execPath)} ${quote(script)}`;
    const entry = { hooks: [{ type: 'command', command }] };
    for (const [event, group] of [['UserPromptSubmit', entry], ['PreToolUse', { matcher: editMatcher, ...entry }], ['Stop', entry]] as const) {
      const groups = hooks[event];
      hooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    }
  }
  const next: Record<string, unknown> = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  // Keep the first backup: a later install would otherwise overwrite the original with already-merged settings.
  if (exists && !existsSync(`${path}.optimizer-backup`)) copyFileSync(path, `${path}.optimizer-backup`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return { settings: path, mode, command };
}

const parsed = parseArgs({ allowPositionals: true, options: { settings: { type: 'string' } } });
const [mode, ...extra] = parsed.positionals;
if (mode === 'install' || mode === 'uninstall') {
  try {
    if (extra.length) throw new Error('Unexpected positional arguments');
    const settings = resolve(parsed.values.settings ?? join(homedir(), '.claude', 'settings.json'));
    process.stdout.write(JSON.stringify(configure(mode, settings)) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exitCode = 1;
  }
} else if (mode !== undefined) {
  process.stderr.write('Usage: optimizer-claude-hook [install|uninstall] [--settings PATH]; without a command it handles one Claude Code hook event on stdin.\n');
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
