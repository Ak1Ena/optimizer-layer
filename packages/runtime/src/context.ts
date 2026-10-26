import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, writeSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContextItem, ContextSnapshot, Decision, Goal } from './types.ts';

const excludedDirectories = new Set([
  '.git', '.optimizer', 'node_modules', '.aws', '.codex', '.agents',
  '.venv', 'venv', '.yarn', '.pnpm-store', 'vendor',
]);
const maxFiles = 1000;
const maxScanEntries = 5000;
const maxDigestEntries = 10000;
const maxDigestBytes = 128 * 1024 * 1024;
const maxFileBytes = 256 * 1024;
const maxTextBytes = 4 * 1024 * 1024;
const maxItems = 200;
const maxTranscriptBytes = 4 * 1024 * 1024;
const stopWords = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'should',
  'shall', 'when', 'then', 'each', 'every', 'support', 'returns', 'return',
  'have', 'has', 'are', 'not', 'can', 'will', 'acceptance',
]);

function digestFile(path: string, byteLimit = maxDigestBytes): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    let bytes = 0;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > byteLimit) throw new Error('Project digest byte limit reached');
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function readSource(path: string, byteLimit: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > byteLimit) throw new Error('Source size limit reached');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function excluded(name: string): boolean {
  return excludedDirectories.has(name) || name.startsWith('.env') || name.endsWith('.env');
}

function rootPath(projectRoot: string): string {
  const root = realpathSync(projectRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('Project root must be a directory');
  return root;
}

function assertNoSymlinks(path: string): void {
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink source is not permitted: ${path}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

interface ProjectFile { path: string; size: number; }
interface Scan {
  files: ProjectFile[];
  diagnostics: string[];
  complete: boolean;
  limited: boolean;
}

function scanProject(root: string, fileLimit: number, entryLimit: number): Scan {
  const scan: Scan = { files: [], diagnostics: [], complete: true, limited: false };
  let entries = 0;
  function limit(message: string): void {
    scan.complete = false;
    scan.limited = true;
    scan.diagnostics.push(message);
  }
  function directoryEntries(path: string): Dirent[] {
    const directory = opendirSync(path);
    const children: Dirent[] = [];
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (excluded(entry.name)) continue;
        if (++entries > entryLimit) {
          limit(`Directory entry count limit reached (${entryLimit})`);
          break;
        }
        children.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    return children.sort((left, right) => left.name.localeCompare(right.name));
  }
  function visit(directory: string, depth: number): void {
    if (depth > 64) {
      limit('Directory depth limit reached');
      return;
    }
    const children = directoryEntries(directory);
    for (const entry of children) {
      if (scan.limited) return;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        scan.diagnostics.push(`Skipped symlink: ${relative(root, path)}`);
        scan.complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        scan.diagnostics.push(`Skipped unsupported file: ${relative(root, path)}`);
        scan.complete = false;
        continue;
      }
      if (scan.files.length === fileLimit) {
        limit(`File count limit reached (${fileLimit})`);
        return;
      }
      scan.files.push({ path, size: lstatSync(path).size });
    }
  }
  visit(root, 0);
  return scan;
}

/** Hash all eligible files within explicit limits; never accept a partial project digest. */
export function projectDigest(projectRoot: string): string {
  const root = rootPath(projectRoot);
  const scan = scanProject(root, maxDigestEntries, maxDigestEntries);
  if (scan.limited) throw new Error(`Project digest scan limit: ${scan.diagnostics.join('; ')}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of scan.files) {
    if (file.size > maxDigestBytes - bytes) throw new Error('Project digest byte limit reached');
    const digest = digestFile(file.path, maxDigestBytes - bytes);
    bytes += file.size;
    // JSON preserves path/content boundaries without depending on filename delimiters.
    hash.update(JSON.stringify([relative(root, file.path), digest]) + '\n');
  }
  return hash.digest('hex');
}

function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return [...new Set(words.filter(word => !stopWords.has(word)))];
}

function requirementLinks(text: string, goal: Goal): string[] {
  const lower = text.toLowerCase();
  return goal.requirements.filter(requirement => {
    const keywords = terms(`${requirement.statement} ${requirement.acceptance}`);
    return keywords.some(keyword => lower.includes(keyword));
  }).map(requirement => requirement.id);
}

function activeDecisions(decisions: Decision[]): Decision[] {
  const superseded = new Set(decisions.flatMap(decision => decision.supersedes));
  return decisions.filter(decision => !superseded.has(decision.id));
}

function appendItem(context: ContextSnapshot, item: ContextItem): void {
  if (context.items.length < maxItems) {
    context.items.push(item);
    return;
  }
  context.complete = false;
  if (!context.diagnostics.includes('Context item limit reached')) {
    context.diagnostics.push('Context item limit reached');
  }
}

function retrieveFile(file: ProjectFile, root: string, goal: Goal, context: ContextSnapshot, retrievedAt: string): void {
  const buffer = readSource(file.path, maxFileBytes);
  let content: string;
  try {
    if (buffer.includes(0)) throw new Error('Binary');
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    context.diagnostics.push(`Skipped unsupported binary: ${relative(root, file.path)}`);
    return;
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  const document = /\.(md|txt|rst|adoc|jsonl?|ya?ml|toml)$/i.test(file.path);
  const base = {
    kind: document ? 'document' : 'code',
    path: file.path,
    digest,
    retrievedAt,
    authority: 'untrusted',
  } satisfies Pick<ContextItem, 'kind' | 'path' | 'digest' | 'retrievedAt' | 'authority'>;
  const matches: ContextItem[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const excerpt = line.slice(0, 1000);
    const requirementIds = requirementLinks(excerpt, goal);
    if (!requirementIds.length) continue;
    matches.push({
      ...base,
      id: `file:${relative(root, file.path)}:${index + 1}:${digest}`,
      line: index + 1,
      excerpt,
      requirementIds,
    });
  }
  const pathLinks = requirementLinks(relative(root, file.path), goal).filter(id => {
    return !matches.some(item => item.requirementIds.includes(id));
  });
  const firstLine = lines.findIndex(line => line.trim()) + 1;
  if (pathLinks.length && firstLine > 0) {
    const existing = matches.find(item => item.line === firstLine);
    if (existing) existing.requirementIds.push(...pathLinks);
    else matches.unshift({
      ...base,
      id: `file:${relative(root, file.path)}:${firstLine}:${digest}`,
      line: firstLine,
      excerpt: (lines[firstLine - 1] ?? '').slice(0, 1000),
      requirementIds: pathLinks,
    });
  }
  for (const item of matches) appendItem(context, item);
}

function sameDecision(left: Decision, right: Decision): boolean {
  return left.id === right.id && left.text === right.text && left.source === right.source
    && left.line === right.line && left.digest === right.digest && left.timestamp === right.timestamp
    && left.role === right.role && left.supersedes.length === right.supersedes.length
    && left.supersedes.every(id => right.supersedes.includes(id));
}

function retrieveDecisions(root: string, goal: Goal, decisions: Decision[], context: ContextSnapshot, retrievedAt: string): void {
  const transcripts = new Map<string, Map<string, Decision>>();
  for (const decision of activeDecisions(decisions)) {
    try {
      if (!isAbsolute(decision.source)) throw new Error('Decision source must be absolute');
      // Authority comes from the transcript, not the caller's Decision object.
      let transcript = transcripts.get(decision.source);
      if (!transcript) {
        transcript = new Map(sourceDecisions(root, decision.source).map(candidate => [candidate.id, candidate]));
        transcripts.set(decision.source, transcript);
      }
      const verified = transcript.get(decision.id);
      if (!verified || !sameDecision(verified, decision)) {
        throw new Error('Decision does not match its transcript');
      }
      appendItem(context, {
        id: `decision:${decision.id}`,
        kind: 'decision',
        path: decision.source,
        line: decision.line,
        excerpt: decision.text,
        digest: decision.digest,
        retrievedAt,
        requirementIds: requirementLinks(decision.text, goal),
        authority: 'user-decision',
      });
    } catch (error) {
      context.complete = false;
      const reason = error instanceof Error ? error.message : String(error);
      context.diagnostics.push(`Invalid decision ${decision.id}: ${reason}`);
    }
  }
}

export function retrieveContext(projectRoot: string, goal: Goal, decisions: Decision[]): ContextSnapshot {
  const root = rootPath(projectRoot);
  const scan = scanProject(root, maxFiles, maxScanEntries);
  const context: ContextSnapshot = {
    items: [],
    uncoveredRequirementIds: [],
    diagnostics: scan.diagnostics,
    complete: scan.complete,
    projectDigest: '',
  };
  try {
    context.projectDigest = projectDigest(root);
  } catch (error) {
    context.complete = false;
    context.diagnostics.push(error instanceof Error ? error.message : String(error));
    context.uncoveredRequirementIds = goal.requirements.map(requirement => requirement.id);
    return context;
  }
  const retrievedAt = new Date().toISOString();
  let bytes = 0;
  for (const file of scan.files) {
    if (file.size > maxFileBytes) {
      context.complete = false;
      context.diagnostics.push(`File size limit: ${relative(root, file.path)}`);
      continue;
    }
    bytes += file.size;
    if (bytes > maxTextBytes) {
      context.complete = false;
      context.diagnostics.push(`Text byte limit reached (${maxTextBytes})`);
      break;
    }
    retrieveFile(file, root, goal, context, retrievedAt);
  }
  retrieveDecisions(root, goal, decisions, context, retrievedAt);
  context.uncoveredRequirementIds = goal.requirements.filter(requirement => {
    return !context.items.some(item => item.requirementIds.includes(requirement.id));
  }).map(requirement => requirement.id);
  // Detect edits during retrieval instead of accepting a mixed-source snapshot.
  if (projectDigest(root) !== context.projectDigest) {
    context.complete = false;
    context.diagnostics.push('Project changed during retrieval');
  }
  return context;
}

interface ConversationRow {
  id: string;
  projectRoot: string;
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  content: string;
  timestamp: string;
  supersedes: string[];
}

function parseRow(value: unknown): ConversationRow {
  if (typeof value !== 'object' || value === null) throw new Error('Conversation row must be an object');
  if (!('id' in value) || typeof value.id !== 'string' || !value.id.trim()) throw new Error('Conversation ID is required');
  if (!('projectRoot' in value) || typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot)) throw new Error('Absolute conversation projectRoot is required');
  if (!('content' in value) || typeof value.content !== 'string') throw new Error('Conversation content must be a string');
  if (!('timestamp' in value) || typeof value.timestamp !== 'string') throw new Error('Conversation timestamp is required');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp))) throw new Error('Conversation timestamp must be an ISO date');
  if (!('role' in value)) throw new Error('Conversation role is required');
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system' && value.role !== 'developer' && value.role !== 'tool') throw new Error('Unknown conversation role');
  const supersedes: string[] = [];
  if ('supersedes' in value) {
    if (!Array.isArray(value.supersedes)) throw new Error('Malformed supersedes IDs');
    const inputIds: unknown[] = value.supersedes;
    for (const id of inputIds) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('Malformed supersedes ID');
      if (!supersedes.includes(id)) supersedes.push(id);
    }
  }
  return {
    id: value.id,
    projectRoot: value.projectRoot,
    role: value.role,
    content: value.content,
    timestamp: value.timestamp,
    supersedes,
  };
}

function decisionTexts(content: string): string[] {
  return content.split(/\r?\n/).flatMap(line => {
    const match = /^\s*Decision:\s*(\S.*)\s*$/.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

export function importConversation(projectRoot: string, path: string): Decision[] {
  const root = rootPath(projectRoot);
  const source = resolve(path);
  assertNoSymlinks(source);
  const info = lstatSync(source);
  if (!info.isFile() || info.size > maxTranscriptBytes) throw new Error('Transcript must be a regular file within the transcript size limit');
  const buffer = readSource(source, maxTranscriptBytes);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const digest = createHash('sha256').update(buffer).digest('hex');
  const decisions: Decision[] = [];
  const rows = new Set<string>();
  const extractedIds = new Map<string, string[]>();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    const row = parseRow(value);
    if (rootPath(row.projectRoot) !== root) throw new Error(`Cross-project conversation row at line ${index + 1}`);
    if (rows.has(row.id)) throw new Error(`Duplicate conversation ID: ${row.id}`);
    rows.add(row.id);
    if (row.role !== 'user') continue;
    const texts = decisionTexts(row.content);
    const ids = texts.map((_, decisionIndex) => `${row.id}:decision:${decisionIndex + 1}`);
    const supersedes = row.supersedes.flatMap(id => extractedIds.get(id) ?? [id]);
    if (supersedes.some(id => ids.includes(id) || id === row.id)) throw new Error('Decision cannot supersede itself');
    extractedIds.set(row.id, ids);
    for (const [decisionIndex, text] of texts.entries()) {
      const id = ids[decisionIndex];
      if (!id) continue;
      decisions.push({ id, text, source, line: index + 1, digest, timestamp: row.timestamp, role: 'user', supersedes });
    }
  }
  return decisions;
}

export function promptLogPath(projectRoot: string): string {
  return join(rootPath(projectRoot), '.optimizer', 'prompts.jsonl');
}

/** Append one hook-captured user prompt verbatim and return its row ID. */
export function appendCapturedPrompt(projectRoot: string, content: string): string {
  const root = rootPath(projectRoot);
  if (!content.trim() || content.length > 200_000) throw new Error('Prompt must be nonempty and at most 200000 characters');
  assertNoSymlinks(join(root, '.optimizer'));
  const id = randomUUID();
  const line = JSON.stringify({ id, projectRoot: root, role: 'user', content, timestamp: new Date().toISOString(), capturedBy: 'hook' }) + '\n';
  const descriptor = openSync(promptLogPath(root), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    // shortcut: the log is capped at the transcript limit and capture stops when full; rotate once that happens in practice.
    if (fstatSync(descriptor).size + Buffer.byteLength(line) > maxTranscriptBytes) throw new Error('Prompt log reached its size limit');
    writeSync(descriptor, line);
  } finally {
    closeSync(descriptor);
  }
  return id;
}

/** Hook-captured user prompts are whole-message decisions; per-row digests keep earlier rows fresh as the log grows. */
export function capturedPrompts(projectRoot: string): Decision[] {
  const root = rootPath(projectRoot);
  const source = promptLogPath(root);
  if (!existsSync(source)) return [];
  assertNoSymlinks(source);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(readSource(source, maxTranscriptBytes));
  const decisions: Decision[] = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    let row: ConversationRow;
    try {
      value = JSON.parse(line);
      row = parseRow(value);
      if (rootPath(row.projectRoot) !== root) continue;
    } catch {
      // A bad row carries no authority, but must not disable capture or the hooks for the valid ones.
      continue;
    }
    const hook = typeof value === 'object' && value !== null && 'capturedBy' in value && value.capturedBy === 'hook';
    if (row.role !== 'user' || !hook || !row.content.trim()) continue;
    const digest = createHash('sha256').update(line).digest('hex');
    decisions.push({ id: `prompt:${row.id}`, text: row.content.trim(), source, line: index + 1, digest, timestamp: row.timestamp, role: 'user', supersedes: [] });
  }
  return decisions;
}

export function sourceDecisions(projectRoot: string, source: string): Decision[] {
  return source === promptLogPath(projectRoot) ? capturedPrompts(projectRoot) : importConversation(projectRoot, source);
}

export function isContextCurrent(projectRoot: string, context: ContextSnapshot): boolean {
  try {
    const root = rootPath(projectRoot);
    if (projectDigest(root) !== context.projectDigest) return false;
    for (const item of context.items) {
      if (!isAbsolute(item.path)) return false;
      if (item.kind !== 'decision' && !within(root, item.path)) return false;
      assertNoSymlinks(item.path);
      if (item.kind !== 'decision') {
        if (digestFile(item.path) !== item.digest) return false;
        continue;
      }
      // Transcript decisions carry the whole-file digest; captured prompts carry a per-row digest.
      const decisions = activeDecisions(sourceDecisions(root, item.path));
      const matches = decisions.some(decision => {
        return `decision:${decision.id}` === item.id && decision.text === item.excerpt && decision.line === item.line && decision.digest === item.digest;
      });
      if (!matches) return false;
    }
    return true;
  } catch {
    return false;
  }
}
