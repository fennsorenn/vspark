/**
 * Receiver-side projection of a peer's shared object (Phase 5 multiplayer).
 *
 * The recipient places an opaque, editable **container** node (kind
 * `remote_object`, owned + persisted by the receiver) carrying a
 * `components.remoteRef = { ownerPeerId, remoteObjectId }`. The owner's shared
 * subtree (its nodes, owner-side ids) is projected as **ephemeral, in-memory**
 * nodes parented *under* that container, so:
 *   - only the container shows in the scene tree and is editable;
 *   - the shared subtree renders under the container's transform (parented), so
 *     moving the container moves the shared object, but its internals stay
 *     hidden + read-only;
 *   - the projection is dropped on unshare/disconnect/reload and restocked from
 *     the owner's snapshot on (re)subscribe — the container persists.
 *
 * Inner nodes keep the owner's ids verbatim (UUID collisions across servers are
 * negligible) so a live update's `env.key` maps straight onto a projected node.
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { useEditorStore } from '../store/editorStore';
import type { StageObject } from '../store/editorStore';
import { compareHLC, type HLC, type SyncEnvelope } from '@vspark/shared/sync';

export const REMOTE_OBJECT_KIND = 'remote_object';

interface ObjectSnapshot {
  objectId: string;
  rootName: string;
  nodes: Record<string, unknown>[];
  behaviors: Record<string, unknown>[];
  cameraEffects: Record<string, unknown>[];
  /** Node file paths are localized to the receiver's cache by the backend
   *  before the snapshot reaches us, so this is informational only here. */
  assets?: unknown[];
}

interface RemoteRef {
  ownerPeerId: string;
  remoteObjectId: string;
  name?: string;
}

/** peerId → objectId → set of projected (inner) node ids (for clean removal). */
const projected = new Map<string, Map<string, Set<string>>>();

// --- Phase 6 write reconciliation ------------------------------------------
//
// The last *owner-authoritative* DTO per inner node (from snapshot/echo), so an
// optimistic local edit can be rolled back to truth on a rejection.
const authoritativeDtos = new Map<string, Record<string, unknown>>();
// In-flight optimistic writes by node id, so the owner's echo clears them and a
// `_share_write_nak` — or a timeout — rolls them back.
interface PendingWrite {
  peerId: string;
  objectId: string;
  op: 'update' | 'create' | 'delete';
  /** Fires `rollbackWrite` if no authoritative echo/NAK lands in time. */
  timer: ReturnType<typeof setTimeout>;
}
const pendingWrites = new Map<string, PendingWrite>();
// How long to wait for the owner's authoritative echo (or NAK) before treating an
// optimistic write as failed and reverting it — covers a silently-dropped edge or
// an owner that never answers, where no NAK is ever delivered.
const WRITE_TIMEOUT_MS = 10_000;

/** Drop a resolved pending write (echo/NAK/rollback landed): cancel its timer so
 *  it can't fire a late rollback against already-reconciled state. */
function clearPending(nodeId: string): void {
  const p = pendingWrites.get(nodeId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingWrites.delete(nodeId);
}
// Last applied HLC per inner node — drop stale/duplicate echoes (mirrors the
// unified-sync registry's stale-drop).
const lastVersion = new Map<string, HLC>();

function track(peerId: string, objectId: string, nodeId: string): void {
  let byObject = projected.get(peerId);
  if (!byObject) projected.set(peerId, (byObject = new Map()));
  let ids = byObject.get(objectId);
  if (!ids) byObject.set(objectId, (ids = new Set()));
  ids.add(nodeId);
}

function refOf(n: StageObject): RemoteRef | undefined {
  return (n.components as { remoteRef?: RemoteRef } | undefined)?.remoteRef;
}

/** The container node a (peerId, objectId) projection attaches under, if placed. */
export function findContainer(
  peerId: string,
  objectId: string
): StageObject | undefined {
  return useEditorStore
    .getState()
    .nodes.find(
      (n) =>
        n.kind === REMOTE_OBJECT_KIND &&
        refOf(n)?.ownerPeerId === peerId &&
        refOf(n)?.remoteObjectId === objectId
    );
}

/** Whether a given object from a peer is currently projected locally. */
export function isProjected(peerId: string, objectId: string): boolean {
  return (projected.get(peerId)?.get(objectId)?.size ?? 0) > 0;
}

/** Rewrite an owner-side node DTO into a local, render-ready inner node: attach
 *  the subtree root under the container, keep the rest of the tree, tag it
 *  `remote` (hidden from the tree + read-only). */
function projectNode(
  dto: Record<string, unknown>,
  peerId: string,
  objectId: string,
  container: StageObject
): StageObject {
  const n = dto as unknown as StageObject;
  return {
    ...n,
    rootSceneNodeId: container.rootSceneNodeId,
    parentId: n.id === objectId ? container.id : n.parentId,
    remote: true,
    remoteOwnerPeerId: peerId,
  };
}

/** Apply a fresh snapshot: replace any prior projection of this object. No-op if
 *  the container hasn't been placed yet. */
export function applySnapshot(peerId: string, snapshot: ObjectSnapshot): void {
  const container = findContainer(peerId, snapshot.objectId);
  if (!container) return;
  const store = useEditorStore.getState();
  removeProjection(peerId, snapshot.objectId);
  for (const raw of snapshot.nodes) {
    const node = projectNode(raw, peerId, snapshot.objectId, container);
    store.addNode(node);
    track(peerId, snapshot.objectId, node.id);
    authoritativeDtos.set(node.id, raw); // baseline for rollback
  }
}

/** Optimistically add a locally-minted node to a projected subtree (Phase 6
 *  create): project it under the container, add + track it. No authoritative DTO
 *  is recorded yet — the owner's echo (or a NAK rollback) is the source of truth. */
export function addProjectedNode(
  peerId: string,
  objectId: string,
  dto: Record<string, unknown>
): void {
  const container = findContainer(peerId, objectId);
  if (!container) return;
  const node = projectNode(dto, peerId, objectId, container);
  useEditorStore.getState().addNode(node);
  track(peerId, objectId, node.id);
}

/** Apply a live `scene_node` document op forwarded by the owner. */
export function applyUpdate(
  peerId: string,
  objectId: string,
  env: SyncEnvelope
): void {
  if (env.rtype !== 'scene_node') return;
  if (!projected.get(peerId)?.has(objectId)) return; // not placed locally
  const container = findContainer(peerId, objectId);
  if (!container) return;
  const store = useEditorStore.getState();

  // Stale-drop: an older echo (e.g. our own optimistic write racing a newer
  // authoritative one) must not clobber newer state.
  if (env.v) {
    const prev = lastVersion.get(env.key);
    if (prev && compareHLC(env.v, prev) <= 0) return;
    lastVersion.set(env.key, env.v);
  }
  // This authoritative echo supersedes any optimistic write we had in flight.
  clearPending(env.key);

  if (env.op === 'remove') {
    store.deleteNode(env.key);
    projected.get(peerId)?.get(objectId)?.delete(env.key);
    authoritativeDtos.delete(env.key);
    return;
  }
  if (env.op === 'upsert' && env.data) {
    authoritativeDtos.set(env.key, env.data as Record<string, unknown>);
    const node = projectNode(
      env.data as Record<string, unknown>,
      peerId,
      objectId,
      container
    );
    if (store.nodes.some((x) => x.id === node.id)) {
      store.updateNode(node.id, node);
    } else {
      store.addNode(node);
      track(peerId, objectId, node.id);
    }
  }
}

/** Which subscribed object root (objectId) a projected inner node belongs to. */
export function owningProjectionRoot(
  peerId: string,
  nodeId: string
): string | undefined {
  const byObject = projected.get(peerId);
  if (!byObject) return undefined;
  for (const [objectId, ids] of byObject) if (ids.has(nodeId)) return objectId;
  return undefined;
}

/** Owner-side ancestor chain [nodeId … objectId] for a `remove` route hint —
 *  walks projected parents up to the subscribed root. */
export function ancestorRoute(
  peerId: string,
  objectId: string,
  nodeId: string
): string[] {
  const ids = projected.get(peerId)?.get(objectId);
  const store = useEditorStore.getState();
  const route: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = nodeId;
  while (cur && ids?.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    route.push(cur);
    cur = store.nodes.find((x) => x.id === cur)?.parentId;
  }
  if (!route.includes(objectId)) route.push(objectId);
  return route;
}

/** Record an in-flight optimistic write so the owner echo clears it, or a NAK /
 *  timeout rolls it back. Supersedes any prior in-flight write on the same node
 *  (its timer is replaced). */
export function recordPendingWrite(
  peerId: string,
  objectId: string,
  nodeId: string,
  op: PendingWrite['op']
): void {
  clearPending(nodeId);
  const timer = setTimeout(() => rollbackWrite(nodeId), WRITE_TIMEOUT_MS);
  pendingWrites.set(nodeId, { peerId, objectId, op, timer });
}

/** Roll an optimistic write back to the last authoritative state after the owner
 *  rejected it (`_share_write_nak`) or it timed out. */
export function rollbackWrite(nodeId: string): void {
  const p = pendingWrites.get(nodeId);
  if (!p) return;
  clearPending(nodeId);
  const store = useEditorStore.getState();
  if (p.op === 'create') {
    store.deleteNode(nodeId);
    projected.get(p.peerId)?.get(p.objectId)?.delete(nodeId);
    return;
  }
  // update / delete → restore the authoritative DTO.
  const dto = authoritativeDtos.get(nodeId);
  const container = findContainer(p.peerId, p.objectId);
  if (!dto || !container) return;
  const node = projectNode(dto, p.peerId, p.objectId, container);
  if (store.nodes.some((x) => x.id === nodeId)) store.updateNode(nodeId, node);
  else {
    store.addNode(node);
    track(p.peerId, p.objectId, nodeId);
  }
}

/** Remove a single object's projected subtree (unshare, or before re-snapshot).
 *  Leaves the container in place (it persists; it restocks on re-subscribe). */
export function removeProjection(peerId: string, objectId: string): void {
  const ids = projected.get(peerId)?.get(objectId);
  if (!ids) return;
  const store = useEditorStore.getState();
  for (const id of ids) store.deleteNode(id);
  projected.get(peerId)?.delete(objectId);
  // Cancel any in-flight write timers for this object so they don't fire a
  // rollback against a projection that's already gone.
  for (const [nodeId, p] of pendingWrites)
    if (p.peerId === peerId && p.objectId === objectId) clearPending(nodeId);
}

/** Remove every projected subtree from a peer (disconnect / peer gone). The
 *  containers stay as placeholders and restock when the peer reconnects. */
export function removePeerProjections(peerId: string): void {
  const byObject = projected.get(peerId);
  if (!byObject) return;
  const store = useEditorStore.getState();
  for (const ids of byObject.values())
    for (const id of ids) store.deleteNode(id);
  projected.delete(peerId);
  for (const [nodeId, p] of pendingWrites)
    if (p.peerId === peerId) clearPending(nodeId);
}
