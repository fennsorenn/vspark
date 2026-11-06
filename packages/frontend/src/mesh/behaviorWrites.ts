/**
 * Behavior writes, straight on the mesh (see ./docs).
 *
 * Attaching, reconfiguring or detaching a behavior instantiates or tears down
 * its signal graph. That side effect lives in the backend's persistence tap
 * (behaviors/refresh.ts), so it runs whoever wrote the document. The tab
 * authors the writes so they land on its undo stack; the REST endpoints stay
 * for outside services.
 */
import { createDoc, patchDoc, removeDoc, setField } from './docs';
import type { Behavior } from '../store/editorStore';

const RTYPE = 'behavior';

export const commitBehaviorPath = (
  id: string,
  path: string,
  value: unknown
): void => void setField(RTYPE, id, path, value);

export const commitBehaviorPatch = (
  id: string,
  patch: Partial<Behavior>
): void => void patchDoc(RTYPE, id, patch);

export const commitBehaviorDelete = (id: string): Promise<boolean> =>
  removeDoc(RTYPE, id);

/** Attach a behavior to a node. */
export function commitBehaviorCreate(
  nodeId: string,
  spec: {
    id?: string;
    kind: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }
): Promise<Behavior> {
  return createDoc<Behavior>(RTYPE, {
    id: spec.id ?? crypto.randomUUID(),
    nodeId,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    config: spec.config ?? {},
  });
}
