import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Runtime } from '@optimizer-layer/runtime';

const sessionId = z.string().trim().min(1).max(256);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function reply(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function unavailable(): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: 'Session unavailable in the configured project.' }] };
}

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'optimizer-layer', version: '0.4.0' }, { maxToolInputElements: 10 });
  server.registerTool('optimizer_session_status', {
    description: 'Read sanitized current session status in the configured project. Returns counts and action/control kinds; excludes goal text, paths, commands, output, rationale, and other free text.',
    inputSchema: z.object({ sessionId }).strict(),
    annotations,
  }, ({ sessionId }) => {
    try {
      const state = runtime.get(sessionId);
      const action = runtime.next(sessionId);
      return reply({
        sessionId,
        control: { kind: state.control.kind, rounds: state.control.rounds },
        next: { kind: action.kind, route: action.route },
        completionClaimed: state.completionClaimed,
        requirementCount: state.goal.requirements.length,
        unresolvedUncertaintyCount: state.goal.uncertainties.filter(item => item.resolution.kind === 'open').length,
        context: {
          current: state.context !== null,
          itemCount: state.context?.items.length ?? 0,
          complete: state.context?.complete ?? false,
          assessment: state.assessment?.kind ?? null,
        },
        checkCount: state.checks.length,
        observationCount: state.evidence.length,
      });
    } catch {
      return unavailable();
    }
  });
  server.registerTool('optimizer_session_events', {
    description: 'Read paginated session event metadata in the configured project. Returns sequence, timestamp, and event kind only. afterSequence is exclusive; limit defaults to 25 and cannot exceed 100. A non-null nextAfterSequence continues the page.',
    inputSchema: z.object({
      sessionId,
      afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      limit: z.number().int().min(1).max(100).default(25),
    }).strict(),
    annotations,
  }, ({ sessionId, afterSequence, limit }) => {
    try {
      runtime.get(sessionId);
      const remaining = runtime.events(sessionId).filter(item => item.sequence > afterSequence);
      const page = remaining.slice(0, limit);
      const lastSequence = page.at(-1)?.sequence ?? null;
      return reply({
        sessionId,
        events: page.map(({ sequence, event }) => ({ sequence, at: event.at, kind: event.payload.kind })),
        nextAfterSequence: remaining.length > page.length ? lastSequence : null,
      });
    } catch {
      return unavailable();
    }
  });
  return server;
}
