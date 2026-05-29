import express from 'express';
import { createServer } from 'http';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations, getDb } from './db/index.js';
import {
  apiRoutes,
  setVmcManager,
  setBreathingManager,
  setLipsyncManager,
  setTrackingManager,
  setApiControllerManager,
  setWsSync,
  setTrackClipPlaybackManager,
} from './routes/index.js';
import {
  updateRoutes,
  initUpdateChecker,
  getInstallDir,
} from './routes/update.js';
import { configRoutes } from './routes/config.js';
import { openApiDoc } from './routes/openapi.js';
import swaggerUi from 'swagger-ui-express';
import { WSSync } from './ws/index.js';
import { VmcManager } from './node_components/vmc_receiver/manager.js';
import { BreathingManager } from './node_components/breathing/manager.js';
import { LipsyncManager } from './node_components/lipsync/manager.js';
import { TrackingManager } from './node_components/mediapipe_tracker/manager.js';
import { ApiControllerManager } from './node_components/api_controller/manager.js';
import { TrackClipPlaybackManager } from './track_clips/playback.js';
import { initPoseBroadcast } from './signal/nodes/pose_broadcast.js';
import { initBlendshapesBroadcast } from './signal/nodes/blendshapes_broadcast.js';
import { initIkBroadcast } from './signal/nodes/ik_broadcast.js';
import { initTrackClipTrigger } from './signal/nodes/track_clip_trigger.js';
import { initStartClip } from './signal/nodes/start_clip.js';
import { runtimeOverrideManager } from './runtime_overrides/manager.js';
import type {
  LipsyncInputMessage,
  TrackingInputMessage,
  AvatarExpressionsReportMessage,
} from '@vspark/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const wsSync = new WSSync();
const app = express();
const server = createServer(app);

const UPLOADS_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '150mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/api', apiRoutes);
app.use('/api', updateRoutes);
app.use('/api', configRoutes);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));
app.get('/api-docs.json', (_req, res) => res.json(openApiDoc));
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
  initPoseBroadcast(wsSync);
  initBlendshapesBroadcast(wsSync);
  initIkBroadcast(wsSync);
  initUpdateChecker(getInstallDir(), wsSync);

  const vmcManager = new VmcManager(wsSync);
  setVmcManager(vmcManager);

  const breathingManager = new BreathingManager();
  setBreathingManager(breathingManager);

  const lipsyncManager = new LipsyncManager();
  setLipsyncManager(lipsyncManager);

  const trackingManager = new TrackingManager();
  setTrackingManager(trackingManager);

  const apiControllerManager = new ApiControllerManager(wsSync);
  setApiControllerManager(apiControllerManager);

  const trackClipPlayback = new TrackClipPlaybackManager(wsSync);
  trackClipPlayback.hydrateAutoplay();
  setTrackClipPlaybackManager(trackClipPlayback);
  initTrackClipTrigger(trackClipPlayback);
  initStartClip(trackClipPlayback);

  // Runtime override bus — graph-driven, parallel to track-clip overrides.
  // The persist hook is left unset until set_*_param nodes land in Phase 1.5;
  // until then, `persist: true` falls through to a log + no-op.
  // See dev-notes/modules/runtime-overrides.md.
  runtimeOverrideManager.init(wsSync, null);

  // Standalone project graphs — start every persisted-enabled graph on boot.
  // See dev-notes/modules/project-graphs.md.
  const { projectGraphManager } = await import('./project_graphs/manager.js');
  projectGraphManager.startAllEnabled();

  // Overlive integration — one shared kit per project with configured accounts.
  // See dev-notes/modules/overlive.md.
  const { initOverliveManager } = await import('./overlive/manager.js');
  const overliveManager = initOverliveManager(wsSync);
  await overliveManager.startAll();

  // Rebroadcast current state to any newly-connecting client.
  wsSync.onClientConnected((ws) => {
    apiControllerManager.rebroadcastTo((kind, payload) =>
      wsSync.sendTo(ws, kind, payload)
    );
    trackClipPlayback.sendSnapshotTo((kind, payload) =>
      wsSync.sendTo(ws, kind, payload)
    );
    runtimeOverrideManager.sendSnapshotTo((kind, payload) =>
      wsSync.sendTo(ws, kind, payload)
    );
  });

  // Handle browser → server media messages
  wsSync.onMessage((kind, payload, sourceWs) => {
    if (kind === 'lipsync_input') {
      const msg = payload as LipsyncInputMessage;
      lipsyncManager.fireVisemes(msg.componentId, msg.visemes ?? {});
    } else if (kind === 'tracking_input') {
      const msg = payload as TrackingInputMessage;
      trackingManager.fireLandmarks(msg.componentId, {
        face: msg.face,
        leftHand: msg.leftHand,
        rightHand: msg.rightHand,
        pose: msg.pose,
      });
    } else if (kind === 'avatar_expressions_report') {
      const msg = payload as AvatarExpressionsReportMessage;
      apiControllerManager.setExpressionsForNode(
        msg.nodeId,
        msg.expressions ?? []
      );
    } else if (kind === 'node_transform_preview') {
      // Live in-flight transform from a drag/wheel gesture in one client; relay
      // to every other client without persisting. The eventual mouseup/settle
      // commits via the REST PUT, which re-broadcasts the canonical state.
      const p = payload as {
        nodeId?: string;
        transform?: Record<string, number>;
      };
      if (typeof p.nodeId === 'string' && p.transform) {
        wsSync.broadcast(
          'node_transform_preview',
          { nodeId: p.nodeId, transform: p.transform },
          sourceWs
        );
      }
    } else if (kind === 'compose_layer_preview') {
      // Same idea for compose layer drag/resize/rotate: relay the patch without
      // touching the DB; the final REST PUT will write+broadcast the canonical row.
      const p = payload as { id?: string; patch?: Record<string, unknown> };
      if (typeof p.id === 'string' && p.patch) {
        wsSync.broadcast(
          'compose_layer_preview',
          { id: p.id, patch: p.patch },
          sourceWs
        );
      }
    }
  });

  function mapRow(r: Record<string, unknown>) {
    return {
      id: r.id as string,
      nodeId: r.node_id as string,
      kind: r.kind as string,
      enabled: (r.enabled as number) === 1,
      config: JSON.parse((r.config as string) || '{}'),
    };
  }

  // Start receivers for any components that were persisted
  const vmcRows = getDb()
    .prepare("SELECT * FROM node_components WHERE kind = 'vmc_receiver'")
    .all() as Record<string, unknown>[];
  vmcManager.syncComponents(vmcRows.map(mapRow));

  const breathingRows = getDb()
    .prepare("SELECT * FROM node_components WHERE kind = 'breathing'")
    .all() as Record<string, unknown>[];
  breathingManager.syncComponents(breathingRows.map(mapRow));

  const lipsyncRows = getDb()
    .prepare("SELECT * FROM node_components WHERE kind = 'lipsync_processor'")
    .all() as Record<string, unknown>[];
  lipsyncManager.syncComponents(lipsyncRows.map(mapRow));

  const trackingRows = getDb()
    .prepare("SELECT * FROM node_components WHERE kind = 'mediapipe_tracker'")
    .all() as Record<string, unknown>[];
  trackingManager.syncComponents(trackingRows.map(mapRow));

  const apiControllerRows = getDb()
    .prepare("SELECT * FROM node_components WHERE kind = 'api_controller'")
    .all() as Record<string, unknown>[];
  apiControllerManager.syncComponents(apiControllerRows.map(mapRow));

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
