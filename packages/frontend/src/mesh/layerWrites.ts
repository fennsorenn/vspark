/**
 * Compose-layer writes on the mesh (see ./docs for the primitives).
 *
 * Two things differ from scene nodes:
 *
 *   - **Sibling order is a fractional key.** A move writes ONE layer's
 *     `orderKey`, generated strictly between its new neighbours, so concurrent
 *     moves by two peers commute. {@link orderKeyForIndex} is the one place
 *     that computes it.
 *   - **A compose scene is itself a compose_layer document** — the root of its
 *     tree. Deleting one is a subtree delete, like deleting a node with
 *     children.
 */
import { keyBetween } from '@vspark/shared/fracIndex';
import { meshBatch } from './peer';
import { actionLabel, reportRejected } from './writeFeedback';
import { collectionOf, createDoc, patchDoc, removeDoc, setField } from './docs';
import { composeAllNow, composeScenesNow } from './compose';
import { useEditorStore, type StageObject } from '../store/editorStore';
import type { ComposeLayerRecord } from '../api/client';

const RTYPE = 'compose_layer';
const all = composeAllNow;

/** Siblings of a layer in paint order (ascending key = back→front). Two peers
 *  inserting into the same gap can generate the same key, so `id` breaks the
 *  tie — identically on every peer. */
export function orderedSiblingsOf(
  layer: Pick<ComposeLayerRecord, 'id' | 'rootComposeSceneId' | 'parentId'>
): ComposeLayerRecord[] {
  return all()
    .filter(
      (l) =>
        l.rootComposeSceneId === layer.rootComposeSceneId &&
        (l.parentId ?? null) === (layer.parentId ?? null)
    )
    .sort(
      (a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id)
    );
}

/** The key that lands `layerId` at `index` in the back→front sequence of
 *  `siblings` (which may still contain the layer itself). */
export function orderKeyForIndex(
  siblings: ComposeLayerRecord[],
  layerId: string,
  index: number
): string {
  const rest = siblings.filter((l) => l.id !== layerId);
  const at = Math.max(0, Math.min(index, rest.length));
  return keyBetween(rest[at - 1]?.orderKey ?? null, rest[at]?.orderKey ?? null);
}

/** In-flight gesture value, on the mesh's lossy `preview` channel: one
 *  overlay per path, so other tabs watch the gesture without it becoming model
 *  state, and the overlay clears when the committed write lands. A pathless
 *  ephemeral write would be a root overlay that replaces the whole document. */
export function previewLayerFields(
  id: string,
  patch: Record<string, unknown>
): void {
  const col = collectionOf(RTYPE);
  if (!col.get(id)) return;
  for (const [path, value] of Object.entries(patch))
    col.set(id, path, value, { channel: 'preview' });
}

export const commitLayerPath = (
  id: string,
  path: string,
  value: unknown
): void => void setField(RTYPE, id, path, value);

export const commitLayerPatch = (
  id: string,
  patch: Partial<ComposeLayerRecord>
): void => void patchDoc(RTYPE, id, patch);

/** Delete a layer and everything under it as ONE undo action. A compose scene
 *  is just a layer with children, so this covers deleting a whole scene. */
export const commitLayerDelete = (id: string): Promise<boolean> =>
  removeDoc(RTYPE, id);

/** Detach a layer's direct children onto `newParentId`, then delete it — one
 *  undo action, so the reparents don't unwind separately. */
export async function commitLayerDeleteKeepChildren(
  id: string,
  newParentId: string | null
): Promise<boolean> {
  const col = collectionOf(RTYPE);
  if (!col.get(id)) return false;
  const children = all().filter((l) => (l.parentId ?? null) === id);
  const acks = meshBatch(() => [
    ...children.map((c) => col.set(c.id, 'parentId', newParentId).ack),
    col.remove(id).ack,
  ]);
  const outcomes = await Promise.all(acks);
  const refused = outcomes.find((o) => o.status === 'rejected');
  if (refused && refused.status === 'rejected')
    reportRejected(actionLabel(RTYPE), refused.reason);
  return !refused;
}

/** Create a layer; the backend re-derives `projectId`. A new layer goes to the
 *  FRONT of its sibling group. */
export function commitLayerCreate(
  composeSceneId: string,
  spec: Omit<
    Partial<ComposeLayerRecord>,
    'id' | 'rootComposeSceneId' | 'projectId'
  > & { name: string; kind: string }
): Promise<ComposeLayerRecord> {
  const parentId = spec.parentId ?? null;
  const siblings = orderedSiblingsOf({
    id: '',
    rootComposeSceneId: composeSceneId,
    parentId,
  });
  const doc = {
    id: crypto.randomUUID(),
    projectId: useEditorStore.getState().projectId ?? '',
    rootComposeSceneId: composeSceneId,
    cameraNodeId: spec.cameraNodeId ?? null,
    parentId,
    name: spec.name,
    kind: spec.kind,
    assetId: spec.assetId ?? null,
    config: spec.config ?? {},
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: spec.width ?? 320,
    height: spec.height ?? 180,
    rotation: spec.rotation ?? 0,
    anchorH: spec.anchorH ?? 'left',
    anchorV: spec.anchorV ?? 'top',
    orderKey: keyBetween(siblings[siblings.length - 1]?.orderKey ?? null, null),
    visible: spec.visible !== false,
  } as ComposeLayerRecord;

  return createDoc(RTYPE, doc);
}

/**
 * Promote a compose layer into a 3D node: create the node and remove the layer
 * as ONE undo action.
 *
 * Both writes are ISSUED inside the batch and their acks awaited afterwards —
 * `meshBatch` groups by issue time, not completion, so awaiting the create
 * before issuing the delete would put them in separate actions. Without that,
 * undo would bring the 2D layer back while leaving the 3D node behind (or vice
 * versa), which is a state the user never authored.
 */
export async function commitPromoteLayerToNode(
  node: StageObject,
  layerId: string
): Promise<StageObject> {
  const nodeCol = collectionOf('scene_node');
  const layerCol = collectionOf(RTYPE);
  const subtree = [
    ...all().filter((l) => (l.parentId ?? null) === layerId),
  ].reverse();
  const acks = meshBatch(() => [
    nodeCol.create(node as unknown as Record<string, unknown>).ack,
    ...subtree.map((l) => layerCol.remove(l.id).ack),
    layerCol.remove(layerId).ack,
  ]);
  const outcomes = await Promise.all(acks);
  const bad = outcomes.find((o) => o.status === 'rejected');
  if (bad && bad.status === 'rejected') {
    reportRejected(actionLabel(RTYPE), bad.reason);
    throw new Error(bad.reason ?? 'promote refused');
  }
  return node;
}

/** Create an empty compose scene (a `kind: 'compose_scene'` root layer) in the
 *  open project, after the last one. Resolves its id. */
export async function commitComposeSceneCreate(name: string): Promise<string> {
  const projectId = useEditorStore.getState().projectId ?? '';
  const keys = composeScenesNow()
    .map((c) => c.orderKey)
    .filter((k): k is string => typeof k === 'string')
    .sort();
  const last = keys[keys.length - 1];
  const id = crypto.randomUUID();
  await createDoc(RTYPE, {
    id,
    projectId,
    rootComposeSceneId: null,
    cameraNodeId: null,
    parentId: null,
    name,
    kind: 'compose_scene',
    assetId: null,
    config: {},
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    anchorH: 'left',
    anchorV: 'top',
    orderKey: keyBetween(last ?? null, null),
    visible: true,
  } as unknown as ComposeLayerRecord);
  return id;
}
