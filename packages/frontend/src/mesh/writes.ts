/**
 * Scene-node writes on the mesh (see ./docs for the primitives).
 *
 * Two levels, matching the mesh's own channels:
 *
 *   - `preview*` — live, uncommitted, on the lossy `preview` channel: everyone
 *     sees it as an overlay, nothing persists, no undo entry.
 *   - `commit*` — a committed write: persisted by the backend, and logged on
 *     this tab's undo stack. One call, one undo step, so bind controls with
 *     {@link ../hooks/useMeshField}, which commits once per gesture.
 *
 * Dotted paths are native (`Collection.set(id, path, value)`), so an edit
 * stamps exactly its own path: two clients editing different fields of one node
 * don't clobber each other.
 *
 * A node projected from a peer's placed object (Phase 6) is written through the
 * REST client, whose remote-write router hands it to the owner — until the
 * Phase-6 legacy goes (mesh-sole-channel W7).
 *
 * Anything that spans several writes belongs in a `meshBatch` so the user
 * undoes the action rather than its individual writes.
 */
import { setPath } from '@vspark/mesh';
import { meshBatch } from './peer';
import {
  collectionOf,
  createDoc,
  patchDoc,
  previewField,
  removeDoc,
  setField,
} from './docs';
import { actionLabel, reportRejected } from './writeFeedback';
import { composeLayersNow } from './compose';
import { sceneNodesNow } from './nodes';
import { useEditorStore, type StageObject } from '../store/editorStore';
import { api } from '../api/client';

const RTYPE = 'scene_node';

const projected = (id: string): StageObject | undefined =>
  useEditorStore.getState().projectedNodes.find((n) => n.id === id);

/** Phase 6: the whole top-level field a path lives in, for the REST write a
 *  projected node goes through (REST takes fields, not paths). */
function restPatch(
  node: StageObject,
  path: string,
  value: unknown
): Partial<StageObject> {
  const field = path.split('.')[0] as keyof StageObject;
  return { [field]: setPath(node, path, value)[field] } as Partial<StageObject>;
}

/** Live, uncommitted edit of one node field. */
export function previewNodePath(
  nodeId: string,
  path: string,
  value: unknown
): void {
  if (projected(nodeId)) return;
  previewField(RTYPE, nodeId, path, value);
}

/** In-flight transform values for a node gesture, on the `preview` channel.
 *
 *  Takes the flat gesture payload (`{x, y, rx, …}`) and writes ONE overlay PER
 *  SCALAR, at `components.transform.<field>`. Not one overlay at
 *  `components.transform`: that would blank the component's other fields —
 *  opacity, castShadow, receiveShadow — for every watching tab for the duration
 *  of the drag. */
export function previewNodeTransform(
  nodeId: string,
  transform: Record<string, number>
): void {
  if (projected(nodeId)) return;
  const col = collectionOf(RTYPE);
  if (!col.get(nodeId)) return;
  // This tab shows its own gesture through `liveNodes` too: node lists skip
  // transform previews (mesh/nodes.ts). The commit clears it.
  useEditorStore.getState().setLiveNode(nodeId, transform);
  for (const [f, v] of Object.entries(transform))
    col.set(nodeId, `components.transform.${f}`, v, { channel: 'preview' });
}

/** Commit one field. One call = one undo step. */
export function commitNodePath(
  nodeId: string,
  path: string,
  value: unknown
): void {
  const remote = projected(nodeId);
  if (remote) {
    void api.updateNode(nodeId, restPatch(remote, path, value));
    return;
  }
  setField(RTYPE, nodeId, path, value);
}

/** Commit a (possibly nested) partial as one op — flattened to leaves, so
 *  siblings of a nested leaf survive. */
export function commitNodePatch(
  nodeId: string,
  patch: Partial<StageObject>
): void {
  if (projected(nodeId)) {
    void api.updateNode(nodeId, patch);
    return;
  }
  patchDoc(RTYPE, nodeId, patch);
}

/** Delete a node and everything contained in it, as one undo action. */
export function commitNodeDelete(nodeId: string): Promise<boolean> {
  if (projected(nodeId))
    return api
      .deleteNode(nodeId)
      .then(() => true)
      .catch(() => false);
  return removeDoc(RTYPE, nodeId);
}

/** Re-parent a node's direct children onto `newParentId`, then delete it — one
 *  undo action, so "delete but keep children" reverses in a single step. */
export async function commitNodeDeleteKeepChildren(
  nodeId: string,
  newParentId: string | null
): Promise<boolean> {
  const col = collectionOf(RTYPE);
  if (!col.get(nodeId)) return false;
  const children = sceneNodesNow().filter((n) => n.parentId === nodeId);
  const acks = meshBatch(() => [
    ...children.map((c) => col.set(c.id, 'parentId', newParentId).ack),
    col.remove(nodeId).ack,
  ]);
  const outcomes = await Promise.all(acks);
  const refused = outcomes.find((o) => o.status === 'rejected');
  if (refused && refused.status === 'rejected')
    reportRejected(actionLabel(RTYPE), refused.reason);
  return !refused;
}

/** Create a node; the backend re-derives `projectId` and validates the doc. */
export function commitNodeCreate(
  sceneId: string,
  spec: {
    name: string;
    kind: string;
    parentId?: string | null;
    boneAttachment?: string | null;
    filePath?: string | null;
    components?: Record<string, unknown>;
    properties?: StageObject['properties'];
  }
): Promise<StageObject> {
  return createDoc<StageObject>(RTYPE, {
    id: crypto.randomUUID(),
    rootSceneNodeId: sceneId,
    projectId: useEditorStore.getState().projectId ?? '',
    parentId: spec.parentId ?? null,
    boneAttachment: spec.boneAttachment ?? null,
    name: spec.name,
    kind: spec.kind,
    filePath: spec.filePath ?? null,
    components: spec.components ?? {},
    properties: spec.properties ?? {},
    hidden: false,
  });
}

// --- scenes -------------------------------------------------------------------

/** Create an empty scene (a `kind: 'scene'` root node) in the open project.
 *  Resolves the new scene's id. */
export async function commitSceneCreate(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await createDoc<StageObject>(RTYPE, {
    id,
    rootSceneNodeId: id,
    projectId: useEditorStore.getState().projectId ?? '',
    parentId: null,
    boneAttachment: null,
    name,
    kind: 'scene',
    filePath: null,
    components: {},
    properties: {},
    hidden: false,
  });
  return id;
}

/** Delete a scene as ONE undo action: everything in its containment tree,
 *  plus the compose camera views that show one of its cameras (a reference,
 *  not containment). */
export async function commitSceneDelete(sceneId: string): Promise<boolean> {
  const nodesCol = collectionOf(RTYPE);
  const layersCol = collectionOf('compose_layer');
  if (!nodesCol.get(sceneId)) return false;
  const inScene = new Set(
    sceneNodesNow()
      .filter((n) => n.rootSceneNodeId === sceneId)
      .map((n) => n.id)
  );
  const views = composeLayersNow().filter(
    (l) => l.cameraNodeId && inScene.has(l.cameraNodeId)
  );
  const outcomes = await Promise.all(
    meshBatch(() => [
      ...views
        .filter((l) => layersCol.get(l.id))
        .map((l) => layersCol.remove(l.id)),
      ...nodesCol.removeTree(sceneId),
    ]).map((h) => h.ack)
  );
  const refused = outcomes.find((o) => o.status === 'rejected');
  if (refused && refused.status === 'rejected')
    reportRejected(actionLabel(RTYPE), refused.reason);
  return !refused;
}
