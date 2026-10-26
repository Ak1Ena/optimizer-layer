import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Runtime } from './runtime.ts';
import { verifiedRequirementIds } from './intelligence.ts';
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
  const times = [...runtime.events(id).map(({ event }) => event.at), ...runtime.measurements(id).map(item => item.at)];
  return {
    id,
    lastActivity: times.reduce<string | null>((max, at) => (max === null || at > max ? at : max), null),
    status: projectStatus({ nextAction: action }, false),
    verifiedRequirements: verifiedRequirementIds(state),
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

type Latest = { error?: string; nextAction?: { kind: string } } | undefined;

/** Home-page status from the newest session's next action; a pending check proposal always needs the user. */
export function projectStatus(latest: Latest, pending: boolean): 'waiting' | 'working' | 'paused' | 'verified' | 'idle' | 'error' {
  if (latest?.error !== undefined) return 'error';
  const kind = latest?.nextAction?.kind;
  if (pending || kind === 'clarify' || kind === 'escalate') return 'waiting';
  if (kind === undefined) return 'idle';
  return kind === 'complete' ? 'verified' : kind === 'reconsider' ? 'paused' : 'working';
}

function projectState(root: string) {
  const { pendingChecks, ...view } = projectView(readProjectConfig(root));
  const project = { root, ...view, pendingChecks: pendingChecks?.argv ?? null };
  if (!existsSync(join(root, '.optimizer', 'runtime.sqlite'))) return { ...project, status: projectStatus(undefined, pendingChecks !== null), lastActivity: null, sessionCount: 0, sessions: [] };
  const runtime = new Runtime(root, { readOnly: true });
  try {
    const ids = runtime.sessions();
    // shortcut: each session view rescans the project for staleness, so only the newest sessions are shown; page if users need more.
    const sessions = ids.slice(0, sessionLimit).map(id => {
      try {
        return sessionView(runtime, id);
      } catch (error) {
        return { id, status: 'error' as const, error: message(error) };
      }
    });
    const lastActivity = sessions.reduce<string | null>((max, item) => ('lastActivity' in item && item.lastActivity !== null && (max === null || item.lastActivity > max) ? item.lastActivity : max), null);
    return { ...project, status: projectStatus(sessions[0], pendingChecks !== null), lastActivity, sessionCount: ids.length, sessions };
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
        return { root, status: 'error' as const, lastActivity: null, error: message(error) };
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
:root { color-scheme: light dark; --bg: #f6f5f1; --fg: #1c1b19; --muted: #6b6860; --card: #fffefb; --line: #e1ded5; --accent: #2a5db0;
  --waiting-bg: #fde9c4; --waiting-fg: #7a4a00; --working-bg: #d9e7fb; --working-fg: #1d4585; --paused-bg: #ece3f7; --paused-fg: #5a3a8a;
  --verified-bg: #d8f0de; --verified-fg: #17612e; --idle-bg: #ebe9e2; --idle-fg: #5d5a52; --error-bg: #f9d9d5; --error-fg: #a02418; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ebe9e3; --muted: #9d9a90; --card: #1e1e1c; --line: #34332f; --accent: #8fb4f0;
  --waiting-bg: #4a3710; --waiting-fg: #f6cd82; --working-bg: #1b3252; --working-fg: #a8c8f5; --paused-bg: #35294d; --paused-fg: #cdb5f0;
  --verified-bg: #173a24; --verified-fg: #8fdba5; --idle-bg: #2b2a27; --idle-fg: #a8a59b; --error-bg: #4d1f1a; --error-fg: #ffa89e; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 20px 0 6px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
a { color: var(--accent); }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.path { word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
.head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; align-items: baseline; margin-bottom: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.pill.waiting { background: var(--waiting-bg); color: var(--waiting-fg); }
.pill.working { background: var(--working-bg); color: var(--working-fg); }
.pill.paused { background: var(--paused-bg); color: var(--paused-fg); }
.pill.verified { background: var(--verified-bg); color: var(--verified-fg); }
.pill.idle { background: var(--idle-bg); color: var(--idle-fg); }
.pill.error { background: var(--error-bg); color: var(--error-fg); }
.cols, .row { display: grid; grid-template-columns: minmax(0, 2fr) 9.5em minmax(0, 3fr) 7em 5em; gap: 4px 14px; align-items: center; }
.cols { padding: 0 16px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin: 8px 0; color: inherit; text-decoration: none; }
.row:hover, .row:focus-visible { border-color: var(--accent); outline: none; }
.name { font-weight: 600; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { text-align: right; }
.toggle { background: none; border: 1px solid var(--line); border-radius: 8px; color: var(--accent); padding: 6px 12px; font: inherit; cursor: pointer; margin-top: 8px; }
.next { font-size: 17px; font-weight: 600; margin: 8px 0 4px; }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { padding: 6px 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1.6em minmax(0, 1fr); }
ul.plain li:first-child { border-top: 0; }
.ok { color: var(--verified-fg); font-weight: 700; }
.todo { color: var(--muted); }
.runs { display: grid; grid-template-columns: max-content max-content max-content; gap: 4px 18px; }
details { border-top: 1px solid var(--line); padding: 8px 0; }
summary { cursor: pointer; }
@media (max-width: 680px) {
  body { padding: 12px; }
  .cols { display: none; }
  .row { grid-template-columns: minmax(0, 1fr) auto; }
  .row .task { grid-column: 1 / -1; }
  .row .num { text-align: left; }
}
</style>
</head>
<body>
<main>
<div id="app"></div>
<p class="muted small" id="status">Loading...</p>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const labels = { waiting: 'Waiting for you', working: 'Working', paused: 'Paused', verified: 'Verified', idle: 'Idle', error: 'Unreadable' };
const opened = new Set();
let data = null;
let lastText = '';
let showIdle = false;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function pill(status) { return el('span', labels[status] || status, 'pill ' + status); }
function baseName(path) { return path.split('/').filter(Boolean).pop() || path; }
function duration(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
function ago(iso) {
  if (!iso) return 'no activity';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}
function clip(text, max) { return text.length > max ? text.slice(0, max - 1) + '…' : text; }
function firstTask(session) {
  const first = session && !session.error && session.requirements[0];
  return first ? first.statement : '';
}
function nextStep(session) {
  const kind = session.nextAction.kind;
  const question = session.openQuestions.find(q => q.owner === 'human') || session.openQuestions[0];
  const why = session.control.reason ? ' (' + session.control.reason + ')' : '';
  if (kind === 'review') return 'Claude must review and accept the contract.';
  if (kind === 'retrieve') return 'Claude is gathering project context.';
  if (kind === 'clarify') return question ? 'Waiting for your answer: ' + question.question : 'Waiting for your answer: ' + session.nextAction.reason;
  if (kind === 'execute') return 'Claude is implementing; checks run next.';
  if (kind === 'verify') return 'Checks are running to verify the work.';
  if (kind === 'reconsider') return 'Paused: Claude must explain whether to keep or change its approach' + why + '.';
  if (kind === 'escalate') return 'Needs you: ' + session.nextAction.reason;
  return 'Verified: all requirements passed.';
}
function route() {
  const match = /^#p=(.+)$/.exec(location.hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (error) { return null; }
}

function taskBody(session) {
  const box = el('div');
  if (session.error) { box.append(el('p', 'Unreadable: ' + session.error, 'pill error')); return box; }
  box.append(el('div', nextStep(session), 'next'));
  box.append(el('div', 'Last activity ' + ago(session.lastActivity) + ' · goal v' + session.goalVersion + ' · ' + session.review, 'muted small'));
  box.append(el('h2', 'Requirements'));
  const reqs = el('ul', null, 'plain');
  for (const r of session.requirements) {
    const done = session.verifiedRequirements.includes(r.id);
    const li = el('li');
    li.append(el('span', done ? '✓' : '○', done ? 'ok' : 'todo'));
    const body = el('div');
    body.append(el('div', r.statement), el('div', 'Accepted when: ' + (r.acceptance || '(missing)'), 'muted small'));
    li.append(body);
    reqs.append(li);
  }
  box.append(reqs);
  if (session.openQuestions.length) {
    box.append(el('h2', 'Open questions'));
    const qs = el('ul', null, 'plain');
    for (const q of session.openQuestions) {
      const li = el('li');
      li.append(el('span', '?', 'todo'));
      li.append(el('div', q.question + ' (' + q.owner + ')'));
      qs.append(li);
    }
    box.append(qs);
  }
  box.append(el('h2', 'Check runs'));
  if (!session.checkRuns.length) box.append(el('p', 'No checks have run yet.', 'muted small'));
  else {
    const runs = el('div', null, 'runs small');
    for (const c of session.checkRuns.slice().reverse()) {
      runs.append(el('span', new Date(c.at).toLocaleString(), 'muted'), el('span', c.outcome, c.outcome === 'passed' ? 'ok' : ''), el('span', duration(c.durationMs), 'muted'));
    }
    box.append(runs);
  }
  return box;
}
function argvList(rows, empty) {
  if (!rows || !rows.length) return el('p', empty, 'muted small');
  const box = el('div');
  for (const argv of rows) box.append(el('div', argv.join(' '), 'mono'));
  return box;
}

function detail(item) {
  const frag = document.createDocumentFragment();
  const back = el('a', '← All projects');
  back.href = '#';
  frag.append(back);
  const head = el('div', null, 'head');
  const title = el('div');
  title.append(el('h1', baseName(item.root)), el('div', item.root, 'muted small path'));
  head.append(title, pill(item.status));
  frag.append(head);
  if (item.error) { frag.append(el('p', 'Unreadable: ' + item.error, 'pill error')); return frag; }
  if (!item.enabled) frag.append(el('p', 'Optimizer is turned off for this project (opted out). History is kept.', 'muted'));
  if (item.pendingChecks) {
    const card = el('div', null, 'card');
    card.append(el('div', 'A check proposal is waiting for your approval. Approve it in the Claude chat.', 'next'), argvList(item.pendingChecks, ''));
    frag.append(card);
  }
  const [latest, ...older] = item.sessions;
  const card = el('div', null, 'card');
  if (latest) {
    card.append(el('h2', 'Current task'), el('div', latest.error ? latest.id : firstTask(latest)));
    card.append(taskBody(latest));
  } else card.append(el('p', 'No tasks yet. A task starts when Claude drafts a contract for a coding request in this folder.', 'muted'));
  frag.append(card);
  const checks = el('div', null, 'card');
  checks.append(el('h2', 'Approved checks'), argvList(item.checks, 'None approved yet.'));
  frag.append(checks);
  if (older.length) {
    const history = el('div', null, 'card');
    history.append(el('h2', 'Older tasks (' + older.length + (item.sessionCount > item.sessions.length ? ' of ' + (item.sessionCount - 1) : '') + ')'));
    for (const s of older) {
      const box = el('details');
      const key = item.root + '|' + s.id;
      box.open = opened.has(key);
      box.addEventListener('toggle', () => { if (box.open) opened.add(key); else opened.delete(key); });
      const summary = el('summary');
      summary.append(pill(s.status), el('span', ' ' + clip(firstTask(s) || s.id, 80) + ' · ' + ago(s.lastActivity), 'small'));
      box.append(summary, taskBody(s));
      history.append(box);
    }
    frag.append(history);
  }
  return frag;
}
function listView(projects) {
  const frag = document.createDocumentFragment();
  const shown = projects.filter(p => p.status !== 'idle');
  const idle = projects.filter(p => p.status === 'idle');
  const sorted = list => list.slice().sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  const count = status => shown.filter(p => p.status === status).length;
  const parts = [['waiting', 'waiting for you'], ['working', 'working'], ['paused', 'paused'], ['verified', 'verified'], ['error', 'unreadable']].filter(([s]) => count(s)).map(([s, text]) => count(s) + ' ' + text);
  const head = el('div', null, 'head');
  head.append(el('h1', 'Optimizer'), el('div', parts.length ? parts.join(' · ') : 'Nothing active', 'muted'));
  frag.append(head);
  if (!projects.length) {
    const card = el('div', null, 'card');
    card.append(el('div', 'No projects yet', 'next'), el('p', 'A project appears here after its first Claude Code prompt in a folder with the optimizer hooks installed. Open Claude Code in a project, send a prompt, and it shows up within a few seconds.', 'muted'));
    frag.append(card);
    return frag;
  }
  if (shown.length) {
    const cols = el('div', null, 'cols');
    for (const name of ['Project', 'Status', 'Task', 'Last activity', 'Checks']) cols.append(el('span', name));
    frag.append(cols);
  }
  const row = p => {
    const a = el('a', null, 'row');
    a.href = '#p=' + encodeURIComponent(p.root);
    const name = el('div');
    name.append(el('div', baseName(p.root), 'name clip'), el('div', p.root, 'muted small clip'));
    const task = p.error ? p.error : p.sessions[0] ? firstTask(p.sessions[0]) : 'No tasks yet';
    a.append(name, pill(p.status), el('div', clip(task, 120), 'task clip' + (p.sessions && p.sessions[0] ? '' : ' muted')), el('div', ago(p.lastActivity), 'small muted'), el('div', p.error ? '' : (p.checks.length + (p.checks.length === 1 ? ' check' : ' checks')), 'small muted num'));
    return a;
  };
  for (const p of sorted(shown)) frag.append(row(p));
  if (!shown.length) frag.append(el('p', 'No project has an active or finished task right now.', 'muted'));
  if (idle.length) {
    const button = el('button', (showIdle ? 'Hide ' : 'Show ') + idle.length + ' idle project' + (idle.length === 1 ? '' : 's'), 'toggle');
    button.type = 'button';
    button.addEventListener('click', () => { showIdle = !showIdle; render(); });
    frag.append(button);
    if (showIdle) for (const p of sorted(idle)) frag.append(row(p));
  }
  return frag;
}

function render() {
  if (!data) return;
  const selected = route();
  const item = selected === null ? null : data.projects.find(p => p.root === selected);
  const app = document.getElementById('app');
  const y = window.scrollY;
  app.replaceChildren(item ? detail(item) : listView(data.projects));
  window.scrollTo(0, y);
}
async function refresh() {
  const status = document.getElementById('status');
  try {
    const response = await fetch('/api/state?token=' + encodeURIComponent(token), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const fresh = JSON.parse(await response.text());
    // Compare without generatedAt, which changes on every request; identical data keeps rows clickable.
    const text = JSON.stringify({ ...fresh, generatedAt: null });
    const active = document.activeElement;
    const busy = (active && active.closest && active.closest('a, button, summary')) || String(getSelection()) !== '';
    if (!data || (text !== lastText && !busy)) { lastText = text; data = fresh; render(); }
    status.textContent = 'Updated ' + new Date(fresh.generatedAt).toLocaleTimeString() + '; refreshes every 5 s.';
    status.className = 'muted small';
  } catch (error) {
    status.textContent = 'Refresh failed: ' + error.message;
    status.className = 'pill error';
  }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
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
