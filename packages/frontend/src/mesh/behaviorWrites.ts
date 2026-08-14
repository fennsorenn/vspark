/**
 * Behavior writes on the mesh.
 *
 * Structurally identical to camera effects — flat, node-owned, fixed field set —
 * but with a side effect behind it: attaching, reconfiguring or detaching a
 * behavior instantiates or tears down its signal graph. That side effect now
 * lives in the backend's `onCommitted` tap rather than the REST routes
 * (behaviors/refresh.ts), which is what makes authoring here safe. Before that
 * move, a behavior written on the mesh would have persisted and replicated
 * while its graph never started.
 *
 * As everywhere else, the REST endpoints stay for outside services; this is
 * just how the tab writes, and it is what makes behavior edits undoable.
 */
import {
  commitDocCreate,
  commitDocDelete,
  commitDocPatch,
  commitDocPath,
  type MeshDocAdapter,
} from './writes';
import { useEditorStore, type Behavior } from '../store/editorStore';
import { api } from '../api/client';

const behaviors: MeshDocAdapter<Behavior> = {
  rtype: 'behavior',
  list: () => useEditorStore.getState().behaviors,
  applyLocal: (id, patch) =>
    useEditorStore.getState().updateBehavior(id, patch),
  addLocal: (doc) => useEditorStore.getState().addBehavior(doc),
  removeLocal: (id) => useEditorStore.getState().removeBehavior(id),
  restUpdate: (id, patch) => api.updateBehavior(id, patch),
  restDelete: (id) => api.deleteBehavior(id),
  childrenOf: () => [],
  parentPatch: () => ({}),
};

export const commitBehaviorPath = (
  id: string,
  path: string,
  value: unknown
): void => commitDocPath(behaviors, id, path, value);

export const commitBehaviorPatch = (
  id: string,
  patch: Partial<Behavior>
): void => commitDocPatch(behaviors, id, patch);

export const commitBehaviorDelete = (id: string): Promise<boolean> =>
  commitDocDelete(behaviors, id);

/** Attach a behavior to a node. The id is minted here so the create is authored
 *  by this tab and lands on its undo stack. */
export function commitBehaviorCreate(
  nodeId: string,
  spec: {
    id?: string;
    kind: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }
): Promise<Behavior> {
  const doc: Behavior = {
    id: spec.id ?? crypto.randomUUID(),
    nodeId,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    config: spec.config ?? {},
  };
  return commitDocCreate(
    behaviors,
    doc,
    () =>
      api.createBehavior(nodeId, {
        id: doc.id,
        kind: doc.kind,
        enabled: doc.enabled,
        config: doc.config,
      }) as Promise<Behavior>
  );
}
