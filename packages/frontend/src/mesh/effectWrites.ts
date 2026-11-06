/**
 * Camera-effect writes, straight on the mesh (see ./docs).
 *
 * The tab authors them so they land on its undo stack: adding a bloom effect,
 * or toggling one off, is undoable. The REST endpoints stay for outside
 * services (principle 5); they are not how this tab writes.
 */
import { createDoc, patchDoc, removeDoc, setField } from './docs';
import type { CameraEffectRecord } from '../api/client';

const RTYPE = 'camera_effect';

export const commitEffectPath = (
  id: string,
  path: string,
  value: unknown
): void => void setField(RTYPE, id, path, value);

export const commitEffectPatch = (
  id: string,
  patch: Partial<CameraEffectRecord>
): void => void patchDoc(RTYPE, id, patch);

export const commitEffectDelete = (id: string): Promise<boolean> =>
  removeDoc(RTYPE, id);

/** Attach an effect to a node. */
export function commitEffectCreate(
  nodeId: string,
  spec: {
    id?: string;
    kind: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }
): Promise<CameraEffectRecord> {
  return createDoc<CameraEffectRecord>(RTYPE, {
    id: spec.id ?? crypto.randomUUID(),
    nodeId,
    kind: spec.kind,
    enabled: spec.enabled !== false,
    config: spec.config ?? {},
  });
}
