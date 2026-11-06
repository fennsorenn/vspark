#!/usr/bin/env node
/**
 * Standalone stdio MCP server. External AI clients (Claude Desktop, Claude
 * Code, Cursor, …) spawn this process; it forwards tool calls to a RUNNING
 * vspark backend over HTTP. Point it at the backend with VSPARK_BASE_URL
 * (default http://localhost:3001).
 *
 *   Dev:   tsx packages/backend/src/mcp/stdio.ts
 *   Built: node dist/mcp/stdio.js   (or the `vspark-mcp` bin)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VsparkClient } from './client.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const baseUrl = process.env.VSPARK_BASE_URL ?? 'http://localhost:3001';
  const client = new VsparkClient({ baseUrl });
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the JSON-RPC channel.
  console.error(`[vspark-mcp] stdio server ready (backend: ${baseUrl})`);
}

main().catch((e) => {
  console.error('[vspark-mcp] fatal:', e);
  process.exit(1);
});
