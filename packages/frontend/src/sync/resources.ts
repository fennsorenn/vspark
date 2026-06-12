/**
 * Client resource bindings for the unified sync layer.
 *
 * Importing this module registers each resource's `apply` (rtype → store slice)
 * via {@link bindResource}. Imported for side effects by `useWsSync`.
 *
 * MIGRATION (§11, dev-notes/plans/mesh-sync-refactor.md): rtypes move off
 * these legacy 'sync'-envelope bindings onto the mesh store feeder
 * ({@link ./meshStoreFeeder}) one by one — behavior, camera_effect,
 * compose_layer, and track_clip already have. The server still emits their
 * envelopes (other consumers may read them), but this tab applies them from
 * its mesh replica instead. Only scene_node remains here (its migration is
 * entangled with the Avatar/Viewport pipeline + the placed-object
 * projection feeder — §11 step 4).
 *
 * The binding stores the canonical camelCase DTO directly — no per-message
 * mapper. `upsert` dedupes by id so the initiating client (which already
 * added the entity from its REST response) doesn't double-insert.
 * Smoothing-sensitive *updates* (compose-layer commits, node transforms)
 * still ride their legacy messages.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { bindResource } from './registry';
import { useEditorStore, type StageObject } from '../store/editorStore';

bindResource('scene_node', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.deleteNode(key);
      return;
    }
    const node = data as StageObject;
    if (s.nodes.some((n) => n.id === node.id)) s.updateNode(node.id, node);
    else s.addNode(node);
  },
});
