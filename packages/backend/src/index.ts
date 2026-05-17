import express from 'express';
import { createServer } from 'http';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations, getDb } from './db/index.js';
import { apiRoutes, setVmcManager, setBreathingManager, setLipsyncManager, setTrackingManager, setWsSync } from './routes/api.js';
import { WSSync } from './ws/index.js';
import { VmcManager } from './node_components/vmc_receiver/manager.js';
import { BreathingManager } from './node_components/breathing/manager.js';
import { LipsyncManager } from './node_components/lipsync/manager.js';
import { TrackingManager } from './node_components/mediapipe_tracker/manager.js';
import type { LipsyncInputMessage, TrackingInputMessage } from '@vspark/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const wsSync = new WSSync();
const app = express();
const server = createServer(app);

const UPLOADS_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '150mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/api', apiRoutes);
app.get('/health', (_req, res) => {
  res.json({ ok: true, connected: wsSync.connectedCount });
});

// Serve built frontend — only present in production bundle
const PUBLIC_DIR = join(__dirname, 'public');
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
}

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

  const breathingManager = new BreathingManager();
  setBreathingManager(breathingManager);

  const lipsyncManager = new LipsyncManager();
  setLipsyncManager(lipsyncManager);

  const trackingManager = new TrackingManager();
  setTrackingManager(trackingManager);

  // Handle browser → server media messages
  wsSync.onMessage((kind, payload) => {
    if (kind === 'lipsync_input') {
      const msg = payload as LipsyncInputMessage
      lipsyncManager.fireVisemes(msg.componentId, msg.visemes ?? {})
    } else if (kind === 'tracking_input') {
      const msg = payload as TrackingInputMessage
      trackingManager.fireLandmarks(msg.componentId, {
        face:      msg.face,
        leftHand:  msg.leftHand,
        rightHand: msg.rightHand,
        pose:      msg.pose,
      })
    }
  });

  function mapRow(r: Record<string, unknown>) {
    return {
      id:      r.id as string,
      nodeId:  r.node_id as string,
      kind:    r.kind as string,
      enabled: (r.enabled as number) === 1,
      config:  JSON.parse((r.config as string) || '{}'),
    };
  }

  // Start receivers for any components that were persisted
  const vmcRows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'vmc_receiver'").all() as Record<string, unknown>[];
  vmcManager.syncComponents(vmcRows.map(mapRow));

  const breathingRows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'breathing'").all() as Record<string, unknown>[];
  breathingManager.syncComponents(breathingRows.map(mapRow));

  const lipsyncRows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'lipsync_processor'").all() as Record<string, unknown>[];
  lipsyncManager.syncComponents(lipsyncRows.map(mapRow));

  const trackingRows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'mediapipe_tracker'").all() as Record<string, unknown>[];
  trackingManager.syncComponents(trackingRows.map(mapRow));

  const port = 3001;
  server.listen(port, async () => {
    console.log('vspark listening on http://localhost:3001');
    if (existsSync(PUBLIC_DIR)) {
      const { default: open } = await import('open');
      open(`http://localhost:${port}`);
    }
  });
}

start();
