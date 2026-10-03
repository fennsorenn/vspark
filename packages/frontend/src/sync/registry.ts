/**
 * Client-side resource registry + the single remote-apply dispatcher for the
 * unified sync layer.
 *
 * INERT. `bindResource` has no callers anywhere in the repo, so BINDINGS is
 * always empty and `applyRemote` returns immediately — every `sync` envelope
 * useWsSync routes here is dropped. Documents reach the store from
 * the tab's mesh replica instead (sync/meshStoreFeeder.ts); the server still
 * emits envelopes for other consumers, which is the only reason the dispatcher
 * is still called. Kept as a landing pad in case a binding ever returns.
 *
 * Historical design (the envelope layer this was written for, superseded by
 * the mesh): dev-notes/plans/unified-sync-layer.md.
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
