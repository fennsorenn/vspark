/**
 * Running-graph lifecycle, driven by committed writes rather than by routes.
 *
 * A logic document's `descriptor` IS its program, so committing one has to
 * start, restart or stop the running instance — the same relationship a
 * behavior has with its signal graph, and moved here for the same reason: a
 * graph authored on the mesh (by a tab, an undo, or a collab peer) never passes
 * through a REST route, and would otherwise be persisted and replicated while
 * nothing ran it.
 *
 * Kept apart from logic/manager.ts so the mesh tap can import it without
 * dragging in the manager's route-facing surface, and so the two sides of the
 * lifecycle read as one thing rather than as two hooks buried in a tap.
 */
import { logicManager } from './manager.js';

export const logicLifecycle = {
  /** A graph was created or edited: reconcile starts it if enabled, stops it if
   *  not, and restarts it when the descriptor changed under a running one. */
  onCommitted(id: string): void {
    logicManager.reconcile(id);
  },

  /** A graph was deleted. Its row is already gone by the time the tap runs, so
   *  reconcile finds nothing and stops the instance — which is exactly the
   *  wanted behaviour, and why this does not need its own stop call. */
  onRemoved(id: string): void {
    logicManager.reconcile(id);
  },
};
