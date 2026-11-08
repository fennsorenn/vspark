/**
 * Composites on this tab's replica (see @vspark/shared/composites and
 * dev-notes/plans/composites.md): reading a root's marker, the part
 * protection the write helpers apply before a move or delete, dissolving, and
 * issuing a setting's writes as one undo step.
 *
 * Decided (user, 2026-11-08): a part's container and depth don't change and a
 * part isn't deleted on its own until the composite is dissolved. The backend
 * refuses a move for every writer; a delete is refused here and in the REST
 * delete routes, so the delete helpers (writes.ts, layerWrites.ts) ask
 * {@link partDeleteBlocked} first.
 */
import {
  compositeMarkerOf,
  compositeTypeOf,
  dissolveWrite,
  MARKER_PATH,
  owningComposite,
  type CompositeRootRtype,
  type CompositeMarker,
  type CompositeTypeDef,
  type CompositeView,
  type FieldWrite,
  type PartRtype,
} from '@vspark/shared/composites';
import { collectionOf, setField } from './docs';
import { meshBatch } from './peer';
import { pushToast } from '../store/toastStore';
import i18n from '../i18n';

type Doc = Record<string, unknown>;

// ── Markers and protection ─────────────────────────────────────────────────

const docOf = (rtype: string, id: string): Doc | undefined =>
  collectionOf<Doc>(rtype).get(id);

const parentOf = (rtype: string, id: string): string | null => {
  const p = docOf(rtype, id)?.parentId;
  return typeof p === 'string' ? p : null;
};

/** The marker + type definition on a root, or null when it isn't a
 *  composite this build knows. */
export function compositeOf(
  rtype: CompositeRootRtype,
  doc: unknown
): { marker: CompositeMarker; def: CompositeTypeDef } | null {
  const marker = compositeMarkerOf(rtype, doc);
  const def = compositeTypeOf(marker);
  return marker && def ? { marker, def } : null;
}

/** The composite root listing this entity as a part, or null. */
export function owningCompositeId(
  rtype: CompositeRootRtype,
  id: string
): string | null {
  return owningComposite(
    id,
    parentOf(rtype, id),
    (x) => parentOf(rtype, x),
    (x) => compositeMarkerOf(rtype, docOf(rtype, x))
  );
}

const tr = (key: string) => i18n.t(key, { ns: 'composites' }) as string;

/** Whether `id` is a part, which can't leave its place — and if so, tell
 *  the user. For moves that don't go through a parent change (a
 *  cross-scene transfer re-creates the subtree and deletes the original). */
export function refusePartMove(rtype: CompositeRootRtype, id: string): boolean {
  if (!owningCompositeId(rtype, id)) return false;
  pushToast('error', tr('partMoveRefused'));
  return true;
}

/** Whether moving `id` under `newParentId` would take a part out of place —
 *  and if so, tell the user. Reordering (same parent) is always fine. */
export function partMoveBlocked(
  rtype: CompositeRootRtype,
  id: string,
  newParentId: string | null
): boolean {
  if (parentOf(rtype, id) === newParentId) return false;
  return refusePartMove(rtype, id);
}

/** Whether `id` is a part that can't be deleted on its own — and if so,
 *  tell the user. */
export function partDeleteBlocked(
  rtype: CompositeRootRtype,
  id: string
): boolean {
  if (!owningCompositeId(rtype, id)) return false;
  pushToast('error', tr('partDeleteRefused'));
  return true;
}

/** Whether this root is a composite (its marker is set), known type or not. */
export const isCompositeRoot = (
  rtype: CompositeRootRtype,
  id: string
): boolean => compositeMarkerOf(rtype, docOf(rtype, id)) !== null;

/** The marker path, for helpers that drop it inside their own batch. */
export const markerPath = (rtype: CompositeRootRtype): string =>
  MARKER_PATH[rtype];

/** Turn a composite into a plain parent: drop the marker (one undo step). */
export function dissolveComposite(
  rtype: CompositeRootRtype,
  rootId: string
): void {
  const w = dissolveWrite(rtype, rootId);
  setField(w.rtype, w.id, w.path, w.value);
}

// ── Settings ────────────────────────────────────────────────────────────────

/** A view over this tab's replica for the shared settings code. */
export function compositeView(
  rtype: CompositeRootRtype,
  rootId: string,
  marker: CompositeMarker
): CompositeView {
  return {
    rtype,
    rootId,
    marker,
    get: (r: PartRtype, id: string) => docOf(r, id),
  };
}

/** Issue a setting's writes as ONE undo action. */
export function commitSettingWrites(writes: FieldWrite[]): void {
  if (writes.length === 0) return;
  meshBatch(() => {
    for (const w of writes) setField(w.rtype, w.id, w.path, w.value);
  });
}
