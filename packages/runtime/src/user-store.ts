import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseProjectConfig, type ProjectConfig } from './schema.ts';

/**
 * Per-user trust anchor. Hook tokens, approvals and the disabled flag live outside the project,
 * because anything in the project (including .optimizer/) can be committed by a repository author.
 */
export function userStoreDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(homedir(), '.config'), 'optimizer-layer');
}

export function canonicalRoot(projectRoot: string): string {
  // native realpath canonicalizes letter case, matching the hook's project root.
  return realpathSync.native(projectRoot);
}

export function configPath(projectRoot: string): string {
  const root = canonicalRoot(projectRoot);
  return join(userStoreDirectory(), 'projects', `${createHash('sha256').update(root).digest('hex')}.json`);
}

export function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function readProjectConfig(projectRoot: string): ProjectConfig | null {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Project config must not be a symlink');
  const config = parseProjectConfig(JSON.parse(readFileSync(path, 'utf8')));
  if (config.projectRoot !== canonicalRoot(projectRoot)) throw new Error('Project config belongs to another project');
  return config;
}

export function writeProjectConfig(projectRoot: string, config: ProjectConfig): void {
  if (config.projectRoot !== canonicalRoot(projectRoot)) throw new Error('Project config belongs to another project');
  writeAtomic(configPath(projectRoot), parseProjectConfig(config));
}

/** Binds a prompt-log row to the user-store token, so rows written into the repository carry no authority. */
export function promptMac(token: string, row: { id: string; projectRoot: string; role: string; content: string; timestamp: string }): string {
  return createHmac('sha256', token).update(JSON.stringify([row.id, row.projectRoot, row.role, row.content, row.timestamp])).digest('hex');
}

export function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
