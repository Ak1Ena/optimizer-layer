#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Runtime } from '@optimizer-layer/runtime';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { project: { type: 'string' } }, allowPositionals: false, strict: true });
  if (!values.project?.trim()) throw new Error('Explicit project required');
  const runtime = new Runtime(values.project, { readOnly: true });
  const server = createServer(runtime);
  server.server.onclose = () => runtime.close();
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    runtime.close();
    throw error;
  }
}

main().catch(() => {
  process.stderr.write('Optimizer MCP could not open the explicitly configured, initialized project. Usage: optimizer-mcp --project <project-directory>\n');
  process.exitCode = 1;
});
