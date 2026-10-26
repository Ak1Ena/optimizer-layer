import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runtime } from '../packages/runtime/src/index.ts';

const work = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/experiment-report.mjs /experiment/work/dir');
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const json = path => { try { return JSON.parse(read(path)); } catch { return null; } };

function acceptance(project) {
  const result = spawnSync(process.execPath, [join(work, 'acceptance.mjs'), project], { encoding: 'utf8', timeout: 10_000 });
  return { passed: result.status === 0, output: (result.stdout || result.stderr).trim().slice(0, 300) };
}

function optimizer(project) {
  if (!existsSync(join(project, '.optimizer', 'runtime.sqlite'))) return { sessions: 0 };
  const runtime = new Runtime(project, { readOnly: true });
  try {
    const sessions = runtime.sessions();
    return {
      sessions: sessions.length,
      perSession: sessions.map(id => {
        const events = runtime.events(id).map(item => item.event.payload);
        const phases = events.filter(item => item.kind === 'workflow.transitioned').map(item => item.to);
        const checks = events.filter(item => item.kind === 'command.observed').map(item => item.evidence.result.outcome);
        return {
          origin: runtime.get(id).origin ?? null,
          phases,
          reviewed: events.some(item => item.kind === 'contract.reviewed'),
          assessed: events.some(item => item.kind === 'context.assessed'),
          checks,
          strategyResponses: events.filter(item => item.kind === 'strategy.resolved').length,
          decisions: runtime.experiences(id).map(item => item.chosenAction),
          finalDecision: runtime.decide(id).decision,
        };
      }),
    };
  } finally {
    runtime.close();
  }
}

function claude(name) {
  const raw = name === 'managed' ? json(join(work, 'managed.run.json')) : json(join(work, `${name}.claude.json`));
  if (!raw) return { error: read(join(work, `${name}.${name === 'managed' ? 'run' : 'claude'}.err`)).slice(0, 300) };
  if (name === 'managed') return { outcome: raw.outcome, phase: raw.phase, turns: raw.turns, usage: raw.usage, timedOut: raw.timedOut, agentExitCode: raw.agentExitCode };
  return { turns: raw.num_turns ?? null, usage: raw.usage ?? null, costUsd: raw.total_cost_usd ?? null, isError: raw.is_error ?? null };
}

const report = {};
for (const name of ['advisory', 'plugin', 'managed']) {
  const project = join(work, name);
  report[name] = {
    seconds: Number(read(join(work, `${name}.seconds`)).trim()) || null,
    independentAcceptance: acceptance(project),
    agent: claude(name),
    optimizer: optimizer(project),
  };
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
