import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Runtime } from './runtime.ts';
import { projectView, readProjectConfig, registeredProjects } from './project.ts';

const sessionLimit = 20;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only contract-level facts: never prompt text, resolved answers, check output or the hook token. */
function sessionView(runtime: Runtime, id: string) {
  const state = runtime.get(id);
  const action = runtime.next(id);
  const timing = { optimizerMs: 0, externalMs: 0 };
  for (const item of runtime.measurements(id)) {
    timing.optimizerMs += item.optimizerMs;
    timing.externalMs += item.externalMs;
  }
  return {
    id,
    goalVersion: state.goal.version,
    requirements: state.goal.requirements.map(({ id, statement, acceptance }) => ({ id, statement, acceptance })),
    openQuestions: state.goal.uncertainties.filter(item => item.resolution.kind === 'open').map(({ id, owner, question }) => ({ id, owner, question })),
    review: state.review.kind === 'pending' ? 'pending' : `${state.review.kind} for version ${state.review.goalVersion}`,
    nextAction: { kind: action.kind, reason: action.reason },
    control: state.control.kind === 'running' ? { kind: 'running', reason: null } : { kind: state.control.kind, reason: state.control.reason },
    checkRuns: runtime.events(id).flatMap(({ event }) => event.payload.kind === 'command.observed'
      ? [{ checkId: event.payload.evidence.checkId, outcome: event.payload.evidence.result.outcome, durationMs: event.payload.evidence.result.durationMs, at: event.payload.evidence.at }]
      : []),
    completionClaimed: state.completionClaimed,
    complete: action.kind === 'complete',
    timing,
  };
}

function projectState(root: string) {
  const { pendingChecks, ...view } = projectView(readProjectConfig(root));
  const project = { root, ...view, pendingChecks: pendingChecks?.argv ?? null };
  if (!existsSync(join(root, '.optimizer', 'runtime.sqlite'))) return { ...project, sessionCount: 0, sessions: [] };
  const runtime = new Runtime(root, { readOnly: true });
  try {
    const ids = runtime.sessions();
    // shortcut: each session view rescans the project for staleness, so only the newest sessions are shown; page if users need more.
    const sessions = ids.slice(0, sessionLimit).map(id => {
      try {
        return sessionView(runtime, id);
      } catch (error) {
        return { id, error: message(error) };
      }
    });
    return { ...project, sessionCount: ids.length, sessions };
  } finally {
    runtime.close();
  }
}

export function dashboardState() {
  return {
    generatedAt: new Date().toISOString(),
    projects: registeredProjects().filter(root => existsSync(root)).map(root => {
      try {
        return projectState(root);
      } catch (error) {
        return { root, error: message(error) };
      }
    }),
  };
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Optimizer dashboard</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1d1d1f; --muted: #666; --card: #fff; --line: #ddd; --bad: #b3261e; --good: #1b7a3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececec; --muted: #9a9a9a; --card: #222226; --line: #3a3a3e; --bad: #ff8a80; --good: #7bd88f; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 8px; word-break: break-all; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; }
dt { color: var(--muted); }
dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
details { border-top: 1px solid var(--line); padding: 6px 0; }
summary { cursor: pointer; font-weight: 600; }
table { border-collapse: collapse; margin: 4px 0; }
td, th { text-align: left; padding: 2px 10px 2px 0; vertical-align: top; }
.muted { color: var(--muted); }
.bad { color: var(--bad); }
.good { color: var(--good); }
code, .mono { font-family: ui-monospace, monospace; font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Optimizer dashboard</h1>
<p class="muted" id="status">Loading...</p>
<div id="projects"></div>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const opened = new Set();
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function duration(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
function list(rows) { return rows.length ? rows.map(argv => argv.join(' ')).join('\\n') : 'none'; }
function fields(pairs) {
  const dl = el('dl');
  for (const [name, value, className] of pairs) dl.append(el('dt', name), el('dd', value, className));
  return dl;
}
function table(head, rows) {
  const node = el('table');
  const top = el('tr');
  for (const name of head) top.append(el('th', name));
  node.append(top);
  for (const row of rows) {
    const line = el('tr');
    for (const cell of row) line.append(el('td', cell));
    node.append(line);
  }
  return node;
}
function session(item, active) {
  const box = el('details');
  box.open = opened.has(item.id) || (item.id === active && !opened.has('closed:' + item.id));
  box.addEventListener('toggle', () => {
    opened.delete(box.open ? 'closed:' + item.id : item.id);
    opened.add(box.open ? item.id : 'closed:' + item.id);
  });
  if (item.error) {
    box.append(el('summary', item.id), el('p', 'Unreadable: ' + item.error, 'bad'));
    return box;
  }
  const state = item.complete ? 'complete' : item.nextAction.kind;
  box.append(el('summary', item.id + ' | goal v' + item.goalVersion + ' | ' + state + (item.id === active ? ' | active' : '')));
  box.append(fields([
    ['Next action', item.nextAction.kind + ': ' + item.nextAction.reason],
    ['Review', item.review],
    ['Control', item.control.kind + (item.control.reason ? ' (' + item.control.reason + ')' : ''), item.control.kind === 'running' ? '' : 'bad'],
    ['Completion', item.complete ? 'verified complete' : item.completionClaimed ? 'claimed, not verified' : 'not claimed', item.complete ? 'good' : ''],
    ['Timing', 'optimizer ' + duration(item.timing.optimizerMs) + ', external ' + duration(item.timing.externalMs)],
  ]));
  box.append(el('strong', 'Requirements'), table(['ID', 'Requirement', 'Acceptance'], item.requirements.map(r => [r.id, r.statement, r.acceptance || '(missing)'])));
  box.append(el('strong', 'Open questions'));
  box.append(item.openQuestions.length ? table(['ID', 'Owner', 'Question'], item.openQuestions.map(q => [q.id, q.owner, q.question])) : el('p', 'none', 'muted'));
  box.append(el('strong', 'Check runs'));
  box.append(item.checkRuns.length ? table(['Check', 'Outcome', 'Duration', 'Time'], item.checkRuns.slice().reverse().map(c => [c.checkId, c.outcome, duration(c.durationMs), new Date(c.at).toLocaleString()])) : el('p', 'none', 'muted'));
  return box;
}
function project(item) {
  const box = el('section');
  box.append(el('h2', item.root));
  if (item.error) {
    box.append(el('p', 'Unreadable: ' + item.error, 'bad'));
    return box;
  }
  box.append(fields([
    ['State', item.enabled ? 'enabled' : 'disabled (opted out)', item.enabled ? '' : 'muted'],
    ['Approved checks', list(item.checks)],
    ['Pending proposal', item.pendingChecks ? list(item.pendingChecks) + '\\n(the user approves it in chat)' : 'none'],
    ['Active session', item.activeSessionId || 'none'],
    ['Sessions', item.sessionCount > item.sessions.length ? item.sessions.length + ' newest of ' + item.sessionCount : String(item.sessionCount)],
  ]));
  for (const entry of item.sessions) box.append(session(entry, item.activeSessionId));
  return box;
}
async function refresh() {
  const status = document.getElementById('status');
  try {
    const response = await fetch('/api/state?token=' + encodeURIComponent(token), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const state = await response.json();
    document.getElementById('projects').replaceChildren(...state.projects.map(project));
    status.textContent = state.projects.length ? 'Updated ' + new Date(state.generatedAt).toLocaleTimeString() + '; refreshes every 5 s.' : 'No projects yet. A project appears after its first Claude Code prompt.';
    status.className = 'muted';
  } catch (error) {
    status.textContent = 'Refresh failed: ' + error.message;
    status.className = 'bad';
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;

const baseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

/** Read-only local page. Token and Host checks keep other local pages and DNS rebinding out. */
export function startDashboard(port: number): Promise<{ server: Server; url: string }> {
  const token = Buffer.from(randomBytes(24).toString('hex'));
  const server = createServer((request, response) => {
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const supplied = Buffer.from(url.searchParams.get('token') ?? '');
    const host = request.headers.host;
    const allowed = (host === `127.0.0.1:${bound}` || host === `localhost:${bound}`) && supplied.length === token.length && timingSafeEqual(supplied, token);
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { ...baseHeaders, 'Content-Type': type, ...headers });
      response.end(body);
    };
    if (!allowed) return send(403, 'text/plain; charset=utf-8', 'Forbidden\n');
    if (request.method !== 'GET') return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET' });
    if (url.pathname === '/') {
      return send(200, 'text/html; charset=utf-8', page, {
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
    }
    if (url.pathname === '/api/state') {
      try {
        return send(200, 'application/json; charset=utf-8', JSON.stringify(dashboardState()));
      } catch (error) {
        return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: message(error) }));
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${bound}/?token=${token.toString()}` });
    });
  });
}
