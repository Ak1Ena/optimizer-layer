import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

/**
 * Deterministic Bash classifier (spec Decision 4). Commands are tokenized into shell words first, and every
 * program on the read-only allowlist must also pass a per-program flag allowlist. Anything the tokenizer cannot
 * represent exactly, and anything unknown, is protected.
 */

export type BashKind = 'read' | 'verification' | 'control' | 'protected';
export interface BashClass { kind: BashKind; reserved?: boolean }
/**
 * Where the command runs. `root` is the tracked project root, `cwd` the shell's working directory, and `gitSafe`
 * false when the root itself is shaped like a bare repository. Without a root the command is assumed to run there.
 */
export interface BashContext { root?: string; cwd?: string; gitSafe?: boolean }
// Mentions of the runtime or hook that the tokenizer cannot read exactly are reserved (e.g. `optimizer $a$b`).
const runtimeMention = /optimizer|cli\.[cm]?[jt]s|claude-hook/;

export const reservedPath = /\.optimizer(?![\w-])(?!\/drafts\/)|optimizer-layer\/projects/;
// Bash may not even read these: runtime state, the per-user store (hook token) and the hook installer.
const reservedBash = new RegExp(`${reservedPath.source}|optimizer-claude-hook`);
// Any spelling that invokes the runtime CLI: `optimizer`, a path to it, or its cli.ts/cli.js entry point.
const runtimeInvoker = /(^|\/)(optimizer|cli\.[cm]?[jt]s)$/;
export const optimizerHookOnly = new Set(['prompt', 'enable', 'disable', 'start-from-prompt', 'blocked', 'run']);
const optimizerReads = new Set(['current', 'next', 'status', 'events', 'metrics', 'decide', 'gate', 'experiences', '--help']);
const optimizerControl = new Set(['init', 'propose-check', 'start', 'history', 'retrieve', 'assess', 'review', 'resolve', 'check', 'reconsider', 'claim', 'verify']);

/** Removes every quote and backslash, so reserved words spliced from quoted pieces (`ru""n`) still match. */
export function dequoted(command: string): string {
  return command.replace(/["'\\]/g, '');
}

/** Hook-only runtime commands under any spelling; checked on dequoted text and fails safe across segments. */
export function reservedCommand(command: string): boolean {
  const text = dequoted(command);
  if (reservedBash.test(text)) return true;
  const words = text.split(/[\s;&|()<>`]+/).filter(Boolean);
  const invoker = words.findIndex(word => runtimeInvoker.test(word));
  return invoker !== -1 && words.slice(invoker + 1).some(word => optimizerHookOnly.has(word));
}

interface Word { text: string; glob: boolean }
// Pathname expansion (`*`, `?`, `[`) and brace expansion with `,` or `..` turn one word into names the classifier cannot see.
const globPattern = /[*?[]|\{[^}]*(,|\.\.)[^}]*\}/;

/** A glob in command position can name any program (`/bin/o?timizer`), so it is denied like a hook-only command. */
function globbedCommand(command: string): boolean {
  return dequoted(command).split(/[;&|\n()`]|\$\(/).some(part => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const name = words.find(word => !/^\w+=/.test(word));
    // Also `node ./c?i.ts disable`: a glob can spell the runtime's entry point in an argument.
    return (name !== undefined && globPattern.test(name)) || (words.some(word => globPattern.test(word)) && words.some(word => optimizerHookOnly.has(word)));
  });
}

/**
 * Splits into segments of shell words. Returns null when the command uses anything this classifier does not
 * model exactly: redirections, substitutions, variables, subshells, unbalanced quotes, backslashes, or words
 * spliced from quoted and unquoted pieces.
 */
export function tokenize(command: string): Word[][] | null {
  const segments: Word[][] = [[]];
  let text = '';
  let started = false;
  let quotedSpans = 0;
  let bare = false;
  const end = (): boolean => {
    if (started) {
      // A word is clean when it is fully unquoted or exactly one quoted span; splices fail closed.
      if (quotedSpans > 1 || (quotedSpans === 1 && bare)) return false;
      segments.at(-1)?.push({ text, glob: quotedSpans === 0 && globPattern.test(text) });
    }
    text = ''; started = false; quotedSpans = 0; bare = false;
    return true;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? '';
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1);
      if (close === -1) return null;
      const content = command.slice(index + 1, close);
      if (char === '"' && (/[`\\]/.test(content) || /\$(?!$)/.test(content))) return null;
      text += content; started = true; quotedSpans++;
      index = close;
      continue;
    }
    if (/\s/.test(char) && char !== '\n') {
      if (!end()) return null;
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n') {
      if (!end()) return null;
      if ((char === '&' || char === '|') && command[index + 1] === char) index++;
      segments.push([]);
      continue;
    }
    if (/[<>`$()\\!]/.test(char)) return null;
    text += char; started = true; bare = true;
  }
  return end() ? segments.filter(segment => segment.length) : null;
}

// Only these exact fd duplications and /dev/null redirections are scrubbed; any other `>` stays and fails closed.
const harmlessRedirect = /(^|\s)(?:2>&1|1>&2|>&2|[12]?>\s*\/dev\/null)(?=\s|$|;|&|\|)/g;

/**
 * Flag allowlist: long flags by name (`--name` or `--name=value`), short flag clusters of allowed letters, where a
 * letter from `valued` may carry the rest of the cluster as its value. After `--` the remaining words are operands.
 */
interface Flags { short: string; valued?: string; long: string[]; digits?: boolean }
// No output-file, exec or in-place flags exist for these programs, so any flag stays read-only.
const anyFlags: Flags = { short: '', long: [] };

function flagsAllowed(args: string[], flags: Flags): boolean {
  if (flags === anyFlags) return true;
  for (const arg of args) {
    if (arg === '--') return true;
    if (!arg.startsWith('-') || arg === '-') continue;
    if (arg.startsWith('--')) {
      if (!flags.long.includes(arg.slice(2).split('=')[0] ?? '')) return false;
      continue;
    }
    if (flags.digits && /^-\d+$/.test(arg)) continue;
    for (const letter of arg.slice(1)) {
      // A value-taking letter consumes the rest of the cluster as its value.
      if (flags.valued?.includes(letter)) break;
      if (!flags.short.includes(letter)) return false;
    }
  }
  return true;
}

const gitDiffFlags: Flags = {
  short: 'pRaswMBDzW', valued: 'UnSG', digits: true,
  long: ['stat', 'numstat', 'shortstat', 'summary', 'name-only', 'name-status', 'cached', 'staged', 'patch', 'no-patch', 'unified', 'oneline', 'graph',
    'decorate', 'no-decorate', 'all', 'max-count', 'skip', 'since', 'until', 'after', 'before', 'author', 'committer', 'grep', 'format', 'pretty',
    'abbrev-commit', 'no-color', 'color', 'word-diff', 'ignore-all-space', 'ignore-space-change', 'reverse', 'first-parent', 'merges', 'no-merges',
    'follow', 'date', 'relative-date', 'raw', 'full-index', 'diff-filter', 'find-renames', 'no-renames', 'check', 'exit-code', 'quiet', 'histogram',
    'minimal', 'patience', 'dirstat', 'compact-summary', 'source', 'walk-reflogs', 'branches', 'tags', 'remotes', 'left-right', 'cherry-pick', 'topo-order', 'date-order'],
};
const flagsByProgram: Record<string, Flags> = {
  ls: anyFlags, cat: anyFlags, head: anyFlags, tail: anyFlags, wc: anyFlags, grep: anyFlags, pwd: anyFlags, which: anyFlags, echo: anyFlags,
  stat: anyFlags, diff: anyFlags, du: anyFlags, realpath: anyFlags, basename: anyFlags, dirname: anyFlags, true: anyFlags, cut: anyFlags, tr: anyFlags,
  // No -o/--output, --compress-program or --files0-from.
  sort: { short: 'bdfghiMnrRsuVzc', valued: 'tkST', long: ['ignore-leading-blanks', 'dictionary-order', 'ignore-case', 'general-numeric-sort', 'human-numeric-sort',
    'ignore-nonprinting', 'month-sort', 'numeric-sort', 'random-sort', 'reverse', 'stable', 'unique', 'version-sort', 'zero-terminated', 'check',
    'field-separator', 'key', 'buffer-size', 'parallel'] },
  rg: {
    short: 'nNilcwvFxsSuUHLzoqhVp', valued: 'egtTABCmMjE',
    long: ['line-number', 'no-line-number', 'ignore-case', 'smart-case', 'case-sensitive', 'files-with-matches', 'files-without-match', 'count', 'count-matches',
      'word-regexp', 'line-regexp', 'invert-match', 'fixed-strings', 'hidden', 'no-ignore', 'no-ignore-vcs', 'follow', 'files', 'glob', 'iglob', 'type',
      'type-not', 'type-list', 'after-context', 'before-context', 'context', 'max-count', 'max-depth', 'max-columns', 'json', 'only-matching', 'quiet',
      'no-heading', 'heading', 'color', 'colors', 'with-filename', 'no-filename', 'null', 'multiline', 'multiline-dotall', 'sort', 'sortr', 'regexp',
      'unrestricted', 'vimgrep', 'column', 'trim', 'stats', 'passthru', 'help', 'version', 'encoding', 'threads', 'pcre2', 'no-messages', 'search-zip'],
  },
};

function findAllowed(args: string[]): boolean {
  const primaries = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-maxdepth', '-mindepth',
    '-newer', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-empty', '-print', '-print0', '-prune', '-o', '-or', '-a', '-and',
    '-not', '-perm', '-user', '-group', '-links', '-depth', '-xdev', '-mount', '-readable', '-writable', '-executable', '-false', '-true',
    '-samefile', '-inum', '-lname', '-ilname', '-L', '-H', '-P', '-follow', '-nouser', '-nogroup', '-uid', '-gid']);
  return args.every(arg => !arg.startsWith('-') || primaries.has(arg));
}

/** Own-property lookup, so names like `constructor` or `__proto__` never reach Object.prototype members. */
function programFlags(name: string): Flags | undefined {
  return Object.hasOwn(flagsByProgram, name) ? flagsByProgram[name] : undefined;
}

function gitAllowed(args: string[]): boolean {
  let rest = args;
  // No -C, --git-dir or --work-tree: git must use the project's own repository.
  while (rest[0] === '--no-pager' || rest[0] === '--no-optional-locks') rest = rest.slice(1);
  const [command = '', ...options] = rest;
  switch (command) {
    case 'ls-files': return flagsAllowed(options, { short: 'cdmoiskutvfz', valued: 'x', long: ['cached', 'deleted', 'modified', 'others', 'ignored', 'stage',
      'killed', 'unmerged', 'exclude-standard', 'exclude', 'full-name', 'error-unmatch', 'directory', 'no-empty-directory', 'recurse-submodules', 'abbrev', 'eol'] });
    case 'rev-parse': return flagsAllowed(options, { short: 'q', long: ['show-toplevel', 'abbrev-ref', 'short', 'verify', 'quiet', 'git-dir', 'absolute-git-dir',
      'is-inside-work-tree', 'is-inside-git-dir', 'is-bare-repository', 'show-prefix', 'show-cdup', 'symbolic-full-name', 'symbolic', 'show-superproject-working-tree'] })
      // `--git-dir` only prints here; a value would mean a different repository.
      && options.every(item => !item.startsWith('--git-dir=') && !item.startsWith('--work-tree'));
    case 'blame': return flagsAllowed(options, { short: 'wlstenfpbc', valued: 'LMC', long: ['porcelain', 'line-porcelain', 'incremental', 'date', 'root',
      'show-stats', 'show-name', 'show-number', 'show-email', 'abbrev', 'minimal', 'reverse', 'first-parent', 'color-lines', 'color-by-age', 'ignore-rev'] });
    case 'status': return flagsAllowed(options, { short: 'sbuvz', valued: 'u', long: ['short', 'branch', 'porcelain', 'long', 'verbose', 'untracked-files', 'ignored', 'show-stash', 'ahead-behind', 'no-ahead-behind', 'renames', 'no-renames'] });
    case 'diff': case 'log': case 'show': return flagsAllowed(options, gitDiffFlags);
    // `git branch NAME`, -d, -m, -c and friends change refs; only listing flags, no operands, stay read-only.
    case 'branch': return options.every(item => /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-verbose|-no-color|-color)$/.test(item));
    default: return false;
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('../') && !isAbsolute(child));
}

function segmentKind(words: string[], globbed: boolean, checks: readonly (readonly string[])[], context: BashContext, moved: boolean): BashClass {
  const [name, ...args] = words;
  if (name === undefined) return { kind: 'read' };
  const root = context.root;
  const cwd = context.cwd ?? root;
  const check = !globbed && checks.some(argv => argv.length === words.length && (argv[0] === name || basename(argv[0] ?? '') === name) && argv.every((item, index) => index === 0 || item === words[index]));
  if (check) return { kind: 'verification' };
  // Only bare names: a path could point at a planted program that shares an allowlisted name.
  if (name.includes('/') || name.includes('=')) return { kind: 'protected' };
  if (name === 'optimizer') {
    const command = args[0] ?? '';
    // Only the tracked root: `optimizer init --project sub` would otherwise create a nested root that escapes the gate.
    // Exactly one --project (the CLI refuses repeats too), resolved from a cwd no earlier `cd` changed.
    const flags = args.flatMap((item, index) => item === '--project' ? [args[index + 1]] : item.startsWith('--project=') ? [item.slice('--project='.length)] : []);
    const [project] = flags;
    if (root && (moved || flags.length !== 1 || project === undefined || resolve(cwd ?? root, project) !== root)) return { kind: 'protected' };
    if (optimizerReads.has(command)) return { kind: 'read' };
    return { kind: optimizerControl.has(command) ? 'control' : 'protected' };
  }
  if (name === 'cd' || name === 'pushd') {
    // Only a literal directory inside the project; elsewhere git and nested roots would follow the agent out.
    const [target, ...extra] = args;
    if (globbed || extra.length || target === undefined || target.startsWith('-') || target.startsWith('~')) return { kind: 'protected' };
    if (root) {
      let real: string;
      try {
        // Through symlinks: a committed link inside the project may point anywhere.
        real = realpathSync(resolve(cwd ?? root, target));
      } catch {
        return { kind: 'protected' };
      }
      return { kind: inside(root, real) ? 'read' : 'protected' };
    }
    return { kind: isAbsolute(target) || target.split('/').includes('..') ? 'protected' : 'read' };
  }
  // A glob can expand to a file named like a flag, so flag-sensitive programs need literal words.
  const literal = !globbed || programFlags(name) === anyFlags;
  if (!literal) return { kind: 'protected' };
  if (name === 'git') {
    // Git reads repository config (diff.external, textconv), so it runs only in the root's own repository.
    const atRoot = !moved && (!root || cwd === root) && context.gitSafe !== false;
    return { kind: atRoot && gitAllowed(args) ? 'read' : 'protected' };
  }
  if (name === 'find') return { kind: findAllowed(args) ? 'read' : 'protected' };
  // Exactly `sed -n ADDRp FILE...`; scripts can write files (w, e, -i), so nothing else is a read.
  if (name === 'sed') return { kind: args[0] === '-n' && /^[\d,$]+p$/.test(args[1] ?? '') && args.slice(2).every(item => !item.startsWith('-')) ? 'read' : 'protected' };
  const flags = programFlags(name);
  return { kind: flags && flagsAllowed(args, flags) ? 'read' : 'protected' };
}

const kindRank: Record<BashKind, number> = { read: 0, verification: 1, control: 2, protected: 3 };

export function classifyBash(command: string, checks: readonly (readonly string[])[] = [], context: BashContext = {}): BashClass {
  try {
    if (reservedCommand(command) || globbedCommand(command)) return { kind: 'protected', reserved: true };
    const segments = tokenize(command.replace(harmlessRedirect, '$1'));
    if (!segments) return runtimeMention.test(dequoted(command)) ? { kind: 'protected', reserved: true } : { kind: 'protected' };
    let kind: BashKind = 'read';
    let moved = false;
    for (const segment of segments) {
      const words = segment.map(word => word.text);
      // Any unquoted glob fails closed: expansions can name the per-user store, state files or flag-like files.
      const result = segment.some(word => word.glob) ? { kind: 'protected' as const } : segmentKind(words, false, checks, context, moved);
      moved ||= words[0] === 'cd' || words[0] === 'pushd';
      if (kindRank[result.kind] > kindRank[kind]) kind = result.kind;
    }
    return { kind };
  } catch {
    // A classifier failure must never let a command through.
    return { kind: 'protected' };
  }
}
