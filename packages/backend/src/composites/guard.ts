/**
 * Composite part protection on the server (see @vspark/shared/composites and
 * dev-notes/plans/composites.md).
 *
 * Decided (user, 2026-11-08): a part's container and depth must not change and
 * a part can't be deleted on its own, because the composite's logic may
 * address it; reordering among siblings is allowed, and dissolving the
 * composite lifts both. Moves are refused here for every writer, from the
 * mesh `validate` of the scene-node and compose-layer bindings. Deletes skip
 * `validate`, so their refusal lives in the editor and the REST delete routes
 * (decided, user 2026-11-08: no delete hook in the sync engine).
 */
import {
  compositeMarkerOf,
  owningComposite,
  PART_DELETE_REFUSED,
  PART_MOVE_REFUSED,
  type CompositeRootRtype,
} from '@vspark/shared/composites';

type Dto = Record<string, unknown>;
type Lookup = (id: string) => Dto | undefined;

const ROOT_KEY: Record<CompositeRootRtype, string> = {
  compose_layer: 'rootComposeSceneId',
  scene_node: 'rootSceneNodeId',
};

const parentOf = (d: Dto | undefined): string | null =>
  typeof d?.parentId === 'string' ? d.parentId : null;

/** The composite root that lists `id` as a part, or null. */
export function owningCompositeOf(
  rtype: CompositeRootRtype,
  id: string,
  parentId: string | null,
  get: Lookup
): string | null {
  return owningComposite(
    id,
    parentId,
    (x) => parentOf(get(x)),
    (x) => compositeMarkerOf(rtype, get(x))
  );
}

/** Throws when a write would move a composite part to another container.
 *  `prev` is the document before the write (undefined on a create). */
export function guardPartMove(
  rtype: CompositeRootRtype,
  next: Dto,
  prev: Dto | undefined,
  get: Lookup
): void {
  if (!prev || typeof next.id !== 'string') return;
  const was = parentOf(prev);
  if (was === parentOf(next) && prev[ROOT_KEY[rtype]] === next[ROOT_KEY[rtype]])
    return;
  if (owningCompositeOf(rtype, next.id, was, get))
    throw new Error(PART_MOVE_REFUSED);
}

/** The refusal for deleting a composite part on its own, or null when the
 *  delete may go ahead (not a part, or already gone). */
export function partDeleteRefusal(
  rtype: CompositeRootRtype,
  id: string,
  get: Lookup
): string | null {
  const doc = get(id);
  if (!doc) return null;
  return owningCompositeOf(rtype, id, parentOf(doc), get)
    ? PART_DELETE_REFUSED
    : null;
}

/** HTTP status for a refused write: 409 when it is the composite-part rule
 *  (the caller can fix it by dissolving), 500 for anything else. */
export const refusalStatus = (reason: string | undefined): number =>
  reason === PART_MOVE_REFUSED || reason === PART_DELETE_REFUSED ? 409 : 500;
