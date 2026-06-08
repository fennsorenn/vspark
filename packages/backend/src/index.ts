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
import { VmcManager } from './behaviors/vmc_receiver/manager.js';
import { BreathingManager } from './behaviors/breathing/manager.js';
import { LipsyncManager } from './behaviors/lipsync/manager.js';
import { TrackingManager } from './behaviors/mediapipe_tracker/manager.js';
import { ApiControllerManager } from './behaviors/api_controller/manager.js';
import { TrackClipPlaybackManager } from './track_clips/playback.js';
import { initPoseBroadcast } from './signal/nodes/pose_broadcast.js';
import { broadcastBus } from './broadcast/bus.js';
import { initBlendshapesBroadcast } from './signal/nodes/blendshapes_broadcast.js';
import { initIkBroadcast, setIkStreamForwarder } from './signal/nodes/ik_broadcast.js';
import { initTrackClipTrigger } from './signal/nodes/track_clip_trigger.js';
import { initStartClip } from './signal/nodes/start_clip.js';
import { runtimeOverrideManager } from './runtime_overrides/manager.js';
import { dataChannelManager } from './data_channels/manager.js';
import { mediaControlManager } from './media_control/manager.js';
import { spawnManager } from './spawn/manager.js';
import { sync } from './sync/index.js';
import { SYNC_MESSAGE_KIND } from '@vspark/shared/sync';
import './sync/resources.js';
import { initIdentity } from './multiplayer/identity.js';
import { pruneExpiredGrants } from './multiplayer/peers.js';
import { multiplayerManager } from './multiplayer/manager.js';
import { clientMeshRelay } from './multiplayer/clientMeshRelay.js';
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
  // Multiplayer identity (Phase 5): load/generate this server's Ed25519 peer id
  // and clear any expired auto-accept grants.
  initIdentity();
  pruneExpiredGrants();
  // Connect to the rendezvous if configured (else multiplayer stays disabled).
  multiplayerManager.init(
    process.env.MULTIPLAYER_RENDEZVOUS_URL,
    process.env.MULTIPLAYER_DISPLAY_NAME,
    (kind, payload) => wsSync.broadcast(kind, payload)
  );
  // Unified sync layer: producer hub over the shared WS transport.
  // Inert until resources register + routes emit (phased migration).
  sync.init(wsSync);
  initPoseBroadcast(wsSync);
  initBlendshapesBroadcast(wsSync);
  initIkBroadcast(wsSync);
  // Forward shared avatars' live pose/blendshapes/IK to subscriber peers.
  broadcastBus.setStreamForwarder((kind, nodeId, payload) =>
    multiplayerManager.forwardStream(kind, nodeId, payload)
  );
  setIkStreamForwarder((kind, nodeId, payload) =>
    multiplayerManager.forwardStream(kind, nodeId, payload)
  );
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

  // Data-channel bus — generic graph→frontend publish surface (set_data node →
  // feed/template compose layer). Sibling of the override bus.
  // See dev-notes/modules/data-channels.md.
  dataChannelManager.init(wsSync);

  // Media-control bus — fire-and-forget play/pause/stop/seek commands for
  // video/audio entities (media_control node → frontend media registry).
  // See dev-notes/modules/media.md.
  mediaControlManager.init(wsSync);

  // Spawn manager — ephemeral clip-clone spawning. Subscribes to playback
  // completion events so it can tear down tmp entities on clip end.
  // See dev-notes/modules/spawn.md.
  spawnManager.init(wsSync, trackClipPlayback);

  // Standalone project graphs — start every persisted-enabled graph on boot.
  // See dev-notes/modules/project-graphs.md.
  const { logicManager } = await import('./logic/manager.js');
  logicManager.startAllEnabled();

  // Overlive integration — one shared kit per project with configured accounts.
  // See dev-notes/modules/overlive.md.
  const { initOverliveManager } = await import('./overlive/manager.js');
  const overliveManager = initOverliveManager(wsSync);
  await overliveManager.startAll();

  // Client-mesh signaling relay: track each client's participant id + tear it
  // down on disconnect so the roster stays accurate.
  clientMeshRelay.initWs(wsSync);
  wsSync.onClientConnected((ws) => {
    ws.on('close', () => clientMeshRelay.onWsClose(ws));
  });

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
    dataChannelManager.sendSnapshotTo((kind, payload) =>
      wsSync.sendTo(ws, kind, payload)
    );
    // Unified sync layer snapshot (no-op until field/stream resources land).
    sync.sendSnapshotTo((env) =>
      wsSync.sendTo(
        ws,
        SYNC_MESSAGE_KIND,
        env as unknown as Record<string, unknown>
      )
    );
    // Replay share offers so a tab that opens after a grant still sees them.
    multiplayerManager.sendSharingSnapshotTo((kind, payload) =>
      wsSync.sendTo(ws, kind, payload)
    );
  });

  // Handle browser → server media messages
  wsSync.onMessage((kind, payload, sourceWs) => {
    if (kind === 'lipsync_input') {
      const msg = payload as LipsyncInputMessage;
      lipsyncManager.fireVisemes(msg.behaviorId, msg.visemes ?? {});
    } else if (kind === 'tracking_input') {
      const msg = payload as TrackingInputMessage;
      trackingManager.fireLandmarks(msg.behaviorId, {
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
        // Forward to share subscribers so dragging a shared object is smooth on
        // the receiver (the committed PUT already forwards via sync.document).
        multiplayerManager.forwardStream('node_transform_preview', p.nodeId, {
          nodeId: p.nodeId,
          transform: p.transform,
        });
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
    } else if (kind === 'mesh_hello') {
      // A browser client registers its participant id for the client mesh.
      const p = payload as { participantId?: string };
      if (typeof p.participantId === 'string')
        clientMeshRelay.onHello(sourceWs, p.participantId);
    } else if (kind === 'mesh_signal') {
      // SDP/ICE from a client toward another mesh participant.
      const p = payload as { to?: string; data?: unknown };
      if (typeof p.to === 'string')
        clientMeshRelay.onSignal(sourceWs, p.to, p.data);
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
    .prepare("SELECT * FROM behaviors WHERE kind = 'vmc_receiver'")
    .all() as Record<string, unknown>[];
  vmcManager.syncBehaviors(vmcRows.map(mapRow));

  const breathingRows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'breathing'")
    .all() as Record<string, unknown>[];
  breathingManager.syncBehaviors(breathingRows.map(mapRow));

  const lipsyncRows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'lipsync_processor'")
    .all() as Record<string, unknown>[];
  lipsyncManager.syncBehaviors(lipsyncRows.map(mapRow));

  const trackingRows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'mediapipe_tracker'")
    .all() as Record<string, unknown>[];
  trackingManager.syncBehaviors(trackingRows.map(mapRow));

  const apiControllerRows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'api_controller'")
    .all() as Record<string, unknown>[];
  apiControllerManager.syncBehaviors(apiControllerRows.map(mapRow));

  // PORT override lets two instances run on one box (multiplayer testing).
  const port = Number(process.env.PORT) || 3001;
  server.listen(port, async () => {
    console.log(`vspark listening on http://localhost:${port}`);
    if (existsSync(PUBLIC_DIR)) {
      const { default: open } = await import('open');
      open(`http://localhost:${port}`);
    }
  });
}

start();
