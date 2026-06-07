/**
 * Client resource bindings for the unified sync layer.
 *
 * Importing this module registers each resource's `apply` (rtype → store slice)
 * via {@link bindResource}. Imported for side effects by `useWsSync`.
 *
 * Phase 1: the five CRUD document types, create + delete. The server sends
 * canonical camelCase DTOs (the same shape `getScenes` produces), so bindings
 * store them directly — no per-message mapper. `upsert` dedupes by id so the
 * initiating client (which already added the entity from its REST response)
 * doesn't double-insert. Smoothing-sensitive *updates* (compose-layer commits,
 * node transforms) still ride their legacy messages until Phase 2.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { bindResource } from './registry';
import {
  useEditorStore,
  type NodeRecord,
  type Behavior,
} from '../store/editorStore';
import type {
  CameraEffectRecord,
  ComposeLayerRecord,
  TrackClipRecord,
} from '../api/client';

bindResource('scene_node', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.deleteNode(key);
      return;
    }
    const node = data as NodeRecord;
    if (s.nodes.some((n) => n.id === node.id)) s.updateNode(node.id, node);
    else s.addNode(node);
  },
});

bindResource('behavior', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.removeBehavior(key);
      return;
    }
    const b = data as Behavior;
    if (s.behaviors.every((x) => x.id !== b.id)) s.addBehavior(b);
  },
});

bindResource('camera_effect', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.removeCameraEffect(key);
      return;
    }
    const e = data as CameraEffectRecord;
    if (s.cameraEffects.some((x) => x.id === e.id))
      s.updateCameraEffect(e.id, { enabled: e.enabled, config: e.config });
    else s.addCameraEffect(e);
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
    // addComposeScene/addComposeLayer dedupe by id internally.
    const layer = data as ComposeLayerRecord;
    if (layer.kind === 'compose_scene') s.addComposeScene(layer);
    else s.addComposeLayer(layer);
  },
});

bindResource('track_clip', {
  apply: (op, key, data) => {
    const s = useEditorStore.getState();
    if (op === 'remove') {
      s.removeTrackClip(key);
      return;
    }
    // addTrackClip dedupes by id internally.
    s.addTrackClip(data as TrackClipRecord);
  },
});
