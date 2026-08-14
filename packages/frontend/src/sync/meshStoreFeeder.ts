/**
 * Mesh → editorStore feeder (§11 frontend bindings, reads-first).
 *
 * Feeds the editorStore's synced slices from the tab's mesh replica — every
 * document rtype the tab subscribes to (RTYPES in mesh/peer.ts; nine at time
 * of writing); the legacy 'sync'-envelope bindings are retired. The mesh
 * replica already does HLC LWW internally, so observe() only ever fires for
 * applied changes — no client-side stale-drop needed.
 *
 * In-flight gesture values arrive on the mesh 'preview' channel as per-key
 * ephemeral overlays composed over the retained doc, so the CHANNEL is the
 * discriminator — an ephemeral op is a gesture by construction and a retained
 * op is model state (see the compose_layer observer below). The bespoke
 * `compose_layer_preview` / `compose_layer_updated` WS kinds that used to carry
 * that beside the mesh have no producer or consumer left, and node gestures now
 * ride the same channel — including the ones a peer's object-share subscribers
 * see, which read the same overlays through sync/meshProjection. The
 * `node_transform_preview` WS kind that used to carry those is gone.
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
  hasLayerTween,
  hasNodeTween,
  smoothComposeLayer,
  smoothNodeTransform,
} from '../previewSmoother';
import { applyNodePreview, transformFieldsOf } from './nodePreview';
import {
  useEditorStore,
  type Behavior,
  type SceneItem,
  type StageObject,
  type ScheduledAnimation,
  type ClipPlayback,
  type AnimationClipMeta,
} from '../store/editorStore';
import { mapLogic, mapTrackClip } from '../api/client';
import type {
  CameraEffectRecord,
  ComposeLayerRecord,
  RawLogic,
} from '../api/client';

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
        const s = useEditorStore.getState();
        // An ephemeral op IS an in-flight gesture, by construction — that's what
        // the lossy `preview` channel carries, so it tweens. Retained ops (page
        // load, committed edits) are model state and apply directly. The channel
        // is the discriminator; no heuristic, and a cold load can't animate.
        if (c.op === 'ephemeral') {
          const node = c.doc as unknown as StageObject | undefined;
          if (node) applyNodePreview(node.id, node, c.path);
          return;
        }
        if (c.op === 'remove') {
          // A Scene is a scene_nodes row too, but it lives in the `scenes`
          // slice, and tearing one down means dropping its whole subtree and
          // re-picking activeSceneId — which only removeScene does.
          if (s.scenes.some((sc) => sc.id === c.id)) {
            s.removeScene(c.id);
            return;
          }
          // Projected (remote) nodes are owned by the projection feeder
          // (sync/meshProjection.ts) — only local nodes are removed here.
          const existing = s.nodes.find((n) => n.id === c.id);
          if (existing && !existing.remote) s.deleteNode(c.id);
          return;
        }
        const node = c.doc as unknown as StageObject | undefined;
        if (!node) return;
        // Scene roots go to the `scenes` slice, never to `nodes`. The REST
        // bundle deliberately excludes kind==='scene' from `nodes`, so adopting
        // one here left a stray entry behind whenever the mesh snapshot landed
        // after setNodes.
        if (node.kind === 'scene') {
          // Same guard as the node path below, for the same reason: unknown
          // projectId means don't adopt. A MOUNTED scene root carries its
          // author's projectId, so a scene we already hold counts as ours to
          // update — otherwise the author renaming a shared scene would never
          // reach the receiver.
          const known = s.scenes.some((sc) => sc.id === node.id);
          if (!s.projectId) return;
          if (node.projectId !== s.projectId && !known) return;
          const item = {
            id: node.id,
            name: node.name,
            runtimeSettings: (node.properties ?? {}) as SceneItem['runtimeSettings'],
          };
          if (s.scenes.some((sc) => sc.id === node.id))
            s.updateSceneItem(node.id, item);
          else s.setScenes([...s.scenes, item]);
          return;
        }
        const existing = s.nodes.find((n) => n.id === node.id);
        if (existing) {
          // A placed remote-object projection is owned by the projection feeder
          // (sync/sharedProjection.ts) — leave it alone here.
          if (existing.remote) return;
          // Already a local node here → apply the edit by IDENTITY, not by
          // projectId. The document is taken WHOLE, including projectId and
          // rootSceneNodeId: a mounted scene keeps its author's values on every
          // peer now (mesh.md principle 2), so there is nothing local to
          // preserve. This used to rewrite both fields on the way in, which is
          // what made one id mean different things depending on who was asked.
          const committed = transformFieldsOf(node);
          if (committed && hasNodeTween(node.id)) {
            // Mid-gesture: the committed value RETARGETS the running tween so
            // the node glides to its final pose instead of snapping (the
            // preview channel is lossy, so the last frame may never have
            // landed). Apply everything else immediately, but hand the tween
            // back the transform it is animating — writing the committed
            // transform here would snap first and glide from nowhere.
            s.updateNode(node.id, {
              ...node,
              components: {
                ...node.components,
                transform: transformFieldsOf(existing),
              },
            });
            smoothNodeTransform(node.id, committed);
            return;
          }
          s.updateNode(node.id, node);
          return;
        }
        // A node we don't hold yet: adopt it only if it belongs to the open
        // project. Foreign docs (other local projects, and placed projections —
        // which carry the OWNER's projectId and are mirrored by the projection
        // feeder) stay out of the store.
        //
        // Unknown projectId means DON'T adopt, not "adopt anything". The feeder
        // starts on mount while projectId arrives with the async REST load, so
        // there is a real window where it is null — and the old
        // `s.projectId && …` form let every foreign doc through it. Dropping is
        // safe because the REST bundle populates `nodes` immediately after.
        //
        // A node of a MOUNTED scene carries its author's projectId, so ownership
        // alone is not the test any more: a node also belongs here when its
        // scene is one we hold. `scenes` comes from the bundle, which lists our
        // own scenes and the ones mounted into this project.
        if (!s.projectId) return;
        const ours =
          node.projectId === s.projectId ||
          s.scenes.some((sc) => sc.id === node.rootSceneNodeId);
        if (!ours) return;
        s.addNode(node);
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
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          if (s.composeScenes.some((cs) => cs.id === c.id))
            s.removeComposeScene(c.id);
          else s.removeComposeLayer(c.id);
          return;
        }
        const layer = c.doc as unknown as ComposeLayerRecord | undefined;
        if (!layer) return;

        // An ephemeral op IS an in-flight gesture, by construction — that's
        // what the lossy `preview` channel carries. So it tweens, while
        // retained ops (page-load snapshots, committed edits) are model state.
        // The channel is the discriminator; no heuristic needed, and a cold
        // load can't animate every layer in from wherever the store sat.
        if (c.op === 'ephemeral') {
          // `c.doc` is the composed doc (retained + overlays), so read just the
          // field this op touched rather than re-tweening every numeric field
          // toward a value that didn't change.
          const rec = layer as unknown as Record<string, unknown>;
          smoothComposeLayer(
            layer.id,
            c.path ? { [c.path]: rec[c.path] } : rec
          );
          return;
        }

        if (layer.kind === 'compose_scene') {
          if (s.composeScenes.some((cs) => cs.id === layer.id))
            s.updateComposeSceneLocal(layer);
          else s.addComposeScene(layer);
        } else if (s.composeLayers.some((l) => l.id === layer.id)) {
          // Mid-gesture the committed value retargets the running tween so the
          // layer glides into its final position instead of snapping (the
          // preview channel is lossy, so the last frame may never have landed).
          // Outside a gesture it applies immediately.
          if (hasLayerTween(layer.id))
            smoothComposeLayer(
              layer.id,
              layer as unknown as Record<string, unknown>
            );
          else s.updateComposeLayerLocal(layer.id, layer);
        } else {
          s.addComposeLayer(layer);
        }
      });
      h.collections.track_clip.observe('**', (c) => {
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeTrackClip(c.id);
          return;
        }
        // `c.doc` is the clip DOCUMENT: lanes, keyframes and events keyed by
        // id (@vspark/shared/idMap), because each has to be its own mesh path.
        // mapTrackClip is the boundary that turns them into the ordered lists
        // the store and UI work with — a raw cast would hand the timeline a
        // map where it expects an array.
        //
        // A remote edit re-sends the whole doc even when one keyframe moved,
        // so an existing clip must be REPLACED, not skipped.
        const raw = c.doc as unknown as Record<string, unknown> | undefined;
        if (!raw || parentIsRemote(raw.ownerNodeId)) return;
        // An ephemeral op is an in-flight keyframe drag: the composed doc
        // already carries the overlay, so it applies exactly like a committed
        // one. No tweening — a curve editor's dot must sit where the pointer
        // is, not chase it — and no special case beyond skipping the add path,
        // since a clip cannot come into existence on the preview channel.
        const clip = mapTrackClip(raw);
        if (c.op === 'ephemeral') {
          if (s.trackClips.some((x) => x.id === clip.id))
            s.updateTrackClipLocal(clip);
          return;
        }
        if (s.trackClips.some((x) => x.id === clip.id))
          s.updateTrackClipLocal(clip);
        else s.addTrackClip(clip);
      });
      h.collections.scheduled_animation.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeScheduledAnimation(c.id);
          return;
        }
        const e = c.doc as unknown as ScheduledAnimation | undefined;
        if (!e || parentIsRemote(e.avatarNodeId)) return;
        s.upsertScheduledAnimation(e);
      });
      h.collections.logic.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeLogicLocal(c.id);
          return;
        }
        // Same boundary as clips: the document keys the descriptor's nodes and
        // edges by id, the canvas and the engine want lists.
        const g = c.doc as unknown as RawLogic | undefined;
        if (g) s.upsertLogic(mapLogic(g));
      });
      // Every other slice is hydrated by the Editor page's REST load and only
      // takes deltas here; `logic` has no such load, so a subscription snapshot
      // that landed before this observer registered would be lost. Seed from
      // whatever the replica already holds.
      for (const g of h.collections.logic.all())
        useEditorStore
          .getState()
          .upsertLogic(mapLogic(g as unknown as RawLogic));
      h.collections.clip_playback.observe('**', (c) => {
        // No ephemeral branch yet: a scrub rides the preview channel, and the
        // slice below is read through a derivation that reads the doc as-is —
        // so an overlay composes into `c.doc` and needs no special handling.
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeClipPlayback(c.id);
          return;
        }
        const e = c.doc as unknown as ClipPlayback | undefined;
        if (e) s.upsertClipPlayback(e);
      });
      h.collections.animation_clip.observe('**', (c) => {
        if (c.op === 'ephemeral') return;
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          s.removeAnimationClip(c.id);
          return;
        }
        const e = c.doc as unknown as AnimationClipMeta | undefined;
        // Clips ride their source node's subtree; mirror even when that node
        // is a remote projection — the driver only needs id → url + duration,
        // and a scheduled entry on a placed avatar may reference it.
        if (!e) return;
        s.upsertAnimationClip({
          id: e.id,
          sourceNodeId: e.sourceNodeId,
          sourceFilePath: e.sourceFilePath,
          duration: e.duration,
        });
      });
    })
    .catch((err) => console.warn('[mesh] store feeder init failed:', err));
}
