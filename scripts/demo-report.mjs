import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runtime } from '../packages/runtime/src/index.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/demo-report.mjs /absolute/demo-directory');
const root = resolve(directory);
const readJson = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const manifest = readJson('manifest.json');
const baseline = readJson('baseline-result.json');
const optimized = readJson('optimized-result.json');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const initialDigest = createHash('sha256').update(manifest.initialSource).digest('hex');
assert.equal(baseline.initialCodeHashes['parseCount.mjs'], initialDigest);
assert.equal(optimized.initialSourceHash, initialDigest);
assert.deepEqual(baseline.initialExitStatuses, [1, 1, 1]);
assert.equal(optimized.matched3.initialFailures, 3);
assert.equal(optimized.initialHistoryHash, hash(manifest.projects.optimized.history));
assert.equal(optimized.initialCheckerHash, hash(manifest.checker));

function independentlyCheck(project) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [manifest.checker, project], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.verified, ['R1', 'R2', 'R3']);
  return { ...output, exitCode: result.status, durationMs: performance.now() - started, sourceDigest: hash(join(project, 'parseCount.mjs')), finalSource: readFileSync(join(project, 'parseCount.mjs'), 'utf8') };
}

const finalChecks = {
  baseline: independentlyCheck(manifest.projects.baseline.project),
  optimized: independentlyCheck(manifest.projects.optimized.project),
};
const runtime = new Runtime(manifest.projects.optimized.project, { readOnly: true });
try {
  const state = runtime.get(manifest.sessionId);
  const action = runtime.next(manifest.sessionId);
  assert.equal(action.kind, 'complete');
  const events = runtime.events(manifest.sessionId);
  const observations = events.filter(item => item.event.payload.kind === 'command.observed');
  assert.deepEqual(observations.slice(0, 3).map(item => item.event.payload.evidence.result.outcome), ['failed', 'failed', 'failed']);
  assert.ok(observations.some(item => item.event.payload.control.kind === 'paused'));
  assert.ok(events.some(item => item.event.payload.kind === 'strategy.resolved'));
  const metrics = runtime.measurements(manifest.sessionId);
  const sum = field => metrics.reduce((total, item) => total + item[field], 0);
  const cliWall = optimized.cliCalls.map(item => item.wallMs).sort((left, right) => left - right);
  const allEvidence = observations.map(item => item.event.payload.evidence);
  const childMs = allEvidence.reduce((total, item) => total + item.result.durationMs, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    scenario: 'Controlled single-task functional demonstration; not an efficiency experiment.',
    harness: 'Two actual collaboration coding agents using the session default model. Exact model usage metadata unavailable.',
    runtime: { node: process.version, sessionId: manifest.sessionId, project: manifest.projects.optimized.project, action },
    fixture: { initialDigest, checkerDigest: hash(manifest.checker), decisionSourceDigest: hash(manifest.projects.optimized.history), syntheticHistory: true, matchedPreRepairFailures: 3 },
    baseline: { agentElapsedMs: baseline.wallTimeSeconds * 1000, timingScope: baseline.wallTimeNote, initialExitStatuses: baseline.initialExitStatuses, finalChecks: finalChecks.baseline, tokens: null },
    optimized: {
      agentElapsedMs: optimized.agentElapsedMs, timingScope: optimized.timingScope,
      finalChecks: finalChecks.optimized, tokens: null,
      requirementIds: state.goal.requirements.map(item => item.id),
      unresolvedQuestions: state.goal.uncertainties.filter(item => item.resolution.kind === 'open').length,
      context: state.context,
      assessments: events.filter(item => item.event.payload.kind === 'context.assessed').map(item => item.event.payload.assessment),
      strategyResponses: events.filter(item => item.event.payload.kind === 'strategy.resolved').map(item => item.event.payload),
      evidence: allEvidence,
    },
    overhead: {
      measurementCount: metrics.length,
      measuredLibraryMs: sum('optimizerMs'),
      measuredLibraryScope: 'Instrumented operations plus database open across the whole session, including session creation. Excludes metric persistence and uninstrumented host/agent work.',
      childProcessMs: childMs,
      adapterCallCount: cliWall.length,
      adapterWallMs: optimized.cliWallMs,
      adapterWallWithoutRegisteredChildrenMs: optimized.cliWallMs - childMs,
      adapterScope: 'Includes Node startup, transport, serialization, library work, registered check processes and failed calls. Residual after child subtraction is descriptive overhead, not CPU time or a speedup. Agent investigation/coordination time is separate.',
      callDurationSpreadMs: { min: cliWall[0], median: cliWall[Math.floor(cliWall.length / 2)], max: cliWall.at(-1) },
      preparationCliMs: manifest.preparationCliMs,
      optimizerLlmCalls: 0,
      hostAgentTokens: null,
    },
    eventTimeline: events.map(({ sequence, event }) => ({ sequence, at: event.at, kind: event.payload.kind })),
    limits: [
      'One task pair, controlled failures, non-random order, agent timing scopes not identical, and unknown host token counts cannot establish efficiency or quality improvement.',
      'The optimized run used more checks and coordination than baseline; it was slower in these recorded intervals.',
      'The supplied history is synthetic fixture data with explicit user-role provenance, not a recovered decision from an actual historical user session.',
      'The actual integration used the installable checkpoint adapter in this coding-agent harness. Hosted Codex/Claude CLI execution was not verified because network DNS was unavailable.',
    ],
    efficiencyConclusion: 'No improved efficiency established. This demonstrates integration and independently verified correctness only.',
  };
  const output = resolve('docs/runs/2026-10-26-vertical-slice-results.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, finalAction: action.kind, baselineVerified: finalChecks.baseline.verified, optimizedVerified: finalChecks.optimized.verified, overhead: report.overhead }, null, 2) + '\n');
} finally {
  runtime.close();
}
