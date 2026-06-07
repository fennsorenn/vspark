/**
 * Client-side resource registry + the single remote-apply dispatcher for the
 * unified sync layer.
 *
 * Each resource type binds once (rtype → how to apply it to the store). The
 * `useWsSync` hook routes every `sync` envelope through `applyRemote`, replacing
 * the per-message if/else chain as resources are migrated.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import {
  compareHLC,
  type HLC,
  type SyncEnvelope,
  type SyncOp,
} from '@vspark/shared/sync';

export interface ClientResourceBinding {
  apply: (op: SyncOp, key: string, data: unknown, env: SyncEnvelope) => void;
}

const BINDINGS = new Map<string, ClientResourceBinding>();

/** Last applied HLC stamp per `rtype:key`. Drops out-of-order / duplicate
 *  envelopes (and prevents a stale upsert resurrecting a removed entity, since
 *  the removal's stamp stays recorded as a tombstone). Streams omit `v`, so
 *  they bypass this entirely (latest-wins by arrival). */
const lastVersion = new Map<string, HLC>();

export function bindResource(rtype: string, b: ClientResourceBinding): void {
  BINDINGS.set(rtype, b);
}

/** Apply one incoming envelope to local state. Unknown rtypes are ignored
 *  (lets the new path coexist with not-yet-migrated legacy messages). */
export function applyRemote(env: SyncEnvelope): void {
  const b = BINDINGS.get(env.rtype);
  if (!b) return;
  if (env.v) {
    const k = `${env.rtype}:${env.key}`;
    const prev = lastVersion.get(k);
    if (prev && compareHLC(env.v, prev) <= 0) return; // stale / duplicate
    lastVersion.set(k, env.v);
  }
  b.apply(env.op, env.key, env.data, env);
}
