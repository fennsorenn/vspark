/**
 * Unified sync producer hub (server side).
 *
 * Routes / managers call `sync.document.*` / `sync.field.*` / `sync.stream.*` /
 * `sync.event.*` instead of hand-writing `_ws.broadcast(...)`. The hub looks up
 * the resource descriptor, builds a canonical {@link SyncEnvelope}, and hands it
 * to the transport (today: the shared WebSocket hub).
 *
 * Phase 0 wires the plumbing; producers are migrated onto it in later phases.
 * Until a resource type is registered + a route calls into the hub, nothing is
 * emitted — so this coexists with the legacy bespoke broadcasts.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { randomUUID } from 'crypto';
import type { WSSync } from '../ws/index.js';
import {
  SYNC_MESSAGE_KIND,
  makeHlcClock,
  type SyncEnvelope,
} from '@vspark/shared/sync';
import { getResource } from './registry.js';

class SyncHub {
  private _ws: WSSync | null = null;
  /** This server's peer id — the `origin` tag + HLC tiebreak. Stable per process. */
  private readonly _peerId = randomUUID();
  private readonly _clock = makeHlcClock(this._peerId);
  /** Listeners notified of every document op (e.g. the multiplayer sharing
   *  manager, which forwards shared objects' updates to subscribed peers). */
  private readonly _docListeners: ((env: SyncEnvelope) => void)[] = [];

  init(ws: WSSync): void {
    this._ws = ws;
  }

  /** Observe every document upsert/remove (after it's broadcast locally). */
  onDocument(cb: (env: SyncEnvelope) => void): void {
    this._docListeners.push(cb);
  }

  private send(env: SyncEnvelope): void {
    this._ws?.broadcast(
      SYNC_MESSAGE_KIND,
      env as unknown as Record<string, unknown>
    );
    if (env.op === 'upsert' || env.op === 'remove')
      for (const cb of this._docListeners)
        // One listener throwing must not abort the others (the mesh bridge
        // mirror, containment index, and share fan-out are independent) nor
        // bubble into the route that emitted the document.
        try {
          cb(env);
        } catch (e) {
          console.error(
            `[sync] document listener failed for ${env.rtype}:${env.key}:`,
            e
          );
        }
  }

  readonly document = {
    /** Load the row via its descriptor, map to the canonical DTO, broadcast an
     *  HLC-stamped upsert so out-of-order delivery can't clobber a newer value. */
    upsert: (rtype: string, id: string): void => {
      const r = getResource(rtype);
      if (!r?.load) return;
      const dto = r.load(id);
      if (!dto) return;
      this.send({
        rtype,
        op: 'upsert',
        key: id,
        scope: r.scope?.(dto),
        data: dto,
        v: this._clock(),
        origin: this._peerId,
      });
    },
    /** Broadcast an HLC-stamped removal. The stamp doubles as a tombstone marker
     *  on the client (a stale upsert with an older stamp won't resurrect it).
     *  `route` is the deleted node's ancestor chain (captured before deletion) so
     *  subtree-scoped doc listeners (share fan-out) can resolve the owning root
     *  even though the row no longer exists. */
    remove: (
      rtype: string,
      id: string,
      scope?: string,
      route?: string[]
    ): void => {
      this.send({
        rtype,
        op: 'remove',
        key: id,
        scope,
        route,
        v: this._clock(),
        origin: this._peerId,
      });
    },

    /** Forward a document update to doc listeners (share fan-out) WITHOUT
     *  re-broadcasting to local WS clients. Used by routes that already emit a
     *  legacy (smoothing-aware) update to their own clients but still need the
     *  canonical doc carried across the mesh to subscribers. */
    touch: (rtype: string, id: string): void => {
      const r = getResource(rtype);
      if (!r?.load) return;
      const dto = r.load(id);
      if (!dto) return;
      const env: SyncEnvelope = {
        rtype,
        op: 'upsert',
        key: id,
        scope: r.scope?.(dto),
        data: dto,
        v: this._clock(),
        origin: this._peerId,
      };
      for (const cb of this._docListeners) cb(env);
    },
  };

  // field producer is filled in by Phase 2 (override/data-channel fold).

  readonly stream = {
    /** Publish one frame of a high-frequency stream (pose, blendshapes, IK).
     *  Lossy + latest-wins by nature: no HLC stamp, no persistence, no snapshot.
     *  NOTE: the live pose/blendshape/IK broadcasts are not migrated onto this
     *  yet — that hot-path swap is deferred until it can be runtime-verified. */
    publish: (
      rtype: string,
      key: string,
      frame: Record<string, unknown>,
      scope?: string
    ): void => {
      this.send({ rtype, op: 'frame', key, scope, data: frame });
    },
  };

  readonly event = {
    /** Fire-and-forget command; no snapshot, no persistence. */
    emit: (
      rtype: string,
      data: Record<string, unknown>,
      scope?: string
    ): void => {
      this.send({ rtype, op: 'event', key: rtype, scope, data });
    },
  };

  /** Send a fresh client the current state of every snapshot-capable resource.
   *  Phase 0: no-op (clients still hydrate documents via the REST load on mount).
   *  Field/stream resources register snapshot providers in later phases. */
  sendSnapshotTo(_send: (env: SyncEnvelope) => void): void {
    // intentionally empty until field/stream resources land
  }
}

export const sync = new SyncHub();
