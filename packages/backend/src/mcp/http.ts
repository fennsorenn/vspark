/**
 * Mounts the vspark MCP server over the Streamable-HTTP transport. Stateless:
 * each POST spins up a fresh server+transport pair (no session affinity needed
 * for a local single-user tool surface), so external MCP clients and the
 * in-app assistant can both reach it at /mcp. The tools call back into this
 * same backend over loopback HTTP, exercising the real REST validation path.
 */
import { Router, json, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { VsparkClient } from './client.js';
import { createMcpServer } from './server.js';

const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0' as const,
  error: { code: -32000, message: 'Method not allowed (stateless MCP server).' },
  id: null,
};

export function createMcpHttpRouter(loopbackBaseUrl: string): Router {
  const router: Router = Router();
  router.use(json({ limit: '4mb' }));

  const client = new VsparkClient({ baseUrl: loopbackBaseUrl });

  router.post('/', async (req: Request, res: Response) => {
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request error:', e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless server: no standalone SSE stream / session teardown.
  router.get('/', (_req, res) => res.status(405).json(METHOD_NOT_ALLOWED));
  router.delete('/', (_req, res) => res.status(405).json(METHOD_NOT_ALLOWED));

  return router;
}
