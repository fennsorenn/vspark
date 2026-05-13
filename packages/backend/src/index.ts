import express from 'express';
import { createServer } from 'http';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { runMigrations, getDb } from './db/index.js';
import { apiRoutes, setVmcManager, setWsSync } from './routes/api.js';
import { WSSync } from './ws/index.js';
import { VmcManager } from './vmc/manager.js';

const wsSync = new WSSync();
const app = express();
const server = createServer(app);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const UPLOADS_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '150mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/api', apiRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, connected: wsSync.connectedCount });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    wsSync.upgrade(req, socket, head);
  }
});

async function start() {
  await runMigrations();

  setWsSync(wsSync);
  const vmcManager = new VmcManager(wsSync);
  setVmcManager(vmcManager);

  // Start receivers for any VMC components that were persisted
  const rows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'vmc_receiver'").all() as Record<string, unknown>[];
  vmcManager.syncComponents(rows.map((r) => ({
    id:      r.id as string,
    nodeId:  r.node_id as string,
    kind:    r.kind as string,
    enabled: (r.enabled as number) === 1,
    config:  JSON.parse((r.config as string) || '{}'),
  })));

  const port = 3001;
  server.listen(port, () => {
    console.log('backend listening on :3001');
  });
}

start();
