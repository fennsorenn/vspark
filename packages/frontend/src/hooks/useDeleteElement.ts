import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../store/editorStore';
import { api } from '../api/client';
import { useConfirm, useChoose } from '../components/DialogProvider';

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
      const delOne = async (lid: string) => {
        store.removeComposeLayer(lid);
        await api.deleteComposeLayer(lid).catch(() => {});
      };

      if (directChildren.length === 0) {
        if (
          !(await confirm({
            message: t('compose:tree.deleteLayerConfirm', { name: layer.name }),
            danger: true,
          }))
        )
          return;
        await delOne(id);
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
        const subtree: string[] = [];
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop()!;
          subtree.push(cur);
          for (const c of childrenOf(cur)) stack.push(c.id);
        }
        for (const sid of subtree.reverse()) await delOne(sid);
      } else {
        for (const c of directChildren) {
          const patch = { parentId: layer.parentId ?? null };
          store.updateComposeLayerLocal(c.id, patch);
          await api.updateComposeLayer(c.id, patch).catch(() => {});
        }
        await delOne(id);
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
          await api.deleteNode(id);
          store.deleteNode(id);
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
          // Backend cascades on parent_id; mirror it in the store so the subtree
          // doesn't linger in the UI until reload.
          const subtree: string[] = [];
          const stack = [id];
          while (stack.length) {
            const cur = stack.pop()!;
            subtree.push(cur);
            for (const c of childrenOf(cur)) stack.push(c.id);
          }
          await api.deleteNode(id);
          for (const sid of subtree) store.deleteNode(sid);
        } else {
          for (const c of directChildren) {
            const patch = { parentId: node.parentId ?? null };
            store.updateNode(c.id, patch);
            await api.updateNode(c.id, patch).catch(() => {});
          }
          await api.deleteNode(id);
          store.deleteNode(id);
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
