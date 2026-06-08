/**
 * Object-share protocol over the mesh (Phase 5, Strategy A). Owner side: track
 * subscribers, send the snapshot on subscribe, forward live document updates of
 * shared subtrees, advertise grants on connect/change. Receiver side: relay the
 * advertise / snapshot / update / unshared control messages to the frontend
 * (which materialises the projected nodes). Asset transfer and live pose
 * forwarding are follow-ups (assets resolve via a shared uploads dir on one box).
 *
 * Control messages ride the mesh `doc` channel as SyncEnvelopes with reserved
 * `_share_*` rtypes. See dev-notes/plans/multiplayer-phase5.md.
 */
import { getDb } from '../db/index.js';
import { ServerMesh } from './mesh.js';
import {
  listSharesForPeer,
  isSharedWith,
  gatherObjectSnapshot,
  findOwningRoot,
} from './shares.js';
import type { SyncEnvelope } from '@vspark/shared/sync';

const ADVERTISE = '_share_advertise';
const SUBSCRIBE = '_share_subscribe';
const UNSUBSCRIBE = '_share_unsubscribe';
const SNAPSHOT = '_share_snapshot';
const UPDATE = '_share_update';
const UNSHARED = '_share_unshared';

/** rtypes the sharing manager owns (so the mesh dispatcher routes them here). */
export const SHARE_RTYPES = new Set([
  ADVERTISE,
  SUBSCRIBE,
  UNSUBSCRIBE,
  SNAPSHOT,
  UPDATE,
  UNSHARED,
]);

type Broadcast = (kind: string, payload: Record<string, unknown>) => void;

function nameOf(objectId: string): string {
  const r = getDb()
    .prepare('SELECT name FROM scene_nodes WHERE id = ?')
    .get(objectId) as { name: string } | undefined;
  return r?.name ?? '';
}

export class SharingManager {
  /** peerId → object ids that peer subscribed to (I'm the owner). */
  private readonly subscribers = new Map<string, Set<string>>();

  constructor(
    private readonly mesh: ServerMesh,
    private readonly broadcast: Broadcast
  ) {}

  onPeerConnected(peerId: string): void {
    this.subscribers.set(peerId, new Set());
    this.advertise(peerId);
  }

  onPeerDisconnected(peerId: string): void {
    this.subscribers.delete(peerId);
    // Receiver side: drop every projection from this peer.
    this.broadcast('mp_shared_gone', { peerId });
  }

  /** Owner → peer: the objects currently granted to them. */
  advertise(peerId: string): void {
    const shares = listSharesForPeer(peerId).map((s) => ({
      objectId: s.objectId,
      shareKind: s.shareKind,
      name: nameOf(s.objectId),
    }));
    this.mesh.sendEnvelope(peerId, {
      rtype: ADVERTISE,
      op: 'event',
      key: '',
      data: { shares },
    });
  }

  /** Re-advertise to all connected peers (after a grant was added). */
  reAdvertiseAll(): void {
    for (const peerId of this.subscribers.keys()) this.advertise(peerId);
  }

  /** Owner: a grant was revoked → drop the subscription + tell the peer. */
  notifyUnshared(peerId: string, objectId: string): void {
    this.subscribers.get(peerId)?.delete(objectId);
    this.mesh.sendEnvelope(peerId, {
      rtype: UNSHARED,
      op: 'event',
      key: objectId,
      data: { objectId },
    });
    this.advertise(peerId);
  }

  /** Receiver: subscribe to a peer's object (the frontend placed a wrapper). */
  subscribe(peerId: string, objectId: string): void {
    this.mesh.sendEnvelope(peerId, {
      rtype: SUBSCRIBE,
      op: 'event',
      key: objectId,
      data: { objectId },
    });
  }

  unsubscribe(peerId: string, objectId: string): void {
    this.mesh.sendEnvelope(peerId, {
      rtype: UNSUBSCRIBE,
      op: 'event',
      key: objectId,
      data: { objectId },
    });
  }

  /** Dispatch a `_share_*` control envelope. */
  handleEnvelope(from: string, env: SyncEnvelope): void {
    const data = (env.data ?? {}) as Record<string, unknown>;
    switch (env.rtype) {
      case SUBSCRIBE: {
        const objectId = data.objectId as string;
        if (!isSharedWith(objectId, from)) return; // not granted — ignore
        this.subscribers.get(from)?.add(objectId);
        const snapshot = gatherObjectSnapshot(objectId);
        if (snapshot)
          this.mesh.sendEnvelope(from, {
            rtype: SNAPSHOT,
            op: 'event',
            key: objectId,
            data: { snapshot },
          });
        break;
      }
      case UNSUBSCRIBE:
        this.subscribers.get(from)?.delete(data.objectId as string);
        break;
      // --- receiver side: relay to the frontend ---
      case ADVERTISE:
        this.broadcast('mp_shares', {
          peerId: from,
          shares: data.shares ?? [],
        });
        break;
      case SNAPSHOT:
        this.broadcast('mp_shared_snapshot', {
          peerId: from,
          snapshot: data.snapshot,
        });
        break;
      case UPDATE:
        this.broadcast('mp_shared_update', {
          peerId: from,
          objectId: data.objectId,
          env: data.env,
        });
        break;
      case UNSHARED:
        this.broadcast('mp_shared_unshared', {
          peerId: from,
          objectId: data.objectId,
        });
        break;
    }
  }

  /** Owner: forward a document op to every subscriber whose subtree contains it.
   *  Forwards scene_node ops (the avatar tree): upserts (create + property /
   *  transform / model edits) resolve the owning root via parent_id; removes use
   *  the envelope's `route` ancestor hint, since the row is already gone.
   *  Behaviours/effects/clips ride the initial snapshot — live updates for those
   *  are a follow-up. */
  forwardDocOp(env: SyncEnvelope): void {
    if (env.rtype !== 'scene_node') return;
    for (const [peerId, roots] of this.subscribers) {
      if (roots.size === 0) continue;
      const root =
        env.op === 'remove'
          ? ((env.route ?? []).find((id) => roots.has(id)) ?? null)
          : findOwningRoot(env.key, roots);
      if (root)
        this.mesh.sendEnvelope(peerId, {
          rtype: UPDATE,
          op: 'event',
          key: root,
          data: { objectId: root, env },
        });
    }
  }
}
