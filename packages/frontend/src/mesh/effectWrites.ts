/**
 * Camera-effect writes on the mesh.
 *
 * The simplest of the document types, and so the pattern-setter for the rest:
 * flat (no hierarchy, so no subtree delete), a fixed field set, and a create
 * route that already accepts a client-supplied id.
 *
 * The point of authoring here rather than calling REST is undo. A REST write is
 * authored by the SERVER, so it lands on no peer's undo stack — which is why
 * adding a bloom effect, or toggling one off, has never been undoable. The
 * REST endpoints stay for outside services (principle 5); they simply are not
 * how this tab writes any more.
 */
import {
  commitDocCreate,
  commitDocDelete,
  commitDocPatch,
  commitDocPath,
  type MeshDocAdapter,
} from './writes';
import { useEditorStore } from '../store/editorStore';
import { api, type CameraEffectRecord } from '../api/client';

const effects: MeshDocAdapter<CameraEffectRecord> = {
  rtype: 'camera_effect',
  list: () => useEditorStore.getState().cameraEffects,
  applyLocal: (id, patch) =>
    useEditorStore.getState().updateCameraEffect(id, patch),
  addLocal: (doc) => useEditorStore.getState().addCameraEffect(doc),
  removeLocal: (id) => useEditorStore.getState().removeCameraEffect(id),
  restUpdate: (id, patch) => api.updateCameraEffect(id, patch),
  restDelete: (id) => api.deleteCameraEffect(id),
  // Flat: an effect owns nothing, so a delete is never a subtree delete and
  // nothing ever reparents.
  childrenOf: () => [],
  parentPatch: () => ({}),
};

export const commitEffectPath = (
  id: string,
  path: string,
  value: unknown
): void => commitDocPath(effects, id, path, value);

export const commitEffectPatch = (
  id: string,
  patch: Partial<CameraEffectRecord>
): void => commitDocPatch(effects, id, patch);

export const commitEffectDelete = (id: string): Promise<boolean> =>
  commitDocDelete(effects, id);

/** Attach an effect to a node. The id is minted here so the create is authored
 *  by this tab and lands on its undo stack; the backend re-derives nothing it
 *  is not given, and the route accepts the id we supply. */
export function commitEffectCreate(
  nodeId: string,
  spec: {
    id?: string;
    kind: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }
): Promise<CameraEffectRecord> {
  const doc: CameraEffectRecord = {
    id: spec.id ?? crypto.randomUUID(),
    nodeId,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    config: spec.config ?? {},
  };
  return commitDocCreate(effects, doc, () =>
    api.createCameraEffect(nodeId, {
      id: doc.id,
      kind: doc.kind,
      enabled: doc.enabled,
      config: doc.config,
    })
  );
}
