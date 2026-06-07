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
import type { SyncEnvelope, SyncOp } from '@vspark/shared/sync';

export interface ClientResourceBinding {
  apply: (op: SyncOp, key: string, data: unknown, env: SyncEnvelope) => void;
}

const BINDINGS = new Map<string, ClientResourceBinding>();

export function bindResource(rtype: string, b: ClientResourceBinding): void {
  BINDINGS.set(rtype, b);
}

/** Apply one incoming envelope to local state. Unknown rtypes are ignored
 *  (lets the new path coexist with not-yet-migrated legacy messages). */
export function applyRemote(env: SyncEnvelope): void {
  const b = BINDINGS.get(env.rtype);
  if (!b) return;
  b.apply(env.op, env.key, env.data, env);
}
