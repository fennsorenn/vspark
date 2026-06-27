/**
 * Builds an MCP server exposing the vspark tool catalog. Used by all three
 * transports: the Streamable-HTTP mount (http.ts), the stdio bin (stdio.ts),
 * and the in-memory pair the assistant agent connects to (assistant/agent.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VsparkClient } from './client.js';
import { buildToolSpecs, isToolMediaResult } from './tools.js';

export const MCP_SERVER_INFO = {
  name: 'vspark',
  version: '0.1.0',
} as const;

export function createMcpServer(client: VsparkClient): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'Tools to drive a vspark 3D avatar/scene project: create and configure scene objects and ' +
      '2D compose layers, author feed templates, and build/wire logic (signal) graphs. Prefer the ' +
      'list_*/lookup_* tools to discover ids and signal-node ports before mutating.',
  });

  for (const spec of buildToolSpecs()) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.inputShape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await spec.handler(client, args ?? {});
          // Image-bearing results (view_asset, render_feed_template) forward as
          // MCP image content alongside any text; everything else is JSON text.
          if (isToolMediaResult(result)) {
            return {
              content: [
                ...(result.text
                  ? [{ type: 'text' as const, text: result.text }]
                  : []),
                ...result.images.map((im) => ({
                  type: 'image' as const,
                  data: im.base64,
                  mimeType: im.mimeType,
                })),
              ],
            };
          }
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
          };
        }
      }
    );
  }

  return server;
}
