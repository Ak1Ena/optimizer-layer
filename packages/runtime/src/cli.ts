#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { claudeArgs, findExecutable, managedRun, runtimeBuild } from './managed.ts';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { gate, Runtime } from './runtime.ts';
import { sameSecret } from './user-store.ts';
import { capturePrompt, disableProject, enableProject, requestProjectChange, projectView, proposeChecks, readProjectConfig, sessionSummary } from './project.ts';
import { startDashboard } from './dashboard.ts';
import { maxCheckTimeoutMs, parseAssessment, parseReviewResponse } from './schema.ts';

const usage = `optimizer COMMAND --project PATH [--session ID]
optimizer dashboard [--port N]   (local read-only web page; default port 8790, 0 picks a free one)
optimizer build                  (content hash of this runtime build; \`optimizer run\` refuses other builds)
optimizer run --project PATH --prompt-file F [--max-turns N] [--timeout-ms N] [--claude PATH] [--hook PATH]
              [--tier standard] (operator-only: skip the light tier; recorded as tier.decided
              standard, trigger "forced by run option")
              [--claude-args="ARGS"] (extra claude arguments, whitespace-split without a shell,
              e.g. --claude-args="--permission-mode acceptEdits --allowedTools Bash")
              (Managed Execution: starts the contract from F, runs \`claude -p\` under enforced
              hooks, then verifies; exit 0 only for outcome VERIFIED. Defaults: 30 turns,
              1800000 ms, \`claude\` and \`optimizer-claude-hook\` from PATH)
Commands:
  init
  propose-check --check CMD [--check CMD ...] [--timeout-ms N]
              (pending until the user replies "approve check CODE" in Claude Code)
  enable      [--check CMD ...] [--timeout-ms N]
              (turns the opt-in hooks on for this project; without --check the
              existing checks are kept and the agent can propose one;
              --yes accepts the package.json test script when --check is omitted)
  disable     (per-project opt-out of the hooks)
              enable/disable apply directly only from an interactive terminal; otherwise they
              return an approval phrase (approve enable|disable CODE) the user types in Claude Code
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
  verify      (adds outcome VERIFIED|FAILED|INCONCLUSIVE|NEEDS_HUMAN_REVIEW and phase)
  experiences [--session ID] (decision experiences with observed outcomes; no goal or prompt text)
  decide      [--session ID] (structured controller decision; defaults to the active session)
  gate        --tool NAME [--input-file TOOL_INPUT.json] (policy verdict for one host tool call;
              a protected action in a managed project with no open session starts one from
              the latest captured prompt; never fails for a missing session)
  start-from-prompt --prompt ID (hook only; requires OPTIMIZER_HOOK_TOKEN)
  blocked     --reason TEXT [--session ID] (hook only; records an exhausted Stop budget)
  status
  events      [--after SEQUENCE] [--limit COUNT]
  metrics     (cost breakdown: agent usage, injected bytes, component and hook time, rework; raw measurements)
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
  return typeof value === 'string' ? pageNumber(value, 'timeout-ms', maxCheckTimeoutMs) : 30_000;
}

function checkCommands(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function main(): unknown {
  const options: ParseArgsOptionsConfig = Object.fromEntries([
    'project', 'session', 'request', 'checks', 'file', 'kind', 'rationale', 'items',
    'question', 'source', 'answer', 'strategy', 'after', 'limit', 'version', 'requirement', 'owner', 'timeout-ms', 'port',
    'tool', 'input-file', 'prompt', 'reason', 'prompt-file', 'max-turns', 'claude', 'hook', 'claude-args', 'tier',
  ].map(name => [name, { type: 'string' }]));
  options.check = { type: 'string', multiple: true };
  // Repeated --project is refused (required() takes exactly one), so the classifier and the CLI never disagree on the target.
  options.project = { type: 'string', multiple: true };
  for (const name of ['help', 'yes', 'replace']) options[name] = { type: 'boolean' };
  const parsed = parseArgs({ allowPositionals: true, strict: true, options });
  if (parsed.values.help) {
    process.stdout.write(usage);
    return undefined;
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length) throw new Error('Unexpected positional arguments');
  const commands = new Set(['init', 'dashboard', 'propose-check', 'enable', 'disable', 'prompt', 'current', 'start', 'history', 'retrieve', 'assess', 'review', 'resolve', 'next', 'check', 'reconsider', 'claim', 'verify', 'status', 'events', 'metrics', 'decide', 'gate', 'start-from-prompt', 'blocked', 'experiences', 'run', 'build']);
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
  if (command === 'build') return { build: runtimeBuild() };
  const project = required('project');
  if (command === 'propose-check') {
    return proposeChecks(project, { commands: checkCommands(parsed.values.check), timeoutMs: timeoutMs(parsed.values['timeout-ms']) });
  }
  if (command === 'enable' || command === 'disable') {
    const input = { commands: checkCommands(parsed.values.check), timeoutMs: timeoutMs(parsed.values['timeout-ms']), yes: parsed.values.yes === true };
    // User proof: a human at a terminal. Claude Code's Bash tool (and `!` commands) are non-interactive, so they only create a request.
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) return requestProjectChange(project, command, input);
    return command === 'enable' ? enableProject(project, input) : disableProject(project);
  }
  if (command === 'run') {
    const executable = (name: string, fallback: string): string => {
      const value = parsed.values[name];
      const path = typeof value === 'string' ? resolve(value) : findExecutable(fallback);
      if (!path) throw new Error(`${fallback} not found on PATH; pass --${name} PATH`);
      return path;
    };
    const configured = process.env.OPTIMIZER_BIN;
    const tier = parsed.values.tier;
    if (tier !== undefined && tier !== 'standard') throw new Error('--tier accepts only standard (the light tier is chosen by policy, never forced)');
    const result = managedRun({
      ...(tier === 'standard' ? { tier } : {}),
      project, prompt: readInput(required('prompt-file')),
      maxTurns: typeof parsed.values['max-turns'] === 'string' ? pageNumber(parsed.values['max-turns'], 'max-turns', 1000) : 30,
      timeoutMs: typeof parsed.values['timeout-ms'] === 'string' ? pageNumber(parsed.values['timeout-ms'], 'timeout-ms', 4 * 60 * 60 * 1000) : 30 * 60 * 1000,
      claude: executable('claude', 'claude'), hook: executable('hook', 'optimizer-claude-hook'),
      claudeArgs: typeof parsed.values['claude-args'] === 'string' ? claudeArgs(parsed.values['claude-args']) : [],
      runtimeBin: configured && isAbsolute(configured) ? configured : realpathSync(process.argv[1] ?? ''),
    });
    // An unverified or failed run is never reported as success.
    if (result.outcome !== 'VERIFIED') process.exitCode = 1;
    return result;
  }
  if (command === 'prompt') return capturePrompt(project, readInput(required('file')), process.env.OPTIMIZER_HOOK_TOKEN);
  if (command === 'gate') {
    const input: unknown = typeof parsed.values['input-file'] === 'string' ? JSON.parse(readInput(parsed.values['input-file'])) : {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Tool input must be a JSON object');
    return gate(project, required('tool'), { ...input });
  }
  if (command === 'start-from-prompt' || command === 'blocked') {
    const config = readProjectConfig(project);
    if (!config || !sameSecret(process.env.OPTIMIZER_HOOK_TOKEN ?? '', config.hookToken)) throw new Error(`${command} requires the hook token`);
  }
  const active = (): string | null => typeof parsed.values.session === 'string' ? parsed.values.session : readProjectConfig(project)?.activeSessionId ?? null;
  if (command === 'decide' && !active()) return { sessionId: null, decision: null, reason: 'No active optimizer session.' };
  if (command === 'current') {
    const config = readProjectConfig(project);
    const { activeSessionId, ...view } = projectView(config);
    if (!view.enabled) return { ...view, sessionId: null, action: null, phase: null, checkpoint: null, summary: '' };
    if (!activeSessionId) return { ...view, sessionId: null, action: null, phase: null, checkpoint: null, summary: 'No active optimizer session.' };
  }
  const runtime = new Runtime(project);
  try {
    if (command === 'init') return { projectRoot: runtime.projectRoot };
    if (command === 'current') {
      const { activeSessionId: sessionId, ...view } = projectView(readProjectConfig(project));
      if (!sessionId) throw new Error('No active session');
      const action = runtime.next(sessionId);
      const checkpoint = runtime.decide(sessionId);
      return { ...view, sessionId, action, phase: checkpoint.phase, checkpoint, summary: sessionSummary(runtime.get(sessionId), action) };
    }
    if (command === 'start') {
      const checks: unknown = typeof parsed.values.checks === 'string' ? JSON.parse(readInput(required('checks'))) : undefined;
      return runtime.start({ request: readInput(required('request')), ...(checks === undefined ? {} : { checks }), replace: parsed.values.replace === true, agent: true });
    }
    if (command === 'start-from-prompt') {
      const { session, created } = runtime.startFromPrompt(required('prompt'));
      return { session, created, checkpoint: runtime.decide(session.id) };
    }
    if (command === 'experiences') return runtime.experiences(typeof parsed.values.session === 'string' ? parsed.values.session : undefined);
    if (command === 'decide') return runtime.decide(active() ?? required('session'));
    if (command === 'blocked') return runtime.block(active() ?? required('session'), required('reason'));
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
      case 'metrics': return { ...runtime.cost(sessionId), measurements: runtime.measurements(sessionId) };
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
