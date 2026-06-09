/**
 * Object-share protocol over the mesh (Phase 5, Strategy A). Owner side: track
 * subscribers, send the snapshot on subscribe, forward live document updates of
 * shared subtrees, advertise grants on connect/change. Receiver side: relay the
 * advertise / snapshot / update / unshared control messages to the frontend
 * (which materialises the projected nodes). Live pose + asset transfer are wired
 * (pose/blendshape/IK over the stream forwarders; content-addressed blobs over
 * `_blob_*`).
 *
 * Behaviours/effects are *not* config-synced live, by design: a behaviour (signal
 * graph) runs only on the owner; whatever it produces that affects rendered state
 * exits through the pose / runtime-override / data-channel buses — all forwarded
 * here — so the receiver's inert, output-driven projection needs no behaviour
 * execution. Their config rides the initial snapshot for completeness only.
 * (Track-clip animation is the one frontend-evaluated case that *is* forwarded —
 * as a transform stream via `forwardNodeTransform`, not config.)
 *
 * Subscriptions are held in the live grant-gated {@link MeshRouter} (admit-on-
 * subscribe against the real grant store + containment index), not a bespoke map;
 * forwarding queries it for each subscriber's owned roots. Control messages ride
 * the mesh `doc` channel as SyncEnvelopes with reserved `_share_*` rtypes. See
 * dev-notes/plans/permissioned-sync-mesh.md.
 */
import { getDb } from '../db/index.js';
import {
  listSharesForPeer,
  gatherObjectSnapshot,
  findOwningRoot,
  type ObjectSnapshot,
} from './shares.js';
import { assetForPath, type AssetMeta } from './blobs.js';
import { BlobManager } from './blobTransfer.js';
import { type MeshTransport } from './transport.js';
import type { MeshRouter } from '../sync/meshRouter.js';
import type { Subscription, SyncEnvelope } from '@vspark/shared/sync';

const ADVERTISE = '_share_advertise';
const SUBSCRIBE = '_share_subscribe';
const UNSUBSCRIBE = '_share_unsubscribe';
const SNAPSHOT = '_share_snapshot';
const UPDATE = '_share_update';
const UNSHARED = '_share_unshared';
/** Live pose/blendshape frame for a shared avatar (rides the lossy stream channel). */
const STREAM = '_share_stream';
/** Runtime override set/clear on a shared subtree node (reliable doc channel). */
const OVERRIDE = '_share_override';
/** Data-channel set/clear scoped to a shared subtree node (reliable doc channel). */
const DATACHANNEL = '_share_datachannel';

/** rtypes the sharing manager owns (so the mesh dispatcher routes them here). */
export const SHARE_RTYPES = new Set([
  ADVERTISE,
  SUBSCRIBE,
  UNSUBSCRIBE,
  SNAPSHOT,
  UPDATE,
  UNSHARED,
  OVERRIDE,
  DATACHANNEL,
]);

type Broadcast = (kind: string, payload: Record<string, unknown>) => void;

/** Re-exported for call sites that build the facade (the manager). */
export type { MeshTransport };

function nameOf(objectId: string): string {
  const r = getDb()
    .prepare('SELECT name FROM scene_nodes WHERE id = ?')
    .get(objectId) as { name: string } | undefined;
  return r?.name ?? '';
}

export class SharingManager {
  /** Connected *server* peers (advertise targets). Subscriptions themselves live
   *  in the router; this is just "who do I push offers to" (browsers learn offers
   *  via their own server's relay, so they aren't tracked here). */
  private readonly connected = new Set<string>();
  /** Receiver side: latest share offers advertised by each connected owner, so
   *  a late-joining browser tab can be replayed the offers it missed. */
  private readonly advertised = new Map<string, unknown[]>();

  constructor(
    private readonly transport: MeshTransport,
    private readonly broadcast: Broadcast,
    private readonly blob: BlobManager,
    /** Live grant-gated subscription registry (admit-on-subscribe + the owned
     *  roots each subscriber pulls). */
    private readonly router: MeshRouter
  ) {}

  /** A subscription to an Object = its scene_node entity + subtree, all paths. */
  private subFor(objectId: string): Subscription {
    return {
      entityRtype: 'scene_node',
      entityId: objectId,
      includeDescendants: true,
      pathPrefix: '',
    };
  }

  /** The object roots a participant is subscribed to (the old `subscribers` set). */
  private rootsOf(participant: string): Set<string> {
    return new Set(
      this.router.subscriptionsOf(participant).map((s) => s.entityId)
    );
  }

  onPeerConnected(peerId: string): void {
    this.connected.add(peerId);
    this.advertise(peerId);
  }

  onPeerDisconnected(peerId: string): void {
    this.connected.delete(peerId);
    this.advertised.delete(peerId);
    // Subscriptions are dropped by the manager's router.detach(peerId). Receiver
    // side: drop every projection from this peer.
    this.broadcast('mp_shared_gone', { peerId });
  }

  /** Replay cached offers to a freshly-connected local client (the ADVERTISE
   *  broadcast fires once, so tabs that open later would otherwise miss it). */
  sendSnapshotTo(send: Broadcast): void {
    for (const [peerId, shares] of this.advertised)
      send('mp_shares', { peerId, shares });
  }

  /** Owner → peer: the objects currently granted to them. */
  advertise(peerId: string): void {
    const shares = listSharesForPeer(peerId).map((s) => ({
      objectId: s.objectId,
      shareKind: s.shareKind,
      name: nameOf(s.objectId),
    }));
    this.transport.sendEnvelope(peerId, {
      rtype: ADVERTISE,
      op: 'event',
      key: '',
      data: { shares },
    });
  }

  /** Re-advertise to all connected peers (after a grant was added). */
  reAdvertiseAll(): void {
    for (const peerId of this.connected) this.advertise(peerId);
  }

  /** Owner: a grant was revoked → drop the subscription + tell the peer. */
  notifyUnshared(peerId: string, objectId: string): void {
    this.router.unsubscribe(peerId, this.subFor(objectId));
    this.transport.sendEnvelope(peerId, {
      rtype: UNSHARED,
      op: 'event',
      key: objectId,
      data: { objectId },
    });
    this.advertise(peerId);
  }

  /** Owner: a grant changed — re-validate every subscriber against the current
   *  grants and notify those whose subscriptions were evicted. Covers remote
   *  *server* peers and *browser* participants alike (the router holds both), and
   *  only drops the now-uncovered ones (a surviving '*' grant keeps a peer). */
  revokeUnauthorized(_objectId: string): void {
    for (const participant of this.router.participants())
      for (const sub of this.router.revalidate(participant)) {
        this.transport.sendEnvelope(participant, {
          rtype: UNSHARED,
          op: 'event',
          key: sub.entityId,
          data: { objectId: sub.entityId },
        });
        this.advertise(participant);
      }
  }

  /** Receiver: subscribe to a peer's object (the frontend placed a wrapper). */
  subscribe(peerId: string, objectId: string): void {
    this.transport.sendEnvelope(peerId, {
      rtype: SUBSCRIBE,
      op: 'event',
      key: objectId,
      data: { objectId },
    });
  }

  unsubscribe(peerId: string, objectId: string): void {
    this.transport.sendEnvelope(peerId, {
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
        // Admit iff a read grant covers it (source-side admission). Returns false
        // when not granted — ignore.
        if (!this.router.subscribe(from, this.subFor(objectId))) return;
        const snapshot = gatherObjectSnapshot(objectId);
        if (snapshot)
          this.transport.sendEnvelope(from, {
            rtype: SNAPSHOT,
            op: 'event',
            key: objectId,
            data: { snapshot },
          });
        break;
      }
      case UNSUBSCRIBE:
        this.router.unsubscribe(from, this.subFor(data.objectId as string));
        break;
      // --- receiver side: relay to the frontend ---
      case ADVERTISE: {
        const shares = (data.shares ?? []) as unknown[];
        this.advertised.set(from, shares);
        this.broadcast('mp_shares', { peerId: from, shares });
        break;
      }
      case SNAPSHOT:
        void this.relaySnapshot(from, data.snapshot as ObjectSnapshot);
        break;
      case UPDATE:
        void this.relayUpdate(
          from,
          data.objectId as string,
          data.env as SyncEnvelope,
          data.asset as AssetMeta | undefined
        );
        break;
      case UNSHARED:
        this.broadcast('mp_shared_unshared', {
          peerId: from,
          objectId: data.objectId,
        });
        break;
      case OVERRIDE:
        this.broadcast('mp_shared_override', { peerId: from, ...data });
        break;
      case DATACHANNEL:
        this.broadcast('mp_shared_datachannel', { peerId: from, ...data });
        break;
    }
  }

  /** Owner: forward a document op to every subscriber whose subtree contains it.
   *  Forwards scene_node ops (the avatar tree): upserts (create + property /
   *  transform / model edits) resolve the owning root via parent_id; removes use
   *  the envelope's `route` ancestor hint, since the row is already gone. A live
   *  model swap also carries the new asset's metadata so the receiver can fetch
   *  it. Behaviours/effects ride the initial snapshot only — their live effect is
   *  synced as graph *output* (pose / overrides / data channels), not config (see
   *  the file header). */
  forwardDocOp(env: SyncEnvelope): void {
    if (env.rtype !== 'scene_node') return;
    const filePath = (env.data as { filePath?: string } | undefined)?.filePath;
    const asset =
      env.op === 'upsert' && filePath ? assetForPath(filePath) : null;
    for (const peerId of this.router.participants()) {
      const roots = this.rootsOf(peerId);
      if (roots.size === 0) continue;
      const root =
        env.op === 'remove'
          ? ((env.route ?? []).find((id) => roots.has(id)) ?? null)
          : findOwningRoot(env.key, roots);
      if (root)
        this.transport.sendEnvelope(peerId, {
          rtype: UPDATE,
          op: 'event',
          key: root,
          data: { objectId: root, env, asset: asset ?? undefined },
        });
    }
  }

  /** Owner: forward a live pose/blendshape frame for a shared avatar to its
   *  subscribers over the lossy `stream` channel. Pose is keyed by the avatar's
   *  scene-node id, which is the shared-object root, so a direct set membership
   *  test suffices (no parent walk on the hot path). */
  forwardStream(
    kind: string,
    nodeId: string,
    payload: Record<string, unknown>
  ): void {
    for (const peerId of this.router.participants()) {
      const roots = this.rootsOf(peerId);
      if (roots.has(nodeId))
        this.transport.sendStream(peerId, {
          rtype: STREAM,
          objectId: nodeId,
          kind,
          payload,
        });
    }
  }

  /** Owner: forward a (clip-driven) transform of a node inside a shared subtree.
   *  Unlike the root-keyed pose path, this resolves the owning root, so a clip
   *  animating a *child* of the shared object matches too (not just the root).
   *  Rides the lossy stream channel as a `node_transform_preview` frame — the
   *  receiver applies it via `smoothNodeTransform` on the projected node (owner
   *  ids are preserved). Reverts are re-sent a few frames by the caller, so a
   *  dropped frame here doesn't strand the node. */
  forwardNodeTransform(
    nodeId: string,
    transform: Record<string, number>
  ): void {
    for (const peerId of this.router.participants()) {
      const roots = this.rootsOf(peerId);
      if (roots.size === 0) continue;
      if (findOwningRoot(nodeId, roots))
        this.transport.sendStream(peerId, {
          rtype: STREAM,
          objectId: nodeId,
          kind: 'node_transform_preview',
          payload: { nodeId, transform },
        });
    }
  }

  /** Owner: forward a runtime override set/clear on a shared subtree node to its
   *  subscribers over the reliable doc channel (a dropped `clear` must not stick,
   *  so this can't ride the lossy stream channel). Overrides are low-frequency,
   *  so resolving the owning root per subscriber is fine. Only scene_node targets
   *  are shared (compose layers aren't). */
  forwardOverride(op: 'set' | 'clear', payload: Record<string, unknown>): void {
    if (payload.targetKind !== 'scene_node') return;
    const targetId = payload.targetId as string;
    for (const peerId of this.router.participants()) {
      const roots = this.rootsOf(peerId);
      if (roots.size === 0) continue;
      if (findOwningRoot(targetId, roots))
        this.transport.sendEnvelope(peerId, {
          rtype: OVERRIDE,
          op: 'event',
          key: targetId,
          data: { op, ...payload },
        });
    }
  }

  /** Owner: forward a data-channel set/clear to subscribers when its scope is a
   *  scene node inside a shared subtree (global scope '' and compose-layer scopes
   *  are not shared). Reliable doc channel — a dropped set/clear matters. */
  forwardDataChannel(op: 'set' | 'clear', payload: Record<string, unknown>): void {
    const scope = payload.scope as string;
    if (!scope) return; // global — not tied to a shared object
    for (const peerId of this.router.participants()) {
      const roots = this.rootsOf(peerId);
      if (roots.size === 0) continue;
      if (findOwningRoot(scope, roots))
        this.transport.sendEnvelope(peerId, {
          rtype: DATACHANNEL,
          op: 'event',
          key: scope,
          data: { op, ...payload },
        });
    }
  }

  /** Receiver: a forwarded live frame arrived on the stream channel → relay to
   *  the frontend, which applies it to the projected avatar (owner node ids are
   *  preserved in the projection, so the frame's nodeId maps directly). */
  handleStreamFrame(from: string, frame: Record<string, unknown>): void {
    if (frame?.rtype !== STREAM) return;
    this.broadcast('mp_shared_stream', {
      peerId: from,
      objectId: frame.objectId,
      kind: frame.kind,
      payload: frame.payload,
    });
  }

  // --- receiver-side asset localization ------------------------------------

  /** Fetch the snapshot's assets, rewrite node file paths to the local cache,
   *  then relay to the frontend. On a fetch failure the original (owner) path is
   *  kept — which still resolves when both servers share an uploads dir. */
  private async relaySnapshot(
    from: string,
    snapshot: ObjectSnapshot
  ): Promise<void> {
    const urlByPath = new Map<string, string>();
    await Promise.all(
      (snapshot.assets ?? []).map(async (a) => {
        try {
          urlByPath.set(a.filePath, await this.blob.ensure(from, a));
        } catch {
          /* keep the owner path */
        }
      })
    );
    if (urlByPath.size > 0)
      for (const n of snapshot.nodes) {
        const fp = (n as { filePath?: string }).filePath;
        if (fp && urlByPath.has(fp))
          (n as { filePath?: string }).filePath = urlByPath.get(fp);
      }
    this.broadcast('mp_shared_snapshot', { peerId: from, snapshot });
  }

  /** Localize a live update's asset (e.g. a model swap), then relay it. */
  private async relayUpdate(
    from: string,
    objectId: string,
    env: SyncEnvelope,
    asset: AssetMeta | undefined
  ): Promise<void> {
    const node = env?.data as { filePath?: string } | undefined;
    if (asset && node?.filePath) {
      try {
        node.filePath = await this.blob.ensure(from, asset);
      } catch {
        /* keep the owner path */
      }
    }
    this.broadcast('mp_shared_update', { peerId: from, objectId, env });
  }
}
