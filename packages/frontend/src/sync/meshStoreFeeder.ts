/**
 * Mesh → editorStore feeder (§11 frontend bindings, reads-first).
 *
 * Feeds the editorStore's synced slices from the tab's mesh replica,
 * replacing the legacy 'sync'-envelope bindings rtype by rtype (the
 * migrated rtypes are removed from ./resources). The mesh replica already
 * does HLC LWW internally, so observe() only ever fires for applied
 * changes — no client-side stale-drop needed.
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
import { useEditorStore, type Behavior } from '../store/editorStore';
import type { CameraEffectRecord } from '../api/client';

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
    })
    .catch((err) => console.warn('[mesh] store feeder init failed:', err));
}
