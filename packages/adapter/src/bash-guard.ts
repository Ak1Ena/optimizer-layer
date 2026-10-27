import { basename } from 'node:path';

/**
 * Spawn-free Bash guard for the Claude Code hook. It parses the command into shell words (quotes, escapes, `$'..'`,
 * literal variables from earlier assignments) and denies actual optimizer invocations of hook-only subcommands,
 * access to optimizer state, and commands built at runtime that point at the optimizer. Ordinary commands that only
 * mention a path like `optimizer-layer/` or a file like `prompt.txt` pass.
 *
 * The runtime cannot be imported here (separate package), and its classifier refuses any `$`, so this has its own parser.
 */

// Same set as the runtime classifier's `optimizerHookOnly`: user or hook proof only (enable/disable need a terminal,
// prompt/start-from-prompt/blocked the hook token, and run refuses inside an agent).
export const hookOnly = new Set(['prompt', 'enable', 'disable', 'start-from-prompt', 'blocked', 'run']);
// Words that tie an unreadable (dynamic) command to the optimizer; `run` is too common to count on its own.
const relationWords = new Set([...hookOnly].filter(word => word !== 'run'));
const invoker = /(^|\/)(optimizer|cli\.[cm]?[jt]s)$|^@optimizer-layer\/runtime(@\S*)?$/;
const hookScript = /(^|\/)claude-hook\.[cm]?[jt]s$/;
// Runtime state, the per-user store (hook token) and the hook installer are off limits to Bash in any spelling.
const state = /optimizer-claude-hook|optimizer-layer\/projects|\.optimizer(?![\w-])(?!\/drafts\/)/;
const mention = /(?<![\w.-])optimizer(?![\w.-])|(?<![\w.-])cli\.[cm]?[jt]s(?![\w.-])|claude-hook|@optimizer-layer\/runtime/;
const assignment = /^[A-Za-z_]\w*=/;
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'eval']);
// Programs that run another command or a command string given as arguments.
const launchers = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'sudo', 'doas', 'npx', 'bunx', 'builtin', 'xargs', 'parallel', 'su', 'script', 'watch', 'ssh']);
const interpreters = new Set(['node', 'tsx', 'ts-node', 'bun', 'deno', ...launchers, ...shells]);

interface Word { text: string; bare: string; unknown: boolean; procsub: boolean }
interface Segment { words: Word[]; piped: boolean }

/** Index of the `close` matching an already open bracket, skipping quotes and escapes; -1 when unbalanced. */
function closing(source: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') index++;
    else if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += char === '"' && source[end] === '\\' ? 2 : 1;
      index = end;
    } else if (char === open) depth++;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}

const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
/** Decodes the body of `$'...'`, so `$'\x6fptimizer'` reads as `optimizer`. */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g, (_, code: string) => {
    if (/^[xuU]/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 16));
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return escapes[code] ?? code;
  });
}

/** Splits into segments of words; substitution bodies go to `inner` so they are checked as commands too. */
function parse(source: string, inner: string[]): Segment[] {
  const segments: Segment[] = [{ words: [], piped: false }];
  const vars = new Map<string, string>();
  let word: Word | undefined;
  const add = (text: string, unknown = false, bare = false) => {
    word ??= { text: '', bare: '', unknown: false, procsub: false };
    word.text += text;
    if (bare) word.bare += text;
    word.unknown ||= unknown;
  };
  const endWord = () => {
    // Unquoted globs (`o?timizer`, `c[l]i.ts`) and brace lists can expand to any name.
    if (word && /[*?]|\[.+\]|\{[^}]*(,|\.\.)[^}]*\}/.test(word.bare)) word.unknown = true;
    if (word) segments.at(-1)?.words.push(word);
    word = undefined;
  };
  const endSegment = (piped: boolean) => {
    endWord();
    const current = segments.at(-1);
    if (current?.words.length) remember(current.words, vars);
    // `a | ( sh )`: the subshell still reads the pipe.
    if (current && !current.words.length) current.piped ||= piped;
    else segments.push({ words: [], piped });
  };
  const substitution = (from: number, open: string, close: string): number => {
    const end = closing(source, from, open, close);
    inner.push(source.slice(from, end === -1 ? undefined : end));
    add('', true);
    return end === -1 ? source.length : end;
  };
  /** Expands `$...` at `index`; returns the last consumed index. */
  const dollar = (index: number, quoted: boolean): number => {
    const next = source[index + 1] ?? '';
    if (next === '(') return substitution(index + 2, '(', ')');
    if (next === '{') {
      const end = closing(source, index + 2, '{', '}');
      const body = source.slice(index + 2, end === -1 ? undefined : end);
      const value = vars.get(body);
      if (value !== undefined) add(value, !quoted && /[\s*?[]/.test(value));
      else { inner.push(body); add('', true); }
      return end === -1 ? source.length : end;
    }
    const name = /^[A-Za-z_]\w*/.exec(source.slice(index + 1))?.[0];
    if (name) {
      const value = vars.get(name);
      // Unquoted values are word-split and globbed, which this parser does not model.
      add(value ?? '', value === undefined || (!quoted && /[\s*?[]/.test(value)));
      return index + name.length;
    }
    if (/[?#@*$!0-9-]/.test(next)) { add('', true); return index + 1; }
    add('$', false, !quoted);
    return index;
  };
  const backtick = (index: number): number => {
    let end = index + 1;
    while (end < source.length && source[end] !== '`') end += source[end] === '\\' ? 2 : 1;
    inner.push(source.slice(index + 1, end).replace(/\\([$`\\])/g, '$1'));
    add('', true);
    return end;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (char === '\\') {
      if (next !== '\n') add(next);
      index++;
    } else if (char === "'") {
      const end = source.indexOf("'", index + 1);
      add(source.slice(index + 1, end === -1 ? undefined : end));
      index = end === -1 ? source.length : end;
    } else if (char === '$' && next === "'") {
      let end = index + 2;
      while (end < source.length && source[end] !== "'") end += source[end] === '\\' ? 2 : 1;
      add(ansiC(source.slice(index + 2, end)));
      index = end;
    } else if (char === '"' || (char === '$' && next === '"')) {
      if (char === '$') index++;
      add('');
      for (index++; index < source.length && source[index] !== '"'; index++) {
        const inside = source[index] ?? '';
        if (inside === '\\' && /[$`"\\\n]/.test(source[index + 1] ?? '')) {
          if (source[index + 1] !== '\n') add(source[index + 1] ?? '');
          index++;
        } else if (inside === '$') index = dollar(index, true);
        else if (inside === '`') index = backtick(index);
        else add(inside);
      }
    } else if (char === '$') index = dollar(index, false);
    else if (char === '`') index = backtick(index);
    else if ((char === '<' || char === '>') && next === '(') {
      endWord();
      index = substitution(index + 2, '(', ')');
      if (word) word.procsub = true;
    } else if (char === '#' && !word) {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end - 1;
    } else if (char === '<' || char === '>') {
      endWord();
      if (next === '&') index++;
    } else if (/[;&|\n()]/.test(char)) {
      endSegment(char === '|' && next !== '|' && source[index - 1] !== '|');
    } else if (/\s/.test(char)) endWord();
    else add(char, false, true);
  }
  endSegment(false);
  return segments.filter(segment => segment.words.length);
}

/** Records literal assignments (`a=dis; b=able`) so later `$a$b` reads as `disable`. */
function remember(words: Word[], vars: Map<string, string>): void {
  const declared = ['export', 'declare', 'local', 'readonly', 'typeset'].includes(words[0]?.text ?? '');
  const rest = declared ? words.slice(1) : words;
  if (!declared && !rest.every(word => assignment.test(word.text))) return;
  for (const word of rest) {
    const match = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(word.text);
    if (!match?.[1]) continue;
    if (word.unknown) vars.delete(match[1]);
    else vars.set(match[1], match[2] ?? '');
  }
}

/** The command a segment runs, past assignments and launchers like `env`, `command`, `timeout 5`, `npx`. */
function launched(words: Word[]): Word | undefined {
  let index = words.findIndex(word => !assignment.test(word.text));
  while (index !== -1 && launchers.has(basename(words[index]?.text ?? ''))) {
    index++;
    while (index < words.length && /^(-|\d+[smhd]?$)|^[A-Za-z_]\w*=/.test(words[index]?.text ?? '')) index++;
  }
  return index === -1 ? undefined : words[index];
}

function denied(command: string, depth: number): boolean {
  if (depth > 8) return true;
  const dequoted = command.replace(/["'\\]/g, '');
  if (state.test(dequoted)) return true;
  const inner: string[] = [];
  const segments = parse(command, inner);
  // A command this guard cannot read: denied only when it also points at the optimizer.
  let opaque = false;
  for (const { words, piped } of segments) {
    if (words.some(word => state.test(word.text) || (/[*?[{]/.test(word.bare) && globState(word.text)))) return true;
    const names = words.map(word => basename(word.text));
    const program = words.find(word => !assignment.test(word.text));
    // A literal invocation with a hook-only subcommand, or with any argument the guard cannot read.
    const at = words.findIndex(word => invoker.test(word.text));
    if (at !== -1 && words.slice(at + 1).some(word => word.unknown || hookOnly.has(word.text))) return true;
    // `$X enable`, `o?timizer enable`, `$(which optimizer) disable`: an unreadable word may be the optimizer.
    const unknown = words.findIndex(word => word.unknown);
    if (unknown !== -1 && words.slice(unknown + 1).some(word => hookOnly.has(word.text))) return true;
    // Running the hook directly could forge hook events (prompt capture, check approval).
    if (program && (hookScript.test(program.text) || (interpreters.has(basename(program.text)) && words.some(word => hookScript.test(word.text))))) return true;
    const feeds = names.includes('xargs') || names.includes('parallel');
    if (feeds && at !== -1) return true;
    if (launched(words)?.unknown) opaque = true;
    const shell = names.findIndex(name => shells.has(name));
    if (shell !== -1) {
      const rest = words.slice(shell + 1);
      // Code from a pipe (`base64 -d | sh`), xargs arguments or a process substitution cannot be read.
      if (rest.some(word => word.procsub)) return true;
      if (rest.every(word => word.text.startsWith('-')) && (piped || feeds)) return true;
      if (rest.some(word => word.unknown)) opaque = true;
      if (names[shell] === 'eval' && denied(rest.map(word => word.text).join(' '), depth + 1)) return true;
    }
    if (feeds && words.some(word => word.unknown)) opaque = true;
    // Command strings: `sh -c '...'`, `env -S '...'`, `ssh host '...'`, `watch '...'`.
    if (shell !== -1 || names.some(name => launchers.has(name))) {
      if (words.some(word => /[\s;&|<>()`$]/.test(word.text) && denied(word.text, depth + 1))) return true;
    }
  }
  if (inner.some(body => denied(body, depth + 1))) return true;
  return opaque && (mention.test(dequoted) || segments.some(segment => segment.words.some(word => relationWords.has(word.text))));
}

// Programs that execute a here-document body as code; for anything else (`cat <<EOF`) the body is data.
const codeReaders = /^(sh|bash|zsh|dash|ksh|mksh|fish|eval|source|\.|node|tsx|ts-node|bun|deno|python[\d.]*|perl|ruby|php|osascript|env|sudo|doas|ssh|xargs)$/;

/** Drops here-document bodies fed to non-interpreters, so a commit message or notes file mentioning the optimizer is not read as commands. */
function dropHeredocData(source: string): string {
  return source.replace(/(?<!<)<<(?!<)-?[ \t]*(["']?)([A-Za-z_][\w.-]*)\1([^\n]*)\n[\s\S]*?(?:\n[\t ]*\2[ \t]*(?=\n|$)|$)/g, (match, _quote: string, delimiter: string, rest: string, offset: number) => {
    const line = source.slice(source.lastIndexOf('\n', offset) + 1, offset);
    const program = line.split(/[;&|(`]|\$\(/).at(-1)?.trim().split(/\s+/)[0] ?? '';
    return codeReaders.test(basename(program)) ? match : `<<${delimiter}${rest}\n`;
  });
}

/** Expands `{a,b}` lists (and turns `{x..y}` ranges into `*`) for the state check below. */
function braces(text: string): string[] {
  const match = /\{([^{}]*)\}/.exec(text);
  if (!match || !/,|\.\./.test(match[1] ?? '')) return [text];
  const options = (match[1] ?? '').includes(',') ? (match[1] ?? '').split(',') : ['*'];
  return options.flatMap(option => braces(text.slice(0, match.index) + option + text.slice(match.index + match[0].length)));
}

/** True when a glob or brace word (`.opt*`, `.{opti,x}mizer`, `optimizer-*\/projects`) could expand to optimizer state. */
function globState(text: string): boolean {
  return braces(text).some(path => {
    const parts = path.split('/');
    const matches = (pattern: string, name: string) => {
      // Without dotglob, `*`, `?` and `[...]` never match a leading dot.
      if (name.startsWith('.') && !pattern.startsWith('.')) return false;
      const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[(?![^\]]*\])/g, '\\[').replaceAll('*', '.*').replaceAll('?', '.').replace(/\[!/g, '[^');
      return new RegExp(`^${source}$`).test(name);
    };
    return parts.some((part, index) => {
      const next = parts[index + 1];
      // A bare `*` could name anything; only spellings that keep part of the hook's name count here.
      if (/optim|hook/.test(part) && matches(part, 'optimizer-claude-hook')) return true;
      if (matches(part, 'optimizer-layer') && next !== undefined && matches(next, 'projects')) return true;
      return matches(part, '.optimizer') && !(next === 'drafts' && parts.length > index + 2);
    });
  });
}

// Fallback: an optimizer executable named anywhere plus a hook-only word anywhere (`alias o=optimizer; o enable`,
// `python3 -c "os.system('optimizer enable')"`, `echo 'optimizer enable' > x.sh; sh x.sh`). `run` is left out: `npm run` is everyday.
const executableName = /(?<![\w.-])optimizer(?![\w.-])|@optimizer-layer\/runtime/;
const hookOnlyWord = /(?<![\w.:/-])(enable|disable|prompt|start-from-prompt|blocked)(?![\w.:/-])/;

/** True when the Bash command must be denied; any parser failure denies. */
export function deniedBash(command: string): boolean {
  try {
    const visible = dropHeredocData(command);
    const dequoted = visible.replace(/["'\\]/g, '');
    if (executableName.test(dequoted) && hookOnlyWord.test(dequoted)) return true;
    return denied(visible, 0);
  } catch {
    return true;
  }
}
