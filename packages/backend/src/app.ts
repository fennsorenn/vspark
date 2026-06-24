import express from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes/index.js';
import { updateRoutes } from './routes/update.js';
import { configRoutes } from './routes/config.js';
import { openApiDoc } from './routes/openapi.js';
import swaggerUi from 'swagger-ui-express';
import { getIdentity } from './multiplayer/identity.js';
import type { WSSync } from './ws/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CreateAppOptions {
  /** WebSocket sync, used only by /health to report connected client count. */
  wsSync?: WSSync;
}

/**
 * Build the Express app with all HTTP routes mounted, WITHOUT binding any
 * sockets (HTTP listen, UDP, WebSocket upgrade) or starting managers. The
 * production entry (`index.ts`) wraps this with an http server + WS upgrade
 * handler in `start()`; integration tests construct it directly against an
 * in-memory DB. Migrations and manager wiring are the caller's responsibility.
 */
export function createApp(opts: CreateAppOptions = {}): express.Express {
  const app = express();

  const UPLOADS_DIR = join(process.cwd(), 'uploads');
  mkdirSync(UPLOADS_DIR, { recursive: true });

  app.use(express.json({ limit: '150mb' }));
  // `fallthrough: false` so a missing upload returns a real 404 instead of
  // dropping through to the SPA catch-all below (which would answer with
  // index.html + 200). The thumbnail cache HEAD-checks these URLs to decide
  // whether to (re)generate; a 200-with-HTML miss made it treat every absent
  // thumbnail as present, so thumbnails never rendered in the bundled build.
  app.use('/uploads', express.static(UPLOADS_DIR, { fallthrough: false }));
  app.use('/api', apiRoutes);
  app.use('/api', updateRoutes);
  app.use('/api', configRoutes);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));
  app.get('/api-docs.json', (_req, res) => res.json(openApiDoc));
  app.get('/health', (_req, res) => {
    res.json({ ok: true, connected: opts.wsSync?.connectedCount ?? 0 });
  });
  // Mesh handshake bootstrap: a tab mints its participant id under this peer id
  // (`${serverPeerId}#${tabUuid}`) before opening the /mesh socket.
  app.get('/api/mesh/identity', (_req, res) => {
    res.json({ serverPeerId: getIdentity().peerId });
  });

  // Serve built frontend — only present in production bundle
  const PUBLIC_DIR = join(__dirname, 'public');
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get('*', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
  }

  return app;
}
