/**
 * Compose-layer writes on the mesh.
 *
 * The generic half lives in {@link ./writes} — fallback ladder, merge-patch
 * rebuild, batched bottom-up subtree delete. This file supplies only what is
 * specific to compose layers.
 *
 * Two things differ from scene nodes:
 *
 *   - **Sibling order is a fractional key.** A move writes ONE layer's
 *     `orderKey`, generated strictly between its new neighbours, so concurrent
 *     moves by two peers commute. {@link orderKeyForIndex} is the one place
 *     that computes it.
 *   - **A compose scene is itself a compose_layer row.** Deleting one is a
 *     subtree delete, exactly like deleting a node with children, and the store
 *     keeps scenes and layers in separate slices — hence the `kind` check when
 *     removing locally.
 *
 * Compose layers are never owner-authoritative projections (Phase 6 covers
 * scene nodes only), so there is no `isRemote`.
 */
import { keyBetween } from '@vspark/shared/fracIndex';
import { getMeshHandles, meshBatch } from './peer';
import {
  commitDocCreate,
  commitDocDelete,
  commitDocDeleteKeepChildren,
  commitDocPatch,
  commitDocPath,
  previewDocPath,
  type MeshDocAdapter,
} from './writes';
import { useEditorStore, type StageObject } from '../store/editorStore';
import { api, type ComposeLayerRecord } from '../api/client';

/** Scenes and layers are one rtype but two store slices. */
const all = (): ComposeLayerRecord[] => {
  const s = useEditorStore.getState();
  return [...s.composeScenes, ...s.composeLayers];
};

const isScene = (id: string): boolean =>
  useEditorStore.getState().composeScenes.some((s) => s.id === id);

const layers: MeshDocAdapter<ComposeLayerRecord> = {
  rtype: 'compose_layer',
  list: all,
  applyLocal: (id, patch) =>
    useEditorStore.getState().updateComposeLayerLocal(id, patch),
  addLocal: (doc) => {
    const s = useEditorStore.getState();
    if (doc.kind === 'compose_scene') s.addComposeScene(doc);
    else s.addComposeLayer(doc);
  },
  removeLocal: (id) => {
    const s = useEditorStore.getState();
    if (isScene(id)) s.removeComposeScene(id);
    else s.removeComposeLayer(id);
  },
  restUpdate: (id, patch) => api.updateComposeLayer(id, patch),
  restDelete: (id) => api.deleteComposeLayer(id),
  childrenOf: (id) => all().filter((l) => (l.parentId ?? null) === id),
  parentPatch: (parentId) => ({ parentId }),
};

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

export const previewLayerPath = (
  id: string,
  path: string,
  value: unknown
): void => previewDocPath(layers, id, path, value);

export const commitLayerPath = (
  id: string,
  path: string,
  value: unknown
): void => commitDocPath(layers, id, path, value);

export const commitLayerPatch = (
  id: string,
  patch: Partial<ComposeLayerRecord>
): void => commitDocPatch(layers, id, patch);

/** Delete a layer and everything under it as ONE undo action. A compose scene
 *  is just a layer with children, so this covers deleting a whole scene. */
export const commitLayerDelete = (id: string): Promise<boolean> =>
  commitDocDelete(layers, id);

/** Detach a layer's direct children onto `newParentId`, then delete it — one
 *  undo action, so the reparents don't unwind separately. */
export const commitLayerDeleteKeepChildren = (
  id: string,
  newParentId: string | null
): Promise<boolean> => commitDocDeleteKeepChildren(layers, id, newParentId);

/** Create a layer. The id is minted here so the create is authored by this tab
 *  and lands on its undo stack; the backend re-derives `projectId`. A new layer
 *  goes to the FRONT of its sibling group. */
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

  return commitDocCreate(
    layers,
    doc,
    // The route accepts a client-supplied id, so the fallback keeps the same
    // one and the caller's reference stays valid either way.
    () =>
      api.createComposeSceneLayer(composeSceneId, {
        ...spec,
        id: doc.id,
        orderKey: doc.orderKey,
        kind: doc.kind as ComposeLayerRecord['kind'],
      }) as Promise<ComposeLayerRecord>
  );
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
 *
 * Falls back to sequential REST calls (not undoable) when the peer can't
 * author, matching every other helper here.
 */
export async function commitPromoteLayerToNode(
  node: StageObject,
  layerId: string
): Promise<StageObject> {
  const h = getMeshHandles();
  const nodeCol = h?.collections.scene_node;
  const layerCol = h?.collections.compose_layer;
  const subtree = [
    ...all().filter((l) => (l.parentId ?? null) === layerId),
  ].reverse();

  if (nodeCol?.canWrite() && layerCol?.canWrite() && layerCol.get(layerId)) {
    const acks = meshBatch(() => [
      nodeCol.set(node.id, '', node).ack,
      ...subtree.map((l) => layerCol.remove(l.id).ack),
      layerCol.remove(layerId).ack,
    ]);
    const outcomes = await Promise.all(acks);
    const bad = outcomes.find((o) => o.status === 'rejected');
    if (bad) throw new Error(bad.reason ?? 'promote refused');
    return node;
  }

  const created = (await api.createNode(node.rootSceneNodeId, {
    name: node.name,
    kind: node.kind,
    parentId: node.parentId,
    filePath: node.filePath,
    components: node.components,
    properties: node.properties,
    hidden: false,
  })) as StageObject;
  const s = useEditorStore.getState();
  if (s.nodes.every((n) => n.id !== created.id)) s.addNode(created);
  await commitLayerDelete(layerId);
  return created;
}
