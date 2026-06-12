/**
 * Mesh → editorStore feeder (§11 frontend bindings, reads-first).
 *
 * Feeds the editorStore's synced slices from the tab's mesh replica — all
 * five document rtypes; the legacy 'sync'-envelope bindings are retired.
 * The mesh replica already does HLC LWW internally, so observe() only
 * ever fires for applied changes — no client-side stale-drop needed.
 * Smoothing-sensitive patches (node_transform_preview, compose_layer_
 * preview, node_updated) still ride their dedicated /ws messages.
 *
 * Foreign docs: the tab replica also holds behaviors/effects of PLACED
 * remote objects (their subtree subscription is cross-type). Projections
 * are inert — behaviors run only on the owner — so docs whose parent node
 * is a projected remote node are not mirrored. A doc whose node isn't in
 * the store yet is mirrored anyway (a local node arriving over the other
 * transport may simply be late; stray rows are invisible because panels
 * list by selected local node).
 *
 * Started from the Editor AND the Viewer page (both render live state).
 */
import { initMeshPeer } from '../mesh/peer';
import {
  useEditorStore,
  type Behavior,
  type StageObject,
} from '../store/editorStore';
import type { CameraEffectRecord, ComposeLayerRecord, TrackClipRecord } from '../api/client';

let started = false;

function parentIsRemote(nodeId: unknown): boolean {
  if (typeof nodeId !== 'string') return false;
  return (
    useEditorStore.getState().nodes.find((n) => n.id === nodeId)?.remote ===
    true
  );
}

export function startMeshStoreFeeder(): void {
  if (started) return;
  started = true;
  void initMeshPeer()
    .then((h) => {
      h.collections.scene_node.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          // Projected (remote) nodes are owned by the projection feeder
          // (sync/meshProjection.ts) — only local nodes are removed here.
          const existing = s.nodes.find((n) => n.id === c.id);
          if (existing && !existing.remote) s.deleteNode(c.id);
          return;
        }
        const node = c.doc as unknown as StageObject | undefined;
        if (!node) return;
        // Foreign docs (placed projections) carry the OWNER's projectId —
        // the projection feeder mirrors those under their container. Docs of
        // other local projects are skipped too (the legacy envelope used to
        // let them sit invisibly in the store).
        if (s.projectId && node.projectId !== s.projectId) return;
        if (s.nodes.some((n) => n.id === node.id)) s.updateNode(node.id, node);
        else s.addNode(node);
      });
      h.collections.behavior.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeBehavior(c.id);
          return;
        }
        const b = c.doc as unknown as Behavior | undefined;
        if (!b || parentIsRemote(b.nodeId)) return;
        if (s.behaviors.some((x) => x.id === b.id)) s.updateBehavior(b.id, b);
        else s.addBehavior(b);
      });
      h.collections.camera_effect.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeCameraEffect(c.id);
          return;
        }
        const e = c.doc as unknown as CameraEffectRecord | undefined;
        if (!e || parentIsRemote(e.nodeId)) return;
        if (s.cameraEffects.some((x) => x.id === e.id))
          s.updateCameraEffect(e.id, { enabled: e.enabled, config: e.config });
        else s.addCameraEffect(e);
      });
      h.collections.compose_layer.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          if (s.composeScenes.some((cs) => cs.id === c.id))
            s.removeComposeScene(c.id);
          else s.removeComposeLayer(c.id);
          return;
        }
        const layer = c.doc as unknown as ComposeLayerRecord | undefined;
        if (!layer) return;
        if (layer.kind === 'compose_scene') {
          if (s.composeScenes.some((cs) => cs.id === layer.id))
            s.updateComposeSceneLocal(layer);
          else s.addComposeScene(layer);
        } else if (s.composeLayers.some((l) => l.id === layer.id)) {
          s.updateComposeLayerLocal(layer.id, layer);
        } else {
          s.addComposeLayer(layer);
        }
      });
      h.collections.track_clip.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeTrackClip(c.id);
          return;
        }
        // A remote edit (new keyframes, rename, lane change …) re-sends the
        // whole aggregate; an existing clip must be REPLACED, not skipped.
        const clip = c.doc as unknown as TrackClipRecord | undefined;
        if (!clip || parentIsRemote((clip as { ownerNodeId?: unknown }).ownerNodeId))
          return;
        if (s.trackClips.some((x) => x.id === clip.id))
          s.updateTrackClipLocal(clip);
        else s.addTrackClip(clip);
      });
    })
    .catch((err) => console.warn('[mesh] store feeder init failed:', err));
}
