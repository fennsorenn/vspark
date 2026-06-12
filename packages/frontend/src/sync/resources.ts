/**
 * Client resource bindings for the unified sync layer.
 *
 * Importing this module registers each resource's `apply` (rtype → store slice)
 * via {@link bindResource}. Imported for side effects by `useWsSync`.
 *
 * MIGRATION (§11, dev-notes/plans/mesh-sync-refactor.md): rtypes move off
 * these legacy 'sync'-envelope bindings onto the mesh store feeder
 * ({@link ./meshStoreFeeder}) one by one — `behavior` and `camera_effect`
 * already have. The server still emits their envelopes (other consumers may
 * read them), but this tab applies them from its mesh replica instead.
 *
 * The remaining bindings store canonical camelCase DTOs directly — no
 * per-message mapper. `upsert` dedupes by id so the initiating client (which
 * already added the entity from its REST response) doesn't double-insert.
 * Smoothing-sensitive *updates* (compose-layer commits, node transforms)
 * still ride their legacy messages.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { bindResource } from './registry';
import { useEditorStore, type StageObject } from '../store/editorStore';
import type { ComposeLayerRecord, TrackClipRecord } from '../api/client';

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

bindResource('compose_layer', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      if (s.composeScenes.some((cs) => cs.id === key))
        s.removeComposeScene(key);
      else s.removeComposeLayer(key);
      return;
    }
    // Upsert: add/* dedupe by id, so an existing layer must be replaced or a
    // remote edit (move, reorder, rename) is dropped.
    const layer = data as ComposeLayerRecord;
    if (layer.kind === 'compose_scene') {
      if (s.composeScenes.some((cs) => cs.id === layer.id))
        s.updateComposeSceneLocal(layer);
      else s.addComposeScene(layer);
    } else if (s.composeLayers.some((l) => l.id === layer.id)) {
      s.updateComposeLayerLocal(layer.id, layer);
    } else {
      s.addComposeLayer(layer);
    }
  },
});

bindResource('track_clip', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.removeTrackClip(key);
      return;
    }
    // Upsert: a remote edit (new keyframes, rename, lane change …) re-sends the
    // whole clip. addTrackClip dedupes by id, so an existing clip must be
    // *replaced* — otherwise the update (e.g. a freshly added keyframe) is lost.
    const clip = data as TrackClipRecord;
    if (s.trackClips.some((c) => c.id === clip.id))
      s.updateTrackClipLocal(clip);
    else s.addTrackClip(clip);
  },
});
