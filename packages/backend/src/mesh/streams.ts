/**
 * Live node streams over the mesh (§9 streams step).
 *
 * Collab-scene pose/blendshape/IK/drag-preview frames ride a pure-stream
 * mesh collection (`node_stream`, preview channel only: lossy, unstamped,
 * unretained — never snapshotted or persisted). Frames are keyed by the
 * subject scene-node id, so the existing collab '*'-subtree subscriptions
 * route them through cross-type containment with zero extra wiring — and
 * multi-hop topologies relay them exactly like document ops.
 *
 * Receiver side: remote frames for nodes of OUR collab scenes re-broadcast
 * to this server's tabs over /ws under their original kind (vmc_pose,
 * node_transform_preview, …) — same surface the legacy COLLAB_STREAM_RTYPE
 * relay fed. Frames matching only a placed-object subscription are dropped
 * here: object-share streams still ride the legacy `_share_stream` path
 * (relay + direct browser edges), so bridging them too would double-apply.
 *
 * The frontend tab subscriptions don't cover this rtype, so tabs never
 * receive these frames over /mesh (no double with the /ws broadcast).
 */
import type { Collection, MeshPeer } from '@vspark/mesh';
import {
  collabSceneForNode,
  clipCollabScene,
  isCollabScene,
  allCollabSceneIds,
  type ClipPlaybackAction,
} from '../multiplayer/collabScene.js';

export const NODE_STREAM_RTYPE = 'node_stream';
/** Reliable unstamped event channel: control messages that must not drop but
 *  are events, not state (never retained, snapshotted, or persisted). */
export const CONTROL_CHANNEL = 'control';
export const CLIP_CONTROL_RTYPE = 'clip_control';
export const RUNTIME_CONTROL_RTYPE = 'runtime_control';

interface StreamFrame {
  id: string; // subject scene-node id (replica key + containment hook)
  kind: string;
  payload: Record<string, unknown>;
  [k: string]: unknown;
}

interface ClipControlEvent {
  id: string; // clip id (containment: clip → owner node → scene)
  action: ClipPlaybackAction;
  t?: number;
  [k: string]: unknown;
}

/** Runtime event (Set Data / overrides / media / spawn) keyed by the collab
 *  scene id — the legacy relay was peer-scoped, so events without a
 *  containment anchor (global data channels, spawned tmp ids) are published
 *  once per shared scene; `eventId` dedupes for peers sharing several. */
interface RuntimeEvent {
  id: string; // collab scene id (exact-entity subscription match)
  eventId: string;
  kind: string;
  payload: Record<string, unknown>;
  [k: string]: unknown;
}

let _col: Collection<StreamFrame> | null = null;
let _clipCol: Collection<ClipControlEvent> | null = null;
let _runtimeCol: Collection<RuntimeEvent> | null = null;
let _applyClipPlayback:
  | ((clipId: string, action: ClipPlaybackAction, t?: number) => void)
  | null = null;
let _applyRuntime:
  | ((kind: string, payload: Record<string, unknown>) => void)
  | null = null;
/** FIFO dedupe of applied runtime eventIds (multi-scene + multi-hop echoes). */
const seenRuntimeEvents = new Set<string>();
const SEEN_CAP = 1024;

/** The manager injects its local appliers (avoids an import cycle). */
export function setClipPlaybackApplier(
  fn: (clipId: string, action: ClipPlaybackAction, t?: number) => void
): void {
  _applyClipPlayback = fn;
}

export function setCollabRuntimeApplier(
  fn: (kind: string, payload: Record<string, unknown>) => void
): void {
  _applyRuntime = fn;
}

/** Register the stream collections + the receiver bridges. */
export function initMeshStreams(
  peer: MeshPeer,
  broadcast: (kind: string, payload: Record<string, unknown>) => void
): void {
  if (_col) return;
  peer.channel(CONTROL_CHANNEL, {
    transport: 'reliable',
    stamped: false,
    retained: false,
  });
  _col = peer.collection<StreamFrame>(NODE_STREAM_RTYPE, {
    channels: ['preview'],
  });
  _col.observe('**', (c) => {
    if (c.origin === peer.id || !c.doc) return; // our own publish — tabs got /ws
    if (!collabSceneForNode(c.id)) return; // not a collab node here — drop
    broadcast(c.doc.kind, c.doc.payload);
  });
  // Clip playback control: each peer re-anchors locally on receipt (no clock
  // sync — seek carries the playhead), replacing the legacy _collab_playback.
  _clipCol = peer.collection<ClipControlEvent>(CLIP_CONTROL_RTYPE, {
    channels: [CONTROL_CHANNEL],
  });
  _clipCol.observe('**', (c) => {
    if (c.origin === peer.id || !c.doc) return;
    if (!clipCollabScene(c.id)) return; // clip's scene isn't collab here — drop
    _applyClipPlayback?.(c.id, c.doc.action, c.doc.t);
  });
  // Runtime events (Set Data / overrides / media / spawn), replacing the
  // legacy _collab_runtime broadcast. Keyed by scene id, deduped by eventId.
  _runtimeCol = peer.collection<RuntimeEvent>(RUNTIME_CONTROL_RTYPE, {
    channels: [CONTROL_CHANNEL],
  });
  _runtimeCol.observe('**', (c) => {
    if (c.origin === peer.id || !c.doc) return;
    if (!isCollabScene(c.id)) return; // not one of our shared scenes — drop
    if (seenRuntimeEvents.has(c.doc.eventId)) return;
    seenRuntimeEvents.add(c.doc.eventId);
    if (seenRuntimeEvents.size > SEEN_CAP) {
      const first = seenRuntimeEvents.values().next().value;
      if (first) seenRuntimeEvents.delete(first);
    }
    _applyRuntime?.(c.doc.kind, c.doc.payload);
  });
}

/** Publish one live frame for a collab-scene node (lossy, best-effort). */
export function publishNodeStream(
  nodeId: string,
  kind: string,
  payload: Record<string, unknown>
): void {
  _col?.set(nodeId, '', { id: nodeId, kind, payload }, { channel: 'preview' });
}

/** Publish a runtime event to every collab peer: one publish per shared
 *  scene (the subscription key), one application per receiver (eventId). */
export function publishCollabRuntime(
  kind: string,
  payload: Record<string, unknown>
): void {
  if (!_runtimeCol) return;
  const sceneIds = allCollabSceneIds();
  if (sceneIds.length === 0) return;
  const eventId = globalThis.crypto.randomUUID();
  for (const sceneId of sceneIds)
    _runtimeCol.set(
      sceneId,
      '',
      { id: sceneId, eventId, kind, payload },
      { channel: CONTROL_CHANNEL }
    );
}

/** Publish a clip playback control to the clip's collab peers (reliable). */
export function publishClipPlayback(
  clipId: string,
  action: ClipPlaybackAction,
  t?: number
): void {
  _clipCol?.set(
    clipId,
    '',
    { id: clipId, action, t },
    { channel: CONTROL_CHANNEL }
  );
}
