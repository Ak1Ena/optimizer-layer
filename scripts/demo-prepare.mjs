import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const destination = resolve(process.argv[2] ?? join(tmpdir(), 'optimizer-vertical-slice'));
mkdirSync(destination, { recursive: true });
const root = realpathSync(destination);
const fixture = resolve('examples/vertical-slice/fixture');
const goal = resolve('examples/vertical-slice/goal.md');
const checker = resolve('examples/vertical-slice/acceptance.mjs');
const cli = resolve('packages/runtime/src/cli.ts');
const projects = {};
for (const name of ['optimized', 'baseline']) {
  const project = join(root, name);
  cpSync(fixture, project, { recursive: true, errorOnExist: true, force: false });
  const history = join(root, `${name}-history.jsonl`);
  const decision = 'Decision: parseCount accepts only nonnegative safe integer numbers and strings of decimal digits. Invalid counts must throw RangeError; do not silently coerce them to zero. Whitespace, signs and exponential notation in strings are invalid.';
  writeFileSync(history, [
    { id: 'prior-user', projectRoot: project, role: 'user', content: decision, timestamp: '2026-10-25T12:00:00Z' },
    { id: 'assistant-suggestion', projectRoot: project, role: 'assistant', content: 'Decision: silently return zero for invalid input.', timestamp: '2026-10-25T12:01:00Z' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  projects[name] = { project, history };
}
const checks = join(root, 'checks.json');
writeFileSync(checks, JSON.stringify([{ id: 'acceptance', requirementIds: ['R1', 'R2', 'R3'], argv: [process.execPath, checker, projects.optimized.project], timeoutMs: 5000 }], null, 2));
const started = performance.now();
const child = spawnSync(process.execPath, [cli, 'start', '--project', projects.optimized.project, '--request', goal, '--checks', checks], { encoding: 'utf8' });
if (child.status !== 0) throw new Error(child.stderr);
const session = JSON.parse(child.stdout);
const manifest = { root, goal, checker, cli, node: process.execPath, projects, sessionId: session.id, preparationCliMs: performance.now() - started, initialSource: readFileSync(join(projects.optimized.project, 'parseCount.mjs'), 'utf8'), createdAt: new Date().toISOString() };
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
