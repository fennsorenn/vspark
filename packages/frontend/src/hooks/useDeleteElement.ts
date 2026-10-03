import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../store/editorStore';
import { useConfirm, useChoose } from '../components/DialogProvider';
import {
  commitNodeDelete,
  commitNodeDeleteKeepChildren,
} from '../mesh/writes';
import {
  commitLayerDelete,
  commitLayerDeleteKeepChildren,
} from '../mesh/layerWrites';

/**
 * Shared "delete this element" flow used by the scene tree, the compose tree and
 * the global Delete-key handler. A leaf is a simple confirm; an element with
 * nested children offers delete-with / delete-without (reparent) / cancel so
 * content is never silently abandoned. Reads store state fresh on each call, so
 * it works from a plain keydown callback as well as from a tree row.
 */
export function useDeleteElement() {
  const { t } = useTranslation(['compose', 'sceneGraph', 'common']);
  const confirm = useConfirm();
  const choose = useChoose();

  const deleteComposeLayer = useCallback(
    async (id: string) => {
      const store = useEditorStore.getState();
      const layer = store.composeLayers.find((l) => l.id === id);
      if (!layer) return;
      const childrenOf = (pid: string) =>
        store.composeLayers.filter((l) => l.parentId === pid);
      const directChildren = childrenOf(id);

      if (directChildren.length === 0) {
        if (
          !(await confirm({
            message: t('compose:tree.deleteLayerConfirm', { name: layer.name }),
            danger: true,
          }))
        )
          return;
        await commitLayerDelete(id);
        return;
      }

      const choice = await choose({
        title: t('compose:tree.deleteBranchTitle', { name: layer.name }),
        message: t('compose:tree.deleteBranchMsg', {
          count: directChildren.length,
        }),
        choices: [
          {
            value: 'with',
            label: t('compose:tree.deleteWithChildren'),
            danger: true,
          },
          { value: 'without', label: t('compose:tree.deleteKeepChildren') },
        ],
      });
      if (!choice) return;

      if (choice === 'with') {
        // Subtree removed explicitly, children before parents, as one action.
        await commitLayerDelete(id);
      } else {
        await commitLayerDeleteKeepChildren(id, layer.parentId ?? null);
      }
    },
    [confirm, choose, t]
  );

  const deleteSceneNode = useCallback(
    async (id: string) => {
      const store = useEditorStore.getState();
      const node = store.nodes.find((n) => n.id === id);
      if (!node) return;
      const childrenOf = (pid: string) =>
        store.nodes.filter((n) => n.parentId === pid);
      const directChildren = childrenOf(id);

      try {
        if (directChildren.length === 0) {
          if (
            !(await confirm({
              message: t('sceneGraph:nodes.confirmDelete', { name: node.name }),
              confirmLabel: t('common:actions.delete'),
              danger: true,
            }))
          )
            return;
          await commitNodeDelete(id);
          return;
        }

        const choice = await choose({
          title: t('sceneGraph:nodes.deleteBranchTitle', { name: node.name }),
          message: t('sceneGraph:nodes.deleteBranchMsg', {
            count: directChildren.length,
          }),
          choices: [
            {
              value: 'with',
              label: t('sceneGraph:nodes.deleteWithChildren'),
              danger: true,
            },
            {
              value: 'without',
              label: t('sceneGraph:nodes.deleteKeepChildren'),
            },
          ],
        });
        if (!choice) return;

        if (choice === 'with') {
          // Removes the subtree explicitly (deepest first) as one undo action —
          // see mesh/writes.ts on why the FK cascade alone isn't enough.
          await commitNodeDelete(id);
        } else {
          // Detach the children onto this node's parent, then remove it — also
          // one undo action, so the reparents don't unwind separately.
          await commitNodeDeleteKeepChildren(id, node.parentId ?? null);
        }
      } catch (e: unknown) {
        alert(
          e instanceof Error ? e.message : t('sceneGraph:nodes.failDelete')
        );
      }
    },
    [confirm, choose, t]
  );

  /** Delete whichever element is currently selected (compose layer takes
   *  precedence over a scene node, matching the copy/paste precedence). Returns
   *  true if something was targeted. */
  const deleteSelected = useCallback(async (): Promise<boolean> => {
    const state = useEditorStore.getState();
    if (state.selectedComposeLayerId) {
      await deleteComposeLayer(state.selectedComposeLayerId);
      return true;
    }
    if (state.selectedNodeId) {
      await deleteSceneNode(state.selectedNodeId);
      return true;
    }
    return false;
  }, [deleteComposeLayer, deleteSceneNode]);

  return { deleteComposeLayer, deleteSceneNode, deleteSelected };
}
