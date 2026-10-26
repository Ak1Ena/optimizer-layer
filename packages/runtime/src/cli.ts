#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { Runtime } from './runtime.ts';
import { capturePrompt, disableProject, enableProject, projectView, proposeChecks, readProjectConfig, sessionSummary } from './project.ts';
import { startDashboard } from './dashboard.ts';
import { parseAssessment, parseReviewResponse } from './schema.ts';

const usage = `optimizer COMMAND --project PATH [--session ID]
optimizer dashboard [--port N]   (local read-only web page; default port 8790, 0 picks a free one)
Commands:
  init
  propose-check --check CMD [--check CMD ...] [--timeout-ms N]
              (pending until the user replies "approve check CODE" in Claude Code)
  enable      [--check CMD ...] [--timeout-ms N]
              (turns the opt-in hooks on for this project; without --check the
              existing checks are kept and the agent can propose one;
              --yes accepts the package.json test script when --check is omitted)
  disable     (per-project opt-out of the hooks)
  prompt      --file PROMPT.txt (hook capture; requires OPTIMIZER_HOOK_TOKEN)
  current
  start       --request GOAL.md [--checks CHECKS.json, only without approved project checks] [--replace]
  history     --file CONVERSATION.jsonl
  retrieve
  assess      --kind sufficient|insufficient --rationale TEXT --items ID,ID
  review      --kind accept|challenge --version N --rationale TEXT --items ID,ID
              [--requirement ID --owner human|local for challenges]
  resolve     --question ID --source DECISION_ID|prompt:ID [--answer TEXT for local questions]
  next
  check       --check CHECK_ID
  reconsider  --strategy retain|revise --rationale TEXT
  claim
  verify
  status
  events      [--after SEQUENCE] [--limit COUNT]
  metrics
All commands emit JSON. Goal/check/history files are explicitly selected inputs.
Check commands run without a shell; shell metacharacters are rejected.
OPTIMIZER_DISABLED=1 turns every Claude Code hook into a no-op.
`;

function readInput(path: string): string {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Input exceeds 4 MiB');
  return readFileSync(path, 'utf8');
}

function pageNumber(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new Error(`Invalid ${name}`);
  return number;
}

function timeoutMs(value: unknown): number {
  return typeof value === 'string' ? pageNumber(value, 'timeout-ms', 30_000) : 30_000;
}

function checkCommands(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function main(): unknown {
  const options: ParseArgsOptionsConfig = Object.fromEntries([
    'project', 'session', 'request', 'checks', 'file', 'kind', 'rationale', 'items',
    'question', 'source', 'answer', 'strategy', 'after', 'limit', 'version', 'requirement', 'owner', 'timeout-ms', 'port',
  ].map(name => [name, { type: 'string' }]));
  options.check = { type: 'string', multiple: true };
  for (const name of ['help', 'yes', 'replace']) options[name] = { type: 'boolean' };
  const parsed = parseArgs({ allowPositionals: true, strict: true, options });
  if (parsed.values.help) {
    process.stdout.write(usage);
    return undefined;
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length) throw new Error('Unexpected positional arguments');
  const commands = new Set(['init', 'dashboard', 'propose-check', 'enable', 'disable', 'prompt', 'current', 'start', 'history', 'retrieve', 'assess', 'review', 'resolve', 'next', 'check', 'reconsider', 'claim', 'verify', 'status', 'events', 'metrics']);
  if (!command || !commands.has(command)) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  const required = (name: string): string => {
    const input = parsed.values[name];
    const value = Array.isArray(input) && input.length === 1 ? input[0] : input;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  if (command === 'dashboard') {
    const port = typeof parsed.values.port === 'string' ? pageNumber(parsed.values.port, 'port', 65_535) : 8790;
    startDashboard(port).then(
      ({ url }) => process.stdout.write(JSON.stringify({ url }) + '\n'),
      (error: unknown) => {
        process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Dashboard failed to start' }) + '\n');
        process.exitCode = 1;
      },
    );
    return undefined;
  }
  const project = required('project');
  if (command === 'propose-check') {
    return proposeChecks(project, { commands: checkCommands(parsed.values.check), timeoutMs: timeoutMs(parsed.values['timeout-ms']) });
  }
  if (command === 'enable') {
    return enableProject(project, { commands: checkCommands(parsed.values.check), timeoutMs: timeoutMs(parsed.values['timeout-ms']), yes: parsed.values.yes === true });
  }
  if (command === 'disable') return disableProject(project);
  if (command === 'prompt') return capturePrompt(project, readInput(required('file')), process.env.OPTIMIZER_HOOK_TOKEN);
  if (command === 'current') {
    const config = readProjectConfig(project);
    const { activeSessionId, ...view } = projectView(config);
    if (!view.enabled) return { ...view, sessionId: null, action: null, summary: '' };
    if (!activeSessionId) return { ...view, sessionId: null, action: null, summary: 'No active optimizer session.' };
  }
  const runtime = new Runtime(project);
  try {
    if (command === 'init') return { projectRoot: runtime.projectRoot };
    if (command === 'current') {
      const { activeSessionId: sessionId, ...view } = projectView(readProjectConfig(project));
      if (!sessionId) throw new Error('No active session');
      const action = runtime.next(sessionId);
      return { ...view, sessionId, action, summary: sessionSummary(runtime.get(sessionId), action) };
    }
    if (command === 'start') {
      const checks: unknown = typeof parsed.values.checks === 'string' ? JSON.parse(readInput(required('checks'))) : undefined;
      return runtime.start({ request: readInput(required('request')), ...(checks === undefined ? {} : { checks }), replace: parsed.values.replace === true });
    }
    const sessionId = required('session');
    switch (command) {
      case 'history': return runtime.importHistory(sessionId, required('file'));
      case 'retrieve': return runtime.retrieve(sessionId);
      case 'assess': {
        const itemIds = (typeof parsed.values.items === 'string' ? parsed.values.items : '').split(',').filter(Boolean);
        return runtime.assess(sessionId, parseAssessment({ kind: required('kind'), rationale: required('rationale'), itemIds }));
      }
      case 'review': {
        const itemIds = required('items').split(',').filter(Boolean);
        return runtime.review(sessionId, parseReviewResponse({
          kind: required('kind'), goalVersion: pageNumber(required('version'), 'version', Number.MAX_SAFE_INTEGER),
          rationale: required('rationale'), itemIds,
          ...(typeof parsed.values.requirement === 'string' ? { requirementId: parsed.values.requirement } : {}),
          ...(typeof parsed.values.owner === 'string' ? { owner: parsed.values.owner } : {}),
        }));
      }
      case 'resolve': {
        const answer = parsed.values.answer;
        const input = { uncertaintyId: required('question'), source: required('source') };
        return runtime.resolve(sessionId, typeof answer === 'string' ? { ...input, answer } : input);
      }
      case 'next': return runtime.next(sessionId);
      case 'check': {
        const evidence = runtime.runCheck(sessionId, required('check'));
        if (evidence.result.outcome !== 'passed') process.exitCode = 1;
        return { evidence, action: runtime.next(sessionId) };
      }
      case 'reconsider': {
        const strategy = required('strategy');
        if (strategy !== 'retain' && strategy !== 'revise') throw new Error('Strategy must be retain or revise');
        return runtime.reconsider(sessionId, { strategy, rationale: required('rationale') });
      }
      case 'claim': return runtime.claim(sessionId);
      case 'verify': {
        const result = runtime.verify(sessionId);
        if (result.action.kind !== 'complete') process.exitCode = 1;
        return result;
      }
      case 'status': return { state: runtime.get(sessionId), action: runtime.next(sessionId) };
      case 'events': {
        const after = pageNumber(typeof parsed.values.after === 'string' ? parsed.values.after : '0', 'after', Number.MAX_SAFE_INTEGER);
        const limit = pageNumber(typeof parsed.values.limit === 'string' ? parsed.values.limit : '100', 'limit', 500);
        if (limit < 1) throw new Error('limit must be positive');
        return runtime.events(sessionId).filter(item => item.sequence > after).slice(0, limit);
      }
      case 'metrics': return runtime.measurements(sessionId);
      default: throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    runtime.close();
  }
}

try {
  const result = main();
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown runtime error' }) + '\n');
  process.exitCode = 1;
}
