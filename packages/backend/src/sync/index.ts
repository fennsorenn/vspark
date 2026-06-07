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
import type { WSSync } from '../ws/index.js';
import { SYNC_MESSAGE_KIND, type SyncEnvelope } from '@vspark/shared/sync';
import { getResource } from './registry.js';

class SyncHub {
  private _ws: WSSync | null = null;

  init(ws: WSSync): void {
    this._ws = ws;
  }

  private send(env: SyncEnvelope): void {
    this._ws?.broadcast(
      SYNC_MESSAGE_KIND,
      env as unknown as Record<string, unknown>
    );
  }

  readonly document = {
    /** Load the row via its descriptor, map to the canonical DTO, broadcast an upsert. */
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
      });
    },
    /** Broadcast a removal. `scope` is optional (the row may already be gone). */
    remove: (rtype: string, id: string, scope?: string): void => {
      this.send({ rtype, op: 'remove', key: id, scope });
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
