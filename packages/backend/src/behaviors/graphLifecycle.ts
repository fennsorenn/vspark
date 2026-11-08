/**
 * Behavior graph lifecycle — keeps a Behavior's STORED graph in step with the
 * behavior (plan: dev-notes/plans/actions.md Phase 4; module:
 * dev-notes/modules/component-managers.md → "Stored, editable graphs").
 * Mirrors actions/lifecycle.ts; the differences are noted.
 *
 * A Behavior owns one `logic` document (ownerKind 'behavior', created under
 * its runtime graph id, e.g. `vmc-pipeline:<behaviorId>`). The graph is
 * generated from the kind's template (behaviors/templates.ts) and stays
 * editable; `templateFingerprint` on the behavior records which template output
 * the graph was generated from. Its MANAGER runs it (not LogicManager): the
 * managers feed live data into the graphs (UDP, landmarks, interceptors).
 *
 * What a committed behavior write does (driven from the mesh tap, so it holds
 * for REST, tabs, undo and collab peers alike):
 *   - no graph yet (a new behavior, or one whose graph went missing) → the
 *     template graph is written and the fingerprint set. Unlike Actions, the
 *     server writes it: behaviors are created from many places (add menu, REST,
 *     presets, MCP, collab peers), and the editor has no template code. The
 *     derived graph id makes two writers converge on one document. DEFERRED
 *     to the next macrotask (`ensureGraph`): undoing a behavior delete restores
 *     the behavior and then its (maybe hand-edited) graph in one batch, and a
 *     template graph written in between could out-stamp the restored one. The
 *     manager runs the template meanwhile, so the delay costs nothing.
 *   - value-setting change → nothing here: `settings` nodes read the config
 *     live through the manager.
 *   - shape-setting change → an UNMODIFIED graph is rebuilt and the
 *     fingerprint follows; a MODIFIED one is kept and reads "template update
 *     available" (no kind has a shape setting today — see templates.ts).
 *   - then the managers re-sync (the binding's refresh, as before).
 *
 * What a committed graph write does: the owning behavior's manager rebuilds
 * its running graph (`onGraphCommitted` → refresh → `programChanged`).
 *
 * Boot (`bootSync`, before the managers' first sync): missing graphs are
 * created, unmodified graphs whose template output changed are regenerated,
 * modified ones are left alone.
 */
import type { WriteHandle } from '@vspark/mesh';
import { graphFingerprint } from '@vspark/shared/actions';
import {
  toDescriptorDoc,
  type GraphDescriptorDoc,
} from '@vspark/shared/signal';
import { getMeshCollection } from '../mesh/index.js';
import { refreshAllBehaviorManagers } from './refresh.js';
import {
  behaviorGraphId,
  behaviorTemplate,
  behaviorTemplateFingerprint,
  behaviorTemplateGraph,
} from './templates.js';

type Dto = Record<string, unknown>;

export interface BehaviorDoc {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
  templateFingerprint?: string | null;
}

export interface BehaviorGraphStatus {
  /** The behavior's graph document id (null when missing). */
  graphId: string | null;
  /** No graph is stored (the manager runs the template; Reset creates it). */
  missingGraph: boolean;
  /** The graph differs from the template output it was generated from. */
  modified: boolean;
  /** The template now produces something else than what the graph was
   *  generated from (template code changed, or a shape edit kept off a
   *  modified graph). */
  templateUpdateAvailable: boolean;
}

const behaviorsCol = () => getMeshCollection('behavior');
const logicCol = () => getMeshCollection('logic');

/** The graph document a behavior owns (from the replica), if any. Looked up
 *  by ownership; the derived id is only where a new one is created. */
export function graphDocOf(b: { id: string; kind: string }): Dto | undefined {
  const col = logicCol();
  if (!col) return undefined;
  const isOwned = (g: Dto | undefined) =>
    !!g && g.ownerKind === 'behavior' && g.ownerId === b.id;
  const direct = col.get(behaviorGraphId(b.kind, b.id));
  if (isOwned(direct)) return direct;
  return col.all().find(isOwned);
}

/** Write the template output for the behavior's current config as its graph:
 *  replaces the descriptor of the existing graph, or creates the graph. */
function writeGraph(b: BehaviorDoc): WriteHandle | undefined {
  const col = logicCol();
  const tpl = behaviorTemplateGraph(b.kind, b.id, b.config);
  if (!col || !tpl) return undefined;
  const existing = graphDocOf(b);
  const id = (existing?.id as string | undefined) ?? tpl.id;
  const descriptor = toDescriptorDoc({ ...tpl, id });
  if (existing) return col.set(id, 'descriptor', descriptor);
  return col.set(id, '', {
    id,
    ownerKind: 'behavior',
    ownerId: b.id,
    name: tpl.label,
    enabled: true,
    descriptor,
  });
}

function setFingerprint(id: string, fp: string): WriteHandle | undefined {
  const col = behaviorsCol();
  const cur = col?.get(id);
  if (!col || !cur || cur.templateFingerprint === fp) return undefined;
  return col.set(id, 'templateFingerprint', fp);
}

/** Create the graph of a behavior that has none (see the header). Re-reads
 *  the state, so a graph that arrived in the meantime is left alone. */
function ensureGraph(id: string): void {
  const b = behaviorsCol()?.get(id) as unknown as BehaviorDoc | undefined;
  if (!b || !behaviorTemplate(b.kind)) return;
  const target = behaviorTemplateFingerprint(b.kind, b.config)!;
  const graph = graphDocOf(b);
  if (graph) {
    if (
      (b.templateFingerprint ?? null) === null &&
      fingerprintOf(graph) === target
    )
      setFingerprint(id, target);
    return;
  }
  writeGraph(b);
  setFingerprint(id, target);
}

const pendingEnsure = new Set<string>();
function scheduleEnsureGraph(id: string): void {
  if (pendingEnsure.has(id)) return;
  pendingEnsure.add(id);
  setTimeout(() => {
    pendingEnsure.delete(id);
    try {
      ensureGraph(id);
    } catch (e) {
      console.error(`[Behaviors] creating the graph of ${id} failed:`, e);
    }
  }, 0);
}

const fingerprintOf = (g: Dto): string =>
  graphFingerprint(g.descriptor as GraphDescriptorDoc);

/** Derived graph state (REST read model; the editor computes the same). */
export function behaviorGraphStatus(b: BehaviorDoc): BehaviorGraphStatus {
  const graph = graphDocOf(b);
  const generated = b.templateFingerprint ?? null;
  const target = behaviorTemplateFingerprint(b.kind, b.config);
  return {
    graphId: (graph?.id as string | undefined) ?? null,
    missingGraph: !graph,
    modified: !!graph && fingerprintOf(graph) !== generated,
    templateUpdateAvailable: generated !== target,
  };
}

export const behaviorGraphLifecycle = {
  /** A committed behavior write (see the header). Never throws: a failing
   *  side effect must not nack the behavior edit. Runs before the managers
   *  re-sync, so they start from the stored graph. */
  onCommitted(doc: Dto, prev: Dto | undefined): void {
    try {
      const b = doc as unknown as BehaviorDoc;
      if (!behaviorTemplate(b.kind)) return; // no graph (api_controller)
      const target = behaviorTemplateFingerprint(b.kind, b.config)!;
      const graph = graphDocOf(b);
      if (!graph) {
        scheduleEnsureGraph(b.id);
        return;
      }
      const current = fingerprintOf(graph);
      const generated = b.templateFingerprint ?? null;
      if (generated === null) {
        // A graph arrived without its fingerprint (a collab peer's, or a
        // writer that does not know it): only an exact template match can be
        // vouched for; anything else stays "modified".
        if (current === target) setFingerprint(b.id, target);
        return;
      }
      if (!prev) return;
      // Shape follow (same rules as Actions): only when the template output
      // moved away from what the graph was generated from.
      const prevFp = (prev.templateFingerprint as string | null) ?? null;
      if (target === prevFp) return; // value-only change
      if (current === target) {
        setFingerprint(b.id, target); // the writer already rebuilt it
        return;
      }
      if (current !== prevFp) return; // modified: keep the user's edits
      writeGraph(b);
      setFingerprint(b.id, target);
    } catch (e) {
      console.error(
        `[Behaviors] graph lifecycle failed for ${String(doc.id)}:`,
        e
      );
    }
  },

  /** Create the graph now if the behavior has none (the REST create, so its
   *  caller can read the graph back as soon as the request returns). */
  ensureGraph(id: string): void {
    ensureGraph(id);
  },

  /** A behavior's stored graph was written or removed: its manager rebuilds
   *  the running graph (managers compare structure, so a moved node does not
   *  restart anything). */
  onGraphCommitted(): void {
    refreshAllBehaviorManagers();
  },

  /** Rebuild the graph from the template for the current config, discarding
   *  edits (`POST /api/behaviors/:id/reset-graph`; the editor writes the same
   *  itself so it lands on its undo stack). Creates the graph when missing. */
  async reset(id: string): Promise<boolean> {
    const b = behaviorsCol()?.get(id) as unknown as BehaviorDoc | undefined;
    if (!b || !behaviorTemplate(b.kind)) return false;
    const h = writeGraph(b);
    if (!h) return false;
    const out = await h.ack;
    if (out.status === 'rejected') return false;
    const fp = behaviorTemplateFingerprint(b.kind, b.config);
    if (fp) await setFingerprint(id, fp)?.ack;
    return true;
  },

  /** Boot: create missing graphs; regenerate UNMODIFIED graphs whose
   *  template output changed; leave modified ones alone. Runs after the mesh
   *  hydrated and before the managers' first sync. */
  bootSync(): void {
    const col = behaviorsCol();
    if (!col) return;
    let regenerated = 0;
    for (const raw of col.all()) {
      const b = raw as unknown as BehaviorDoc;
      if (!behaviorTemplate(b.kind)) continue;
      try {
        const target = behaviorTemplateFingerprint(b.kind, b.config)!;
        const graph = graphDocOf(b);
        if (!graph) {
          writeGraph(b);
          setFingerprint(b.id, target);
          regenerated++;
          continue;
        }
        const current = fingerprintOf(graph);
        if (current === target) {
          setFingerprint(b.id, target);
        } else if (current === (b.templateFingerprint ?? null)) {
          writeGraph(b);
          setFingerprint(b.id, target);
          regenerated++;
        }
      } catch (e) {
        console.error(`[Behaviors] boot sync failed for ${b.id}:`, e);
      }
    }
    if (regenerated)
      console.log(`[Behaviors] regenerated ${regenerated} behavior graph(s)`);
  },
};
