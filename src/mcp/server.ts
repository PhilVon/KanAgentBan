#!/usr/bin/env node
// KanAgentBan MCP server (stdio).
//
// A thin Model Context Protocol front-end so non-Claude-Code agents can drive the
// board. It is a *client* of the existing sole-writer HTTP server: `connect()`
// discovers the nearest .kanban/ board and auto-starts that server if needed, and
// every tool forwards to it via `api()`. The MCP process never opens its own
// Repo/DB, so the single-writer invariant and realtime/HITL coherence are
// preserved (docs/12-mcp.md, ADR 0003).
//
// stdout is the JSON-RPC protocol channel — all diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect } from '../cli/board';
import { registerTools } from './tools';

/** Read a `--flag value` pair from argv (the MCP client launches us with these). */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // Agent identity also honours KANBAN_AGENT (read inside connect()).
  const conn = await connect({ board: arg('--board'), agent: arg('--as') });

  const server = new McpServer({ name: 'kanagentban', version: '0.1.0' });
  registerTools(server, conn);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`kanban-mcp: connected to ${conn.base} (board ${conn.paths.root}, agent ${conn.agent})\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`kanban-mcp fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
