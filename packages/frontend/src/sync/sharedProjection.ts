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
import type { NodeRecord } from '../store/editorStore';
import type { SyncEnvelope } from '@vspark/shared/sync';

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

function track(peerId: string, objectId: string, nodeId: string): void {
  let byObject = projected.get(peerId);
  if (!byObject) projected.set(peerId, (byObject = new Map()));
  let ids = byObject.get(objectId);
  if (!ids) byObject.set(objectId, (ids = new Set()));
  ids.add(nodeId);
}

function refOf(n: NodeRecord): RemoteRef | undefined {
  return (n.components as { remoteRef?: RemoteRef } | undefined)?.remoteRef;
}

/** The container node a (peerId, objectId) projection attaches under, if placed. */
export function findContainer(
  peerId: string,
  objectId: string
): NodeRecord | undefined {
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
  container: NodeRecord
): NodeRecord {
  const n = dto as unknown as NodeRecord;
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
  }
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

  if (env.op === 'remove') {
    store.deleteNode(env.key);
    projected.get(peerId)?.get(objectId)?.delete(env.key);
    return;
  }
  if (env.op === 'upsert' && env.data) {
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

/** Remove a single object's projected subtree (unshare, or before re-snapshot).
 *  Leaves the container in place (it persists; it restocks on re-subscribe). */
export function removeProjection(peerId: string, objectId: string): void {
  const ids = projected.get(peerId)?.get(objectId);
  if (!ids) return;
  const store = useEditorStore.getState();
  for (const id of ids) store.deleteNode(id);
  projected.get(peerId)?.delete(objectId);
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
}
