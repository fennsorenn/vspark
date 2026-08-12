import i18n from 'i18next';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { commitNodePath } from '../../mesh/writes';
import { isWritableRemoteNode } from '../../sync/remoteEdit';
import {
  createSceneNode,
  createNodeFromModelAsset,
  createBillboardFromImageAsset,
  nextNodeName,
  type NodeKindDef,
} from './createKinds';

/** True if the drag carries OS files (an image dropped from the desktop). */
export function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** Handle an OS image-file drop onto the 3D viewport: upload each image and add
 *  it to the scene as a billboard node (textured with the upload). Returns true
 *  if it consumed the drop. Non-image files are ignored. */
export async function handleSceneFileDrop(
  e: React.DragEvent,
  sceneId: string | null
): Promise<boolean> {
  if (!sceneId) return false;
  const store = useEditorStore.getState();
  const projectId = store.projectId;
  if (!projectId) return false;
  const files = Array.from(e.dataTransfer.files).filter((f) =>
    f.type.startsWith('image/')
  );
  if (files.length === 0) return false;
  e.preventDefault();
  let lastId: string | null = null;
  for (const file of files) {
    try {
      const asset = await api.uploadAsset(projectId, file);
      store.addAsset(asset);
      const node = await createBillboardFromImageAsset(asset, sceneId, null);
      lastId = node.id;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to upload image');
    }
  }
  if (lastId) {
    store.selectNode(lastId);
    store.setSceneSelected(false);
  }
  return true;
}

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

/** Where, relative to a tree row, a drag is hovering. `before` / `after` place
 *  the dragged item as a *sibling* at that position; `inside` nests it as a
 *  *child*. Shared by the stage tree (SceneGraph) and the compose tree so both
 *  trees read identically: hover the upper/lower edge to position between rows,
 *  hover the middle to drop into the row. */
export type DropZone = 'before' | 'inside' | 'after';

/** Classify a drag over a row into before / inside / after from the cursor's
 *  vertical position. The middle ~44% band nests (inside); the top/bottom
 *  ~28% bands position as a sibling. Pass `allowInside = false` for rows that
 *  can't hold children — it collapses to a before/after split at the midpoint. */
export function dropZoneFromEvent(
  e: React.DragEvent,
  allowInside = true
): DropZone {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const frac = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  if (!allowInside) return frac < 0.5 ? 'before' : 'after';
  if (frac < 0.28) return 'before';
  if (frac > 0.72) return 'after';
  return 'inside';
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

    // Phase 6: a shared object is owned by a remote peer that can't resolve our
    // local `/uploads` URL — and asset transfer to the owner is out of v1 scope
    // (scene_node documents only). Block asset drops onto a writable-remote
    // parent cleanly instead of creating a local orphan that never reaches the
    // owner. (Plain asset-less node kinds still route via createSceneNode.)
    const dropTarget = parentId
      ? store.nodes.find((n) => n.id === parentId)
      : null;
    if (dropTarget && isWritableRemoteNode(dropTarget)) {
      alert(i18n.t('sceneGraph:remote.assetBlocked'));
      return true;
    }

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
        commitNodePath(target.id, 'components', components);
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
