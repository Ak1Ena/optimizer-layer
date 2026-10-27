#!/usr/bin/env node
// Stands in for `claude -p` in benchmark dry runs; it never contacts a model.
// It finds the task whose task.txt equals the prompt on stdin and writes that task's decoy/ files if it has
// any (a plausible wrong answer), else its solution/ files. Under `optimizer run` (--settings given) it runs
// the hooks from the settings file through /bin/sh like Claude Code, honours deny verdicts, follows the
// standard-tier protocol when the first checkpoint is not PROCEED, and answers a Stop block with verify.
// Usage numbers are deterministic functions of the steps taken, printed in Claude Code's JSON shape.
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8').trim();
const cwd = process.cwd();
const tasks = join(import.meta.dirname, 'tasks');
const task = readdirSync(tasks).find(name => readFileSync(join(tasks, name, 'task.txt'), 'utf8').trim() === prompt);
if (!task) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake: unknown task', num_turns: 1 }));
  process.exit(1);
}
const source = join(tasks, task, existsSync(join(tasks, task, 'decoy')) ? 'decoy' : 'solution');
const files = readdirSync(source, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(source, join(entry.parentPath, entry.name)));

let turns = 1;
const settingsAt = args.indexOf('--settings');
const settings = settingsAt >= 0 ? JSON.parse(readFileSync(args[settingsAt + 1], 'utf8')) : null;
const hook = (event, extra) => {
  const result = spawnSync('/bin/sh', ['-c', settings.hooks[event][0].hooks[0].command], { encoding: 'utf8', input: JSON.stringify({ session_id: 'fake', cwd, hook_event_name: event, ...extra }) });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const optimizer = (...rest) => {
  turns += 1;
  const result = spawnSync(process.env.OPTIMIZER_BIN, [...rest, '--project', cwd], { encoding: 'utf8' });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const write = path => {
  turns += 1;
  const target = join(cwd, path);
  const denied = settings && hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: target, content: '' } })?.hookSpecificOutput?.permissionDecision === 'deny';
  if (!denied) cpSync(join(source, path), target);
};

let sessionId = null;
let light = false;
const accept = () => {
  const items = optimizer('retrieve', '--session', sessionId)?.items?.map(item => item.id).join(',') || 'none';
  optimizer('assess', '--session', sessionId, '--kind', 'sufficient', '--rationale', 'The repository files cover the request.', '--items', items);
  const version = optimizer('status', '--session', sessionId)?.state?.goal?.version ?? 1;
  optimizer('review', '--session', sessionId, '--kind', 'accept', '--version', String(version), '--rationale', 'R1 is the request verbatim.', '--items', items);
};
if (settings) {
  const current = optimizer('current');
  sessionId = current?.sessionId;
  light = current?.checkpoint?.decision === 'PROCEED';
  if (!light) accept();
}
for (const path of files) write(path);
if (settings && !light) {
  accept();
  optimizer('check', '--session', sessionId, '--check', 'check-1');
  optimizer('claim', '--session', sessionId);
}
if (settings && hook('Stop', { stop_hook_active: false })?.decision === 'block') optimizer('verify', '--session', sessionId);

process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: `Done: updated ${files.join(', ')}.`,
  num_turns: turns, duration_ms: turns * 1000, duration_api_ms: turns * 800, total_cost_usd: turns * 0.002,
  usage: { input_tokens: turns * 10, cache_read_input_tokens: turns * 4000, cache_creation_input_tokens: 1500 + turns * 100, output_tokens: turns * 60 },
  modelUsage: { fake: { inputTokens: turns * 10, outputTokens: turns * 60 } },
}));
