/**
 * Receiver-side projection of a peer's shared object into the local scene
 * (Phase 5 multiplayer). The owner sends an {@link ObjectSnapshot} (its node
 * subtree, owner-side ids) plus live `scene_node` document updates; we inject
 * those nodes into the editor store flagged `remote` so the existing
 * Viewport/Avatar/SceneGraph render them without any extra rendering path.
 *
 * Remote nodes are purely in-memory: never PUT, dropped on reload, unshare, or
 * disconnect, and restocked from the owner's snapshot on (re)subscribe. We keep
 * the owner's ids verbatim (UUID collisions across servers are negligible) so a
 * live update's `env.key` maps straight onto the projected node.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { useEditorStore } from '../store/editorStore';
import type { NodeRecord } from '../store/editorStore';
import type { SyncEnvelope } from '@vspark/shared/sync';

interface ObjectSnapshot {
  objectId: string;
  rootName: string;
  nodes: Record<string, unknown>[];
  behaviors: Record<string, unknown>[];
  cameraEffects: Record<string, unknown>[];
  assetHashes: string[];
}

/** peerId → objectId → set of projected node ids (so we can remove cleanly). */
const projected = new Map<string, Map<string, Set<string>>>();

function track(peerId: string, objectId: string, nodeId: string): void {
  let byObject = projected.get(peerId);
  if (!byObject) projected.set(peerId, (byObject = new Map()));
  let ids = byObject.get(objectId);
  if (!ids) byObject.set(objectId, (ids = new Set()));
  ids.add(nodeId);
}

/** Whether a given object from a peer is currently projected locally. */
export function isProjected(peerId: string, objectId: string): boolean {
  return (projected.get(peerId)?.get(objectId)?.size ?? 0) > 0;
}

/** Rewrite an owner-side node DTO into a local, render-ready remote node:
 *  attach it to the active scene, sever the subtree root from the owner's
 *  parent, and tag it `remote`. */
function projectNode(
  dto: Record<string, unknown>,
  peerId: string,
  objectId: string,
  activeSceneId: string
): NodeRecord {
  const n = dto as unknown as NodeRecord;
  return {
    ...n,
    rootSceneNodeId: activeSceneId,
    parentId: n.id === objectId ? null : n.parentId,
    remote: true,
    remoteOwnerPeerId: peerId,
  };
}

/** Apply a fresh snapshot: replace any prior projection of this object. */
export function applySnapshot(peerId: string, snapshot: ObjectSnapshot): void {
  const store = useEditorStore.getState();
  const activeSceneId = store.activeSceneId;
  if (!activeSceneId) return;
  removeProjection(peerId, snapshot.objectId);
  for (const raw of snapshot.nodes) {
    const node = projectNode(raw, peerId, snapshot.objectId, activeSceneId);
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
  const store = useEditorStore.getState();
  const activeSceneId = store.activeSceneId;
  if (!activeSceneId) return;

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
      activeSceneId
    );
    if (store.nodes.some((x) => x.id === node.id)) {
      store.updateNode(node.id, node);
    } else {
      store.addNode(node);
      track(peerId, objectId, node.id);
    }
  }
}

/** Remove a single object's projection (unshare, or before re-snapshot). */
export function removeProjection(peerId: string, objectId: string): void {
  const ids = projected.get(peerId)?.get(objectId);
  if (!ids) return;
  const store = useEditorStore.getState();
  for (const id of ids) store.deleteNode(id);
  projected.get(peerId)?.delete(objectId);
}

/** Remove every projection from a peer (disconnect / peer gone). */
export function removePeerProjections(peerId: string): void {
  const byObject = projected.get(peerId);
  if (!byObject) return;
  const store = useEditorStore.getState();
  for (const ids of byObject.values())
    for (const id of ids) store.deleteNode(id);
  projected.delete(peerId);
}
