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
import { collabSceneForNode } from '../multiplayer/collabScene.js';

export const NODE_STREAM_RTYPE = 'node_stream';

interface StreamFrame {
  id: string; // subject scene-node id (replica key + containment hook)
  kind: string;
  payload: Record<string, unknown>;
  [k: string]: unknown;
}

let _col: Collection<StreamFrame> | null = null;

/** Register the stream collection + the receiver→/ws bridge. */
export function initMeshStreams(
  peer: MeshPeer,
  broadcast: (kind: string, payload: Record<string, unknown>) => void
): void {
  if (_col) return;
  _col = peer.collection<StreamFrame>(NODE_STREAM_RTYPE, {
    channels: ['preview'],
  });
  _col.observe('**', (c) => {
    if (c.origin === peer.id || !c.doc) return; // our own publish — tabs got /ws
    if (!collabSceneForNode(c.id)) return; // not a collab node here — drop
    broadcast(c.doc.kind, c.doc.payload);
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
