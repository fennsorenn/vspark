import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import {
  createSceneNode,
  createNodeFromModelAsset,
  createNodeFromLive2dAsset,
  createBillboardFromImageAsset,
  nextNodeName,
  type NodeKindDef,
} from './createKinds';

// MIME types used to drag-create entities from the bottom dock onto the scene
// tree / compose tree / viewport. Custom types so they never collide with the
// existing internal scene-tree reparent drag (`text/compose-layer`, etc.).
export const DND_CREATE_NODE = 'application/x-vspark-create-node';
export const DND_CREATE_LAYER = 'application/x-vspark-create-layer';
export const DND_ASSET = 'application/x-vspark-asset';

/** True if the drag carries any of our create payloads. */
export function hasCreatePayload(e: React.DragEvent): boolean {
  const t = e.dataTransfer.types;
  return (
    t.includes(DND_CREATE_NODE) ||
    t.includes(DND_CREATE_LAYER) ||
    t.includes(DND_ASSET)
  );
}

/** Handle a drop that creates a scene node — either a Create-palette node tile
 *  (`DND_CREATE_NODE`) or an asset tile (`DND_ASSET`). Returns true if it
 *  consumed the drop. `parentId` nests the new node (null = scene root).
 *  Selects + focus-renames freshly created nodes. */
export async function handleSceneNodeDrop(
  e: React.DragEvent,
  sceneId: string | null,
  parentId: string | null
): Promise<boolean> {
  if (!sceneId) return false;
  const store = useEditorStore.getState();

  const defJson = e.dataTransfer.getData(DND_CREATE_NODE);
  if (defJson) {
    try {
      const def = JSON.parse(defJson) as NodeKindDef;
      const node = await createSceneNode(
        sceneId,
        def,
        parentId,
        nextNodeName(def, sceneId)
      );
      store.selectNode(node.id);
      store.setSceneSelected(false);
      store.requestFocusName();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create node');
    }
    return true;
  }

  const assetId = e.dataTransfer.getData(DND_ASSET);
  if (assetId) {
    const asset = store.assets.find((a) => a.id === assetId);
    if (!asset) return true;

    // Animations aren't standalone nodes — they only make sense applied to an
    // avatar/model. Accept the drop only when it lands on such a node and set
    // its idle animation; ignore drops on the scene root, viewport, or any
    // other node kind.
    if (asset.kind === 'animation') {
      const target = parentId
        ? store.nodes.find((n) => n.id === parentId)
        : null;
      if (!target || (target.kind !== 'avatar' && target.kind !== 'model')) {
        return true; // consumed, but no node created
      }
      const components = {
        ...target.components,
        animation: { idleUrl: asset.url },
      };
      try {
        await api.updateNode(target.id, { components });
        store.updateNode(target.id, { components });
        store.selectNode(target.id);
        store.setSceneSelected(false);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to set animation');
      }
      return true;
    }

    try {
      const node =
        asset.kind === 'image'
          ? await createBillboardFromImageAsset(asset, sceneId, parentId)
          : asset.kind === 'live2d'
            ? await createNodeFromLive2dAsset(asset, sceneId, parentId)
            : await createNodeFromModelAsset(asset, sceneId, parentId);
      store.selectNode(node.id);
      store.setSceneSelected(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add asset');
    }
    return true;
  }

  return false;
}
