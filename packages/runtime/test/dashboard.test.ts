import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { projectStatus, startDashboard } from '../src/dashboard.ts';
import { capturePrompt, enableProject, proposeChecks, readProjectConfig } from '../src/project.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-dashboard-')));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'config');
test.after(() => rmSync(home, { recursive: true, force: true }));

function get(port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET'): Promise<{ status: number; type: string; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type']), body, headers: response.headers }));
    });
    sent.on('error', reject);
    sent.end();
  });
}

test('dashboard serves read-only project state behind a token and Host check, without prompts or secrets', async (t) => {
  const project = join(home, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'counter.mjs'), 'export const count = 1;\n');
  const checker = join(home, 'check.mjs');
  writeFileSync(checker, 'process.stdout.write("CHECK-STDOUT-SECRET"); process.exit(0);\n');
  const secretPrompt = 'PROMPT-TEXT-SECRET answer is RangeError';
  capturePrompt(project, secretPrompt, undefined);
  enableProject(project, { commands: [`node ${checker}`], timeoutMs: 2000, yes: false });
  const config = readProjectConfig(project);
  assert.ok(config);
  const runtime = new Runtime(project);
  const session = runtime.start({ request: '- R1: <script>alert(1)</script> greeting works.\nAcceptance R1: greeting returns <b>hi</b>.\nQuestion human Q1: Which <i>language</i>?' });
  const verified = runtime.start({ request: '- R1: count is one.\nAcceptance R1: check passes.', replace: true });
  const items = runtime.retrieve(verified.id).items.map(item => item.id);
  runtime.assess(verified.id, { kind: 'sufficient', itemIds: items, rationale: 'The counter source covers R1.' });
  runtime.review(verified.id, { kind: 'accept', goalVersion: runtime.get(verified.id).goal.version, itemIds: items, rationale: 'R1 preserves the request.' });
  assert.equal(runtime.runCheck(verified.id, 'check-1').result.output.includes('CHECK-STDOUT-SECRET'), true);
  const proposal = proposeChecks(project, { commands: ['node --version'], timeoutMs: 1000 });
  runtime.close();

  const { server, url } = await startDashboard(0);
  t.after(() => server.close());
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const port = address.port;
  assert.ok(port > 0);
  const token = new URL(url).searchParams.get('token') ?? '';
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[0-9a-f]{48}$`));

  for (const [path, host] of [['/', undefined], ['/api/state', undefined], ['/api/state?token=wrong', undefined], [`/api/state?token=${token}`, 'evil.example:80'], [`/api/state?token=${token}`, `127.0.0.1:${port + 1}`]] as const) {
    const response = await get(port, path, host);
    assert.equal(response.status, 403, `${path} ${host ?? ''}`);
    assert.equal(response.body, 'Forbidden\n');
  }

  const html = await get(port, `/?token=${token}`, `localhost:${port}`);
  assert.equal(html.status, 200);
  assert.match(html.type, /^text\/html/);
  assert.match(String(html.headers['content-security-policy']), /default-src 'none'/);
  assert.match(html.body, /textContent/);
  assert.doesNotMatch(html.body, /innerHTML|<script>alert|PROMPT-TEXT-SECRET|https?:\/\/(?!127)/);

  const json = await get(port, `/api/state?token=${token}`);
  assert.equal(json.status, 200);
  assert.match(json.type, /^application\/json/);
  assert.equal(json.headers['x-content-type-options'], 'nosniff');
  for (const secret of ['PROMPT-TEXT-SECRET', 'CHECK-STDOUT-SECRET', config.hookToken, token, `"${proposal.code}"`]) {
    assert.equal(json.body.includes(secret), false, secret);
  }
  const state = JSON.parse(json.body) as { projects: Array<Record<string, unknown>> };
  assert.equal(state.projects.length, 1);
  const seeded = state.projects[0];
  assert.ok(seeded);
  assert.equal(seeded.root, project);
  assert.equal(seeded.enabled, true);
  assert.equal(seeded.activeSessionId, verified.id);
  assert.equal(seeded.status, 'waiting', 'pending proposal needs the user');
  assert.match(String(seeded.lastActivity), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(seeded.pendingChecks, [proposal.checks[0]?.argv]);
  assert.deepEqual(seeded.checks, config.checks.map(check => check.argv));
  const sessions = seeded.sessions as Array<Record<string, unknown>>;
  assert.deepEqual(sessions.map(item => item.id), [verified.id, session.id], 'newest first');
  const runs = sessions[0]?.checkRuns as Array<Record<string, unknown>>;
  assert.deepEqual(runs.map(run => [run.checkId, run.outcome, Object.keys(run).sort()]), [['check-1', 'passed', ['at', 'checkId', 'durationMs', 'outcome']]]);
  assert.deepEqual(sessions[0]?.verifiedRequirements, ['R1']);
  assert.equal(sessions[0]?.complete, true);
  assert.match(String(sessions[0]?.lastActivity), /^\d{4}-\d\d-\d\dT/);
  sessions.shift();
  assert.deepEqual(sessions[0]?.verifiedRequirements, []);
  assert.deepEqual(sessions[0]?.requirements, [{ id: 'R1', statement: '<script>alert(1)</script> greeting works.', acceptance: 'greeting returns <b>hi</b>.' }]);
  assert.deepEqual(sessions[0]?.openQuestions, [{ id: 'Q1', owner: 'human', question: 'Which <i>language</i>?' }]);
  assert.deepEqual(sessions[0]?.nextAction, { kind: 'clarify', reason: 'Critical human decisions need answers with source references' });
  assert.deepEqual(sessions[0]?.control, { kind: 'running', reason: null });
  assert.equal(sessions[0]?.review, 'pending');
  assert.deepEqual(sessions[0]?.checkRuns, []);
  assert.equal(sessions[0]?.complete, false);
  assert.ok(typeof (sessions[0]?.timing as { optimizerMs: number }).optimizerMs === 'number');

  rmSync(project, { recursive: true, force: true });
  const afterRemoval = JSON.parse((await get(port, `/api/state?token=${token}`)).body) as { projects: unknown[] };
  assert.deepEqual(afterRemoval.projects, [], 'removed projects are skipped');
  assert.equal((await get(port, `/nothing?token=${token}`)).status, 404);
  assert.equal((await get(port, `/api/state?token=${token}`, `127.0.0.1:${port}`, 'POST')).status, 405);
});

test('project status comes from the newest session next action', () => {
  const at = (kind: string) => ({ nextAction: { kind } });
  assert.equal(projectStatus(undefined, false), 'idle');
  assert.equal(projectStatus(undefined, true), 'waiting');
  for (const kind of ['clarify', 'escalate']) assert.equal(projectStatus(at(kind), false), 'waiting', kind);
  for (const kind of ['execute', 'retrieve', 'review', 'verify']) assert.equal(projectStatus(at(kind), false), 'working', kind);
  assert.equal(projectStatus(at('reconsider'), false), 'paused');
  assert.equal(projectStatus(at('complete'), false), 'verified');
  assert.equal(projectStatus(at('complete'), true), 'waiting');
  assert.equal(projectStatus({ error: 'bad' }, false), 'error');
});

test('a requirement covered by several checks is not verified until every check passed', async (t) => {
  const project = join(home, 'multi');
  mkdirSync(project);
  writeFileSync(join(project, 'counter.mjs'), 'export const count = 1;\n');
  const checker = join(home, 'ok.mjs');
  writeFileSync(checker, 'process.exit(0);\n');
  capturePrompt(project, 'multi', undefined);
  enableProject(project, { commands: [`node ${checker}`, `node ${checker} again`], timeoutMs: 2000, yes: false });
  const runtime = new Runtime(project);
  const session = runtime.start({ request: '- R1: count is one.\nAcceptance R1: both checks pass.' });
  const items = runtime.retrieve(session.id).items.map(item => item.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: items, rationale: 'The counter source covers R1.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: items, rationale: 'R1 preserves the request.' });
  runtime.runCheck(session.id, 'check-1');
  runtime.close();

  const { server, url } = await startDashboard(0);
  t.after(() => server.close());
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const token = new URL(url).searchParams.get('token') ?? '';
  const state = JSON.parse((await get(address.port, `/api/state?token=${token}`)).body) as { projects: Array<{ root: string; status: string; sessions: Array<Record<string, unknown>> }> };
  const shown = state.projects.find(item => item.root === project);
  assert.deepEqual(shown?.sessions[0]?.verifiedRequirements, [], 'one of two checks passed');
  assert.equal(shown?.sessions[0]?.status, 'working');
  assert.equal(shown?.status, 'working');
});
