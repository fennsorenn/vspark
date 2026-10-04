/**
 * The tab's documents, used like a store: read, create, edit, delete — straight
 * on the mesh collections (plans/mesh-store-surface.md step 3).
 *
 * There is no copy to keep in sync and no REST fallback. A write applies to
 * this tab's replica at once (so every component reading it re-renders), goes
 * to whoever decides it, and is logged on this tab's undo stack. When it is
 * refused it rolls back on its own, and the user is told (see
 * {@link ./writeFeedback}). Components read through the `@vspark/mesh-react`
 * hooks; this module is for the imperative side (event handlers, actions).
 */
import type { Collection, WriteHandle } from '@vspark/mesh';
import { getMeshHandles } from './peer';
import { actionLabel, reportRejected, watch } from './writeFeedback';

type Doc = { id: string };

/** The collection for `rtype`. The peer exists before the app renders. */
export function collectionOf<T extends object = Record<string, unknown>>(
  rtype: string
): Collection<T> {
  const handles = getMeshHandles();
  if (!handles) throw new Error('mesh: the tab peer is not up');
  return handles.peer.collection<T>(rtype);
}

/** One document, or undefined. */
export function readDoc<T extends object>(
  rtype: string,
  id: string
): T | undefined {
  return collectionOf<T>(rtype).get(id);
}

/** Edit one field (a dotted path) — one undo step. */
export function setField(
  rtype: string,
  id: string,
  path: string,
  value: unknown
): WriteHandle | undefined {
  const col = collectionOf(rtype);
  if (!col.get(id)) return undefined;
  const h = col.set(id, path, value);
  watch(h.ack, actionLabel(rtype));
  return h;
}

/** Edit several fields as one op (a merge-patch, flattened to leaves) — one
 *  undo step. Siblings of a nested leaf survive. */
export function patchDoc(
  rtype: string,
  id: string,
  patch: object
): WriteHandle | undefined {
  const col = collectionOf(rtype);
  if (!col.get(id)) return undefined;
  const h = col.update(id, patch);
  watch(h.ack, actionLabel(rtype));
  return h;
}

/** Create a document the caller has built (id included). Resolves once it is
 *  decided; throws, after telling the user, when it is refused. */
export async function createDoc<T extends Doc>(
  rtype: string,
  doc: T
): Promise<T> {
  const outcome = await collectionOf<T>(rtype).create(doc).ack;
  if (outcome.status === 'rejected') {
    reportRejected(actionLabel(rtype), outcome.reason);
    throw new Error(outcome.reason ?? `${rtype} create refused`);
  }
  return doc;
}

/** Delete a document and everything contained in it (child documents, and
 *  the behaviors, effects, clips and graphs hanging off them) as one undo
 *  action. Resolves false when any part was refused. */
export async function removeDoc(rtype: string, id: string): Promise<boolean> {
  const col = collectionOf(rtype);
  if (!col.get(id)) return false;
  const outcomes = await Promise.all(
    getMeshHandles()!
      .peer.removeTree(id)
      .map((h) => h.ack)
  );
  const refused = outcomes.find((o) => o.status === 'rejected');
  if (refused && refused.status === 'rejected')
    reportRejected(actionLabel(rtype), refused.reason);
  return !refused;
}
