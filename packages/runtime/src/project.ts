import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { appendCapturedPrompt } from './context.ts';
import { parseChecks, parseProjectConfig, type ProjectConfig } from './schema.ts';
import { registerArtifacts } from './verification.ts';
import type { NextAction, SessionState } from './types.ts';

function configPath(projectRoot: string): string {
  return join(realpathSync(projectRoot), '.optimizer', 'project.json');
}

export function readProjectConfig(projectRoot: string): ProjectConfig | null {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Project config must not be a symlink');
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseProjectConfig(input);
}

export function writeProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const path = configPath(projectRoot);
  const directory = join(realpathSync(projectRoot), '.optimizer');
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Runtime directory must not be a symlink');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(parseProjectConfig(config), null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
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

export function enableProject(projectRoot: string, input: { commands: string[]; timeoutMs: number; yes: boolean }) {
  const root = realpathSync(projectRoot);
  let commands = input.commands;
  if (!commands.length) {
    const manifest = join(root, 'package.json');
    const parsed: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null;
    const scripts = typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : null;
    const hasTest = typeof scripts === 'object' && scripts !== null && 'test' in scripts && typeof scripts.test === 'string';
    if (!hasTest) throw new Error('--check is required');
    if (!input.yes) throw new Error("No --check given. Proposed: --check 'npm test' (from package.json scripts.test). Re-run with --yes to accept it.");
    commands = ['npm test'];
  }
  const checks = parseChecks(commands.map((command, index) => ({
    id: `check-${index + 1}`, requirementIds: ['*'], argv: commandArgv(command, root), timeoutMs: input.timeoutMs,
  }))).map(check => registerArtifacts(root, check));
  const previous = readProjectConfig(root);
  writeProjectConfig(root, {
    enabled: true, hookToken: previous?.hookToken ?? randomBytes(32).toString('hex'), checks, activeSessionId: previous?.activeSessionId ?? null,
  });
  return { projectRoot: root, enabled: true, checks: checks.map(({ id, argv, timeoutMs }) => ({ id, argv, timeoutMs })) };
}

export function disableProject(projectRoot: string) {
  const config = readProjectConfig(projectRoot);
  if (!config) throw new Error('Project is not enabled');
  writeProjectConfig(projectRoot, { ...config, enabled: false });
  return { projectRoot: realpathSync(projectRoot), enabled: false };
}

export function capturePrompt(projectRoot: string, content: string, token: string | undefined) {
  const config = readProjectConfig(projectRoot);
  if (!config?.enabled) throw new Error('Project is not enabled');
  const expected = Buffer.from(config.hookToken);
  const actual = Buffer.from(token ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('prompt requires the hook token');
  return { id: appendCapturedPrompt(projectRoot, content) };
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
