/**
 * The short-lived half of the graph-variable store: `runtime_variable`
 * documents on the retained `runtime` channel — reliable, stamped, delivered
 * to late joiners, never acked (so never on an undo stack) and never
 * persisted, so they are gone when this process restarts. The persistent half
 * is the `variable` collection, bound with a table in mesh/index.ts. Both are
 * declared in `@vspark/shared/models`; reads and writes go through
 * variables/store.ts, which keeps each variable in exactly one of the two.
 */
import type { Collection, MeshPeer } from '@vspark/mesh';

export const RUNTIME_VARIABLE_RTYPE = 'runtime_variable';

/** One graph variable, persistent or short-lived (same shape in both). */
export interface VariableDoc {
  id: string;
  projectId: string;
  /** '' = the shared namespace; a Logic graph id = private to that graph. */
  scope: string;
  name: string;
  value: unknown;
  [k: string]: unknown;
}

let _col: Collection<VariableDoc> | null = null;

/** Register the runtime-variable collection. Idempotent. */
export function initRuntimeVariables(peer: MeshPeer): void {
  if (_col) return;
  _col = peer.collection<VariableDoc>(RUNTIME_VARIABLE_RTYPE);
  peer.grants.grant({
    // Our tabs read them, and write them too: a widget's Start / Pause
    // buttons put the timer state, and the nodes holding it react.
    grantee: peer.id,
    entityRtype: RUNTIME_VARIABLE_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, create: true, update: true, delete: true },
  });
}

/** The collection, or null before the mesh is up. */
export function runtimeVariableCollection(): Collection<VariableDoc> | null {
  return _col;
}

/** Test seam — the next init rebuilds against a fresh peer. */
export function resetRuntimeVariables(): void {
  _col = null;
}
