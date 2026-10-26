import { randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { appendCapturedPrompt } from './context.ts';
import { parseChecks, parseRegistry, type ProjectConfig } from './schema.ts';
import { canonicalRoot, readProjectConfig, sameSecret, userStoreDirectory, writeAtomic, writeProjectConfig } from './user-store.ts';

export { readProjectConfig, writeProjectConfig } from './user-store.ts';
import { registerArtifacts } from './verification.ts';
import type { NextAction, SessionState } from './types.ts';

export function registryPath(): string {
  return join(userStoreDirectory(), 'projects.json');
}

export function registeredProjects(): string[] {
  try {
    return parseRegistry(JSON.parse(readFileSync(registryPath(), 'utf8'))).projects;
  } catch {
    // A missing or corrupt registry is rebuilt from scratch.
    return [];
  }
}

function registerProject(root: string): void {
  const projects = registeredProjects();
  if (projects.includes(root)) return;
  writeAtomic(registryPath(), { projects: [...projects, root] });
}

/** Keep runtime state out of `git status` through the repository's untracked exclude file, never a tracked .gitignore. */
export function excludeFromGit(root: string): void {
  for (let directory = root; ; directory = dirname(directory)) {
    const dotGit = join(directory, '.git');
    if (existsSync(dotGit)) {
      let gitDirectory = dotGit;
      if (statSync(dotGit).isFile()) {
        // Worktrees and submodules point to their git directory; worktrees share the main exclude file.
        const target = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
        if (!target) return;
        gitDirectory = resolve(directory, target.trim());
        const common = join(gitDirectory, 'commondir');
        if (existsSync(common)) gitDirectory = resolve(gitDirectory, readFileSync(common, 'utf8').trim());
      }
      const exclude = join(gitDirectory, 'info', 'exclude');
      if (existsSync(exclude) && lstatSync(exclude).isSymbolicLink()) return;
      const content = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (content.split('\n').some(line => line.trim() === '.optimizer/')) return;
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${content && !content.endsWith('\n') ? '\n' : ''}.optimizer/\n`);
      return;
    }
    if (dirname(directory) === directory) return;
  }
}

/** Any folder is a project: its user-store config and hook token are created on first use. */
function loadOrCreate(root: string): ProjectConfig {
  const existing = readProjectConfig(root);
  if (existing) return existing;
  if (dirname(root) === root) throw new Error('The filesystem root cannot be an optimizer project');
  // Side effects first, so a failure is retried on the next use instead of leaving an unregistered project.
  excludeFromGit(root);
  registerProject(root);
  const config: ProjectConfig = { projectRoot: root, enabled: true, hookToken: randomBytes(32).toString('hex'), checks: [], activeSessionId: null, pendingChecks: null, pendingChange: null };
  writeProjectConfig(root, config);
  return config;
}

/** Split a user-typed check command into argv without a shell; shell syntax is rejected, never interpreted. */
export function commandArgv(command: string, projectRoot: string): [string, ...string[]] {
  if (/[|;&$><`]/.test(command)) throw new Error(`Check command must not contain shell metacharacters (|;&$><\`): ${command}`);
  const argv: string[] = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(`Unbalanced quote in check command: ${command}`);
  if (started) argv.push(current);
  const [name, ...args] = argv;
  if (!name) throw new Error('Check command is empty');
  const candidates = name.includes('/')
    ? [resolve(projectRoot, name)]
    : (process.env.PATH ?? '').split(delimiter).filter(directory => isAbsolute(directory)).map(directory => join(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return [candidate, ...args];
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Check executable not found: ${name}`);
}

/** The same rules as a user-typed command, re-applied to stored argv before it is used. */
export function assertSafeArgv(argv: readonly string[]): void {
  const [name] = argv;
  if (argv.some(item => /[|;&$><`]/.test(item))) throw new Error('Stored check argv must not contain shell metacharacters; approve it again with `optimizer propose-check`');
  let executable = false;
  try {
    accessSync(name ?? '', constants.X_OK);
    executable = isAbsolute(name ?? '') && statSync(name ?? '').isFile();
  } catch {
    executable = false;
  }
  if (!executable) throw new Error(`Stored check executable is not an absolute executable file: ${name ?? '(missing)'}`);
}

function checkDefinitions(commands: string[], root: string, timeoutMs: number) {
  return parseChecks(commands.map((command, index) => ({
    id: `check-${index + 1}`, requirementIds: ['*'], argv: commandArgv(command, root), timeoutMs,
  })));
}

function enableCommands(root: string, input: { commands: string[]; yes: boolean }): { commands: string[]; suggestion: string | undefined } {
  let commands = input.commands;
  let suggestion: string | undefined;
  if (!commands.length) {
    const manifest = join(root, 'package.json');
    const parsed: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null;
    const scripts = typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : null;
    const hasTest = typeof scripts === 'object' && scripts !== null && 'test' in scripts && typeof scripts.test === 'string';
    if (hasTest && input.yes) commands = ['npm test'];
    else if (hasTest) suggestion = "Re-run with --yes to approve --check 'npm test' (from package.json scripts.test), or let the agent propose a check.";
  }
  return { commands, suggestion };
}

/** Direct enable: library callers and a user at an interactive terminal. Non-interactive callers use requestProjectChange. */
export function enableProject(projectRoot: string, input: { commands: string[]; timeoutMs: number; yes: boolean }) {
  const root = canonicalRoot(projectRoot);
  const { commands, suggestion } = enableCommands(root, input);
  // Validate checks before creating any state, so a rejected command leaves nothing behind.
  const approved = commands.length ? checkDefinitions(commands, root, input.timeoutMs).map(check => registerArtifacts(root, check)) : null;
  const config = loadOrCreate(root);
  // Subfolder sessions resolve to the nearest ancestor with .optimizer/, so an enabled root must have one.
  runtimeDirectory(root);
  // Without --check the project is enabled with its current checks; the agent proposes one and the user approves it by code.
  const checks = approved ?? config.checks;
  writeProjectConfig(root, { ...config, enabled: true, optedIn: true, checks, pendingChecks: commands.length ? null : config.pendingChecks, pendingChange: null });
  return { projectRoot: root, enabled: true, checks: checks.map(({ id, argv, timeoutMs }) => ({ id, argv, timeoutMs })), ...(suggestion ? { suggestion } : {}) };
}

function runtimeDirectory(root: string): void {
  const directory = join(root, '.optimizer');
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Runtime directory must not be a symlink');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

/** The agent proposes; only a hook-captured user prompt quoting the code activates (see capturePrompt). */
export function proposeChecks(projectRoot: string, input: { commands: string[]; timeoutMs: number }) {
  const root = canonicalRoot(projectRoot);
  if (!input.commands.length) throw new Error('--check is required');
  const definitions = checkDefinitions(input.commands, root, input.timeoutMs);
  // Fail at proposal time, not when the user's approval prompt arrives.
  for (const definition of definitions) registerArtifacts(root, definition);
  const checks = definitions.map(({ artifactFiles: _, ...check }) => check);
  const config = loadOrCreate(root);
  if (!config.enabled) throw new Error('Project is disabled');
  const code = randomBytes(2).toString('hex');
  writeProjectConfig(root, { ...config, pendingChecks: { code, checks } });
  return { projectRoot: root, code, approval: `approve check ${code}`, checks: checks.map(({ id, argv, timeoutMs }) => ({ id, argv, timeoutMs })) };
}

export function disableProject(projectRoot: string) {
  const root = canonicalRoot(projectRoot);
  writeProjectConfig(root, { ...loadOrCreate(root), enabled: false, pendingChange: null });
  return { projectRoot: root, enabled: false };
}

/**
 * Without a human at a terminal, enable/disable (and the checks enable would approve) only become a pending request.
 * Like a check proposal, only a hook-captured user prompt quoting `approve KIND CODE` applies it (see capturePrompt).
 */
export function requestProjectChange(projectRoot: string, kind: 'enable' | 'disable', input: { commands: string[]; timeoutMs: number; yes: boolean }) {
  const root = canonicalRoot(projectRoot);
  let checks: ReturnType<typeof checkDefinitions> | null = null;
  if (kind === 'enable') {
    const { commands } = enableCommands(root, input);
    if (commands.length) {
      checks = checkDefinitions(commands, root, input.timeoutMs);
      for (const definition of checks) registerArtifacts(root, definition);
    }
  }
  const config = loadOrCreate(root);
  const code = randomBytes(2).toString('hex');
  const pendingChecks = checks ? checks.map(({ artifactFiles: _, ...check }) => check) : null;
  writeProjectConfig(root, { ...config, pendingChange: { code, kind, checks: pendingChecks } });
  return {
    projectRoot: root, pending: kind, code, approval: `approve ${kind} ${code}`,
    ...(pendingChecks ? { checks: pendingChecks.map(({ id, argv, timeoutMs }) => ({ id, argv, timeoutMs })) } : {}),
    message: `Not applied: no interactive terminal. Type \`approve ${kind} ${code}\` as your next Claude Code message to apply it, or run the command again in a terminal.`,
  };
}

function approvalCodes(content: string): string[] {
  return [...content.matchAll(/\bapprove\s+check\s+([0-9a-f]{4})\b/gi)].map(match => (match[1] ?? '').toLowerCase());
}

export function capturePrompt(projectRoot: string, content: string, token: string | undefined) {
  const root = canonicalRoot(projectRoot);
  const existing = readProjectConfig(root);
  // The first capture creates the user-store token, so only a same-user process can make it; repository content never supplies one.
  const config = existing ?? loadOrCreate(root);
  if (existing && !sameSecret(token ?? '', config.hookToken)) throw new Error('prompt requires the hook token');
  const change = config.pendingChange;
  const changeApproved = change !== null && new RegExp(`\\bapprove\\s+${change.kind}\\s+${change.code}\\b`, 'i').test(content);
  // A disabled project still accepts the one prompt that approves re-enabling it.
  if (!config.enabled && !changeApproved) throw new Error('Project is disabled');
  runtimeDirectory(root);
  const id = appendCapturedPrompt(root, content, config.hookToken);
  if (change && changeApproved) {
    try {
      if (change.kind === 'disable') {
        writeProjectConfig(root, { ...config, enabled: false, pendingChange: null });
      } else {
        const checks = change.checks ? parseChecks(change.checks).map(check => registerArtifacts(root, check)) : config.checks;
        writeProjectConfig(root, { ...config, enabled: true, optedIn: true, checks, pendingChecks: change.checks ? null : config.pendingChecks, pendingChange: null });
      }
      return { id, checkApproved: false, changeApproved: change.kind };
    } catch (error) {
      return { id, checkApproved: false, approvalError: error instanceof Error ? error.message : String(error) };
    }
  }
  const pending = config.pendingChecks;
  if (pending === null || !approvalCodes(content).includes(pending.code)) return { id, checkApproved: false };
  // The prompt row is already recorded; a failed activation must not lose it.
  try {
    const checks = parseChecks(pending.checks).map(check => registerArtifacts(root, check));
    writeProjectConfig(root, { ...config, checks, pendingChecks: null });
    return { id, checkApproved: true };
  } catch (error) {
    return { id, checkApproved: false, approvalError: error instanceof Error ? error.message : String(error) };
  }
}

/** What hooks and the dashboard may show about a project; the hook token never leaves the config file. */
export function projectView(config: ProjectConfig | null) {
  return {
    enabled: config?.enabled ?? true,
    checks: (config?.checks ?? []).map(check => check.argv),
    pendingChecks: config?.pendingChecks ? { code: config.pendingChecks.code, argv: config.pendingChecks.checks.map(check => check.argv) } : null,
    activeSessionId: config?.activeSessionId ?? null,
  };
}

export function sessionSummary(state: SessionState, action: NextAction): string {
  const lines = [`Session ${state.id}, goal version ${state.goal.version}.`];
  for (const requirement of state.goal.requirements) {
    lines.push(`${requirement.id}: ${requirement.statement} | Acceptance: ${requirement.acceptance || '(missing)'}`);
  }
  const open = state.goal.uncertainties.filter(question => question.resolution.kind === 'open');
  lines.push(`Open questions: ${open.length ? '' : 'none'}`);
  for (const question of open) lines.push(`${question.id} (${question.owner}): ${question.question}`);
  lines.push(`Review: ${state.review.kind}${state.review.kind === 'pending' ? '' : ` for version ${state.review.goalVersion}`}`);
  lines.push(`Control: ${state.control.kind}${state.control.kind === 'running' ? '' : ` (${state.control.reason})`}`);
  const last = state.evidence.at(-1);
  lines.push(`Last check: ${last ? `${last.checkId} ${last.result.outcome}` : 'none'}`);
  lines.push(`Next action: ${action.kind}: ${action.reason}`);
  const text = lines.join('\n');
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}
