/**
 * Mesh write primitives for UI code (§11 frontend writes).
 *
 * The read half is already mesh-backed: {@link ../sync/meshStoreFeeder} mirrors
 * the tab replica into `editorStore`, and `peer.localWrite` applies to the local
 * replica *before* the authority ack. So a committed write re-renders through
 * the normal selector path immediately — there is no optimistic store write to
 * make, and a nacked write rolls back on its own.
 *
 * Two levels, matching the mesh's own channels (packages/mesh/src/channels.ts):
 *
 *   - {@link previewNodePath} — live, uncommitted. Local store only: no mesh
 *     traffic, no undo entry. This is the value a control shows mid-gesture.
 *   - {@link commitNodePath} — a retained `committed` write: persisted by the
 *     backend tap and logged on this tab's undo stack (see mesh/peer.ts §undo).
 *
 * Commit granularity is therefore a UI decision, and it matters: every committed
 * write is one undo step, so a control that commits per keystroke makes undo
 * useless. Bind controls with {@link ../hooks/useMeshField}, which owns that
 * split, rather than calling `commitNodePath` from an `onChange`.
 *
 * Dotted paths are native (`Collection.set(id, path, value)`), so an edit stamps
 * exactly its own path. Two clients editing different fields of the same node no
 * longer clobber each other the way the whole-doc REST PUT did.
 *
 * Fallback ladder for commits — mesh is skipped, REST takes over, when:
 *   - the node is a projected remote node (Phase 6 owns those writes; api/client's
 *     `remoteWriteRouter` diverts them to the owner), or
 *   - the tab peer isn't armed / the authority is offline (`canWrite()`), or
 *   - the replica doesn't hold the doc yet.
 */
import { flattenToLeaves, getPath, setPath } from '@vspark/mesh';
import { getMeshHandles } from './peer';
import { useEditorStore, type StageObject } from '../store/editorStore';
import { api } from '../api/client';

/** Whether the tab peer can author writes right now (armed + authority online).
 *  UI may use this to explain why an edit fell back to REST; the write helpers
 *  below already check it themselves. */
export function canMeshWrite(rtype = 'scene_node'): boolean {
  return getMeshHandles()?.collections[rtype]?.canWrite() ?? false;
}

/** Committed write onto the tab peer — a dotted-path replace when `path` is
 *  given, else a merge-patch of `value` (flattened to leaves under one stamp).
 *  Either way it is a single op, so a single undo step. False when the peer
 *  can't author it or the replica doesn't hold the doc — the caller falls back. */
function meshWrite(
  rtype: string,
  id: string,
  path: string | null,
  value: unknown
): boolean {
  const col = getMeshHandles()?.collections[rtype];
  if (!col?.canWrite()) return false;
  if (!col.get(id)) return false;
  if (path === null) col.update(id, value as object);
  else col.set(id, path, value);
  return true;
}

/** Read the current value at `path` on a node (undefined if absent). */
export function readNodePath(nodeId: string, path: string): unknown {
  const node = useEditorStore.getState().nodes.find((n) => n.id === nodeId);
  return node ? getPath(node, path) : undefined;
}

/** The `Partial<StageObject>` equivalent of a dotted-path write. REST and the
 *  Phase-6 remote relay both take whole top-level fields rather than paths, so
 *  the spine is rebuilt from the current node and the touched field sent whole. */
function topLevelPatch(
  node: StageObject,
  path: string,
  value: unknown
): Partial<StageObject> {
  const field = path.split('.')[0] as keyof StageObject;
  const next = setPath(node, path, value);
  return { [field]: next[field] } as Partial<StageObject>;
}

/** Live, uncommitted edit: applies locally so the viewport and panels track the
 *  gesture. Nothing leaves the tab and no undo entry is logged — call
 *  {@link commitNodePath} when the gesture settles. */
export function previewNodePath(
  nodeId: string,
  path: string,
  value: unknown
): void {
  const s = useEditorStore.getState();
  const node = s.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  s.updateNode(nodeId, topLevelPatch(node, path, value));
}

/** Commit one field. One call = one undo step. */
export function commitNodePath(
  nodeId: string,
  path: string,
  value: unknown
): void {
  const s = useEditorStore.getState();
  const node = s.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  // Remote (projected) nodes are owner-authoritative: their docs live in the
  // owner's replica, so the write has to travel the Phase-6 relay, not ours.
  if (!node.remote && meshWrite('scene_node', nodeId, path, value)) return;
  const patch = topLevelPatch(node, path, value);
  s.updateNode(nodeId, patch);
  void api.updateNode(nodeId, patch).catch(() => {});
}

/** Commit a (possibly nested) partial as one op — so an edit that genuinely
 *  spans fields stays a single undo step instead of several.
 *
 *  Merge semantics, matching the mesh: the partial is flattened to leaves, so
 *  `{ components: { godray: { power: 2 } } }` touches only that one leaf and
 *  every sibling component survives. A whole-subtree *replace* is
 *  {@link commitNodePath} with that path.
 *
 *  REST can't express any of that — `PUT` replaces `components` wholesale — so
 *  the fallback rebuilds each touched top-level field from the current node and
 *  sends it whole, reproducing the same result. */
export function commitNodePatch(
  nodeId: string,
  patch: Partial<StageObject>
): void {
  const s = useEditorStore.getState();
  const node = s.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  if (!node.remote && meshWrite('scene_node', nodeId, null, patch)) return;

  let next = node;
  for (const [p, v] of flattenToLeaves(patch)) next = setPath(next, p, v);
  const whole = Object.fromEntries(
    Object.keys(patch).map((f) => [f, next[f as keyof StageObject]])
  ) as Partial<StageObject>;
  s.updateNode(nodeId, whole);
  void api.updateNode(nodeId, whole).catch(() => {});
}
