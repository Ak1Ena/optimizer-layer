import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Runtime } from '../../runtime/src/index.ts';

class VersionedStdioTransport extends StdioClientTransport {
  protocolVersion: string | undefined;

  setProtocolVersion(version: string): void { this.protocolVersion = version; }
}

const serverPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function project(t: test.TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'optimizer-mcp-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, 'project');
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'counter.mjs'), 'export const count = 2;\n');
  return projectRoot;
}

async function connect(t: test.TestContext, projectRoot: string) {
  const transport = new VersionedStdioTransport({
    command: process.execPath,
    args: ['--conditions=development', serverPath, '--project', projectRoot],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'optimizer-integration-test', version: '1.0.0' });
  t.after(async () => client.close());
  await client.connect(transport);
  assert.equal(transport.protocolVersion, '2025-11-25');
  return client;
}

test('official SDK initializes stdio server and exposes only two annotated read-only tools', async (t) => {
  const projectRoot = project(t);
  const runtime = new Runtime(projectRoot);
  const session = runtime.start({ request: '- R1: SECRET_GOAL stays local\nAcceptance R1: counter works', checks: [] });
  const eventsBefore = runtime.events(session.id);
  const measurementsBefore = runtime.measurements(session.id);
  t.after(() => runtime.close());
  const client = await connect(t, projectRoot);
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
  assert.deepEqual(client.getServerVersion(), { name: 'optimizer-layer', version: '0.1.0' });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['optimizer_session_events', 'optimizer_session_status']);
  assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false));
  assert.ok(tools.tools.every(tool => tool.inputSchema.additionalProperties === false));
  const response = await client.callTool({ name: 'optimizer_session_status', arguments: { sessionId: session.id } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    sessionId: session.id,
    control: { kind: 'running', rounds: 0 },
    next: { kind: 'retrieve', route: 'local' },
    completionClaimed: false,
    requirementCount: 1,
    unresolvedUncertaintyCount: 0,
    context: { current: false, itemCount: 0, complete: false, assessment: null },
    checkCount: 0,
    observationCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(response), /SECRET_GOAL|counter\.mjs|argv|output|projectRoot/);
  assert.deepEqual(runtime.events(session.id), eventsBefore);
  assert.deepEqual(runtime.measurements(session.id), measurementsBefore);
});

test('event pagination uses sequence cursors and returns bounded metadata without payloads', async (t) => {
  const projectRoot = project(t);
  const runtime = new Runtime(projectRoot);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: SECRET_GOAL\nAcceptance R1: counter works', checks: [] });
  runtime.retrieve(session.id);
  runtime.claim(session.id);
  const client = await connect(t, projectRoot);
  const page = await client.callTool({ name: 'optimizer_session_events', arguments: { sessionId: session.id, limit: 2 } });
  const events = runtime.events(session.id);
  const firstTwo = events.slice(0, 2);
  assert.deepEqual(page.structuredContent, {
    sessionId: session.id,
    events: firstTwo.map(({ sequence, event }) => ({ sequence, at: event.at, kind: event.payload.kind })),
    nextAfterSequence: firstTwo.at(-1)?.sequence,
  });
  const last = await client.callTool({ name: 'optimizer_session_events', arguments: { sessionId: session.id, limit: 2, afterSequence: firstTwo.at(-1)?.sequence } });
  assert.deepEqual(last.structuredContent, {
    sessionId: session.id,
    events: events.slice(2).map(({ sequence, event }) => ({ sequence, at: event.at, kind: event.payload.kind })),
    nextAfterSequence: null,
  });
  assert.doesNotMatch(JSON.stringify([page, last]), /SECRET_GOAL|payload|excerpt|counter\.mjs/);
});

test('tool boundaries reject unbounded pagination, extra root/SQL arguments and unknown sessions', async (t) => {
  const projectRoot = project(t);
  const runtime = new Runtime(projectRoot);
  t.after(() => runtime.close());
  const session = runtime.start({ request: '- R1: counter works\nAcceptance R1: counter works', checks: [] });
  const client = await connect(t, projectRoot);
  for (const arguments_ of [
    { sessionId: session.id, limit: 0 },
    { sessionId: session.id, limit: 101 },
    { sessionId: session.id, afterSequence: -1 },
    { sessionId: session.id, afterSequence: 0.5 },
    { sessionId: session.id, projectRoot: '/' },
    { sessionId: session.id, sql: 'DELETE FROM events' },
  ]) {
    const response = await client.callTool({ name: 'optimizer_session_events', arguments: arguments_ });
    assert.equal(response.isError, true);
  }
  const unknown = await client.callTool({ name: 'optimizer_session_status', arguments: { sessionId: 'missing-session' } });
  assert.equal(unknown.isError, true);
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(projectRoot));
  const missing = await client.callTool({ name: 'optimizer_session_events', arguments: { sessionId: 'missing-session' } });
  assert.equal(missing.isError, true);
});

test('uninitialized project fails startup without creating optimizer state', async (t) => {
  const projectRoot = project(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--conditions=development', serverPath, '--project', projectRoot], stderr: 'pipe' });
  t.after(async () => transport.close());
  const client = new Client({ name: 'optimizer-integration-test', version: '1.0.0' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  await assert.rejects(client.connect(transport));
  assert.match(diagnostics, /explicitly configured, initialized project/);
  assert.equal(existsSync(join(projectRoot, '.optimizer')), false);
});

test('command output and foreign-project sessions remain private', async (t) => {
  const projectRoot = project(t);
  const runtime = new Runtime(projectRoot);
  t.after(() => runtime.close());
  const session = runtime.start({
    request: '- R1: counter works\nAcceptance R1: counter works',
    checks: [{ id: 'secret-check', requirementIds: ['R1'], argv: [process.execPath, '-e', 'console.log("SECRET_COMMAND_OUTPUT")'], timeoutMs: 2000 }],
  });
  const context = runtime.retrieve(session.id);
  runtime.assess(session.id, { kind: 'sufficient', itemIds: context.items.map(item => item.id), rationale: 'Counter source covers this requirement.' });
  runtime.review(session.id, { kind: 'accept', goalVersion: runtime.get(session.id).goal.version, itemIds: context.items.map(item => item.id), rationale: 'The requirements and acceptance preserve the request and match the cited source.' });
  const observation = runtime.runCheck(session.id, 'secret-check');
  assert.match(observation.result.output, /SECRET_COMMAND_OUTPUT/);
  const foreignRoot = project(t);
  const foreignRuntime = new Runtime(foreignRoot);
  t.after(() => foreignRuntime.close());
  const foreign = foreignRuntime.start({ request: '- R1: foreign secret\nAcceptance R1: foreign secret', checks: [] });
  const client = await connect(t, projectRoot);
  for (const name of ['optimizer_session_status', 'optimizer_session_events']) {
    const response = await client.callTool({ name, arguments: { sessionId: session.id } });
    assert.equal(response.isError, undefined);
    assert.doesNotMatch(JSON.stringify(response), /SECRET_COMMAND_OUTPUT|secret-check|argv|output|rationale/);
    const other = await client.callTool({ name, arguments: { sessionId: foreign.id } });
    assert.equal(other.isError, true);
    assert.doesNotMatch(JSON.stringify(other), /foreign secret/);
  }
});
