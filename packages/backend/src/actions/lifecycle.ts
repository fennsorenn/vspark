/**
 * Action lifecycle — keeps an Action's stored Logic graph in step with its
 * settings (plan: dev-notes/plans/actions.md, module: dev-notes/modules/actions.md).
 *
 * An Action owns one `logic` document (owner_kind 'action'). The graph is
 * STORED, generated from the kind's template (`@vspark/shared/actions`), and
 * stays editable; `templateFingerprint` on the action records which template
 * output the graph was generated from.
 *
 * What a committed action write does (driven from the mesh tap, so it holds for
 * REST, tabs, undo alike):
 *   - value-setting change → the running graph gets the new settings in place;
 *     the graph is not touched.
 *   - shape-setting change (the template output differs) → an UNMODIFIED graph
 *     is rebuilt and the fingerprint follows. A MODIFIED graph is kept: only a
 *     writer that confirmed discarding the edits rebuilds it (the editor writes
 *     the rebuilt graph itself, REST callers use reset). Server-side code never
 *     throws user edits away on its own.
 *   - enable toggle → the graph is started / stopped.
 *   - create → nothing here: the creator writes the graph next to the action
 *     (REST create below, the editor in one batch). Boot repairs a missing one.
 *
 * Boot (`bootSync`): unmodified graphs whose template output changed are
 * regenerated; modified ones are left alone and read as "template update
 * available".
 */
import type { WriteHandle } from '@vspark/mesh';
import {
  actionGraphId,
  actionGraphStatus,
  actionKind,
  buildActionGraph,
  graphFingerprint,
  normalizeSettings,
  templateFingerprint,
  type ActionGraphStatus,
} from '@vspark/shared/actions';
import { toDescriptorDoc, type GraphDescriptorDoc } from '@vspark/shared/signal';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { logicManager } from '../logic/manager.js';

type Dto = Record<string, unknown>;

export interface ActionDoc {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  templateFingerprint: string | null;
  createdAt?: string;
}

const actionsCol = () => getMeshCollection('action');
const logicCol = () => getMeshCollection('logic');

const settingsOf = (d: Dto): Record<string, unknown> =>
  d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)
    ? (d.settings as Record<string, unknown>)
    : {};

/** The graph document an action owns (from the replica), if any. Looked up by
 *  ownership; the derived id is only where a new one is created. */
export function graphDocOf(actionId: string): Dto | undefined {
  const col = logicCol();
  if (!col) return undefined;
  const isOwned = (g: Dto | undefined) =>
    !!g && g.ownerKind === 'action' && g.ownerId === actionId;
  const direct = col.get(actionGraphId(actionId));
  if (isOwned(direct)) return direct;
  return col.all().find(isOwned);
}

/** Write the template output for the action's current settings as its graph:
 *  replaces the descriptor of the existing graph, or creates the graph. */
function writeGraph(a: ActionDoc): WriteHandle | undefined {
  const col = logicCol();
  if (!col) return undefined;
  const existing = graphDocOf(a.id);
  const id = (existing?.id as string | undefined) ?? actionGraphId(a.id);
  const descriptor = toDescriptorDoc(
    buildActionGraph(a.kind, a.settings, id, a.name)
  );
  if (existing) return col.set(id, 'descriptor', descriptor);
  return col.set(id, '', {
    id,
    ownerKind: 'action',
    ownerId: a.id,
    name: a.name,
    enabled: true,
    descriptor,
  });
}

function setFingerprint(id: string, fp: string): WriteHandle | undefined {
  const col = actionsCol();
  const cur = col?.get(id);
  if (!col || !cur || cur.templateFingerprint === fp) return undefined;
  return col.set(id, 'templateFingerprint', fp);
}

/** Rebuild the graph on a shape change when it is safe (see header). */
function followShape(a: ActionDoc, prevFp: string | null | undefined): void {
  const graph = graphDocOf(a.id);
  if (!graph) return;
  const target = templateFingerprint(a.kind, a.settings);
  if (target === prevFp) return; // value-only change
  const current = graphFingerprint(graph.descriptor as GraphDescriptorDoc);
  if (current === target) {
    // The writer already wrote the rebuilt graph (the editor does, in the
    // same batch); only the fingerprint may be missing.
    setFingerprint(a.id, target);
    return;
  }
  if (current !== prevFp) return; // modified: keep the user's edits
  writeGraph(a);
  setFingerprint(a.id, target);
}

/** Mesh `validate` for action documents: settings normalized for every
 *  writer; an unknown kind or (from a tab) a project that is not ours is
 *  refused. */
export function guardAction(d: Dto, fromClient: boolean): Dto {
  const kind = String(d.kind ?? '');
  if (!actionKind(kind)) throw new Error(`unknown action kind "${kind}"`);
  if (
    fromClient &&
    !getDb()
      .prepare('SELECT 1 FROM projects WHERE id = ? AND owner_peer_id IS NULL')
      .get(String(d.projectId ?? ''))
  )
    throw new Error('action project not found');
  if (typeof d.name !== 'string' || d.name.trim() === '')
    throw new Error('action name is required');
  return { ...d, settings: normalizeSettings(kind, d.settings) };
}

export const actionLifecycle = {
  /** A committed action write (see the header for what each change does).
   *  Never throws: a failing side effect must not nack the settings edit. */
  onCommitted(doc: Dto, prev: Dto | undefined): void {
    try {
      const a = doc as unknown as ActionDoc;
      logicManager.setActionSettings(a.id, settingsOf(doc));
      if (!prev) {
        logicManager.reconcileOwnedBy('action', a.id);
        return;
      }
      if (Boolean(prev.enabled) !== Boolean(a.enabled))
        logicManager.reconcileOwnedBy('action', a.id);
      followShape(a, prev.templateFingerprint as string | null | undefined);
    } catch (e) {
      console.error(`[Actions] lifecycle failed for ${String(doc.id)}:`, e);
    }
  },

  /** Rebuild the graph from the template for the current settings, discarding
   *  edits (the Reset button / POST /actions/:id/reset). Creates the graph
   *  when it is missing. */
  async reset(id: string): Promise<boolean> {
    const a = actionsCol()?.get(id) as unknown as ActionDoc | undefined;
    if (!a) return false;
    const h = writeGraph(a);
    if (!h) return false;
    const out = await h.ack;
    if (out.status === 'rejected') return false;
    await setFingerprint(id, templateFingerprint(a.kind, a.settings))?.ack;
    return true;
  },

  /** Create an action and its graph (the REST path; the editor writes both
   *  itself). Resolves the refusal reason, or null on success. */
  async create(a: ActionDoc): Promise<string | null> {
    const col = actionsCol();
    if (!col) return 'store not ready';
    const settings = normalizeSettings(a.kind, a.settings);
    const doc: ActionDoc = {
      ...a,
      settings,
      templateFingerprint: templateFingerprint(a.kind, settings),
    };
    const out = await col.set(a.id, '', doc as unknown as Dto).ack;
    if (out.status === 'rejected') return out.reason ?? 'rejected';
    const g = writeGraph(doc);
    const gOut = g ? await g.ack : undefined;
    if (gOut?.status === 'rejected') return gOut.reason ?? 'rejected';
    return null;
  },

  /** Boot: create missing graphs; regenerate UNMODIFIED graphs whose template
   *  output changed; leave modified ones alone. Runs after the mesh hydrated
   *  and before LogicManager starts the graphs. */
  bootSync(): void {
    const col = actionsCol();
    if (!col) return;
    let regenerated = 0;
    for (const raw of col.all()) {
      const a = raw as unknown as ActionDoc;
      if (!actionKind(a.kind)) continue;
      try {
        const target = templateFingerprint(a.kind, a.settings);
        const graph = graphDocOf(a.id);
        if (!graph) {
          writeGraph(a);
          setFingerprint(a.id, target);
          regenerated++;
          continue;
        }
        const current = graphFingerprint(
          graph.descriptor as GraphDescriptorDoc
        );
        if (current === target) {
          setFingerprint(a.id, target);
        } else if (current === a.templateFingerprint) {
          writeGraph(a);
          setFingerprint(a.id, target);
          regenerated++;
        }
      } catch (e) {
        console.error(`[Actions] boot sync failed for ${a.id}:`, e);
      }
    }
    if (regenerated)
      console.log(`[Actions] regenerated ${regenerated} action graph(s)`);
  },

  /** Derived graph state for an action (REST read model). */
  status(a: ActionDoc): ActionGraphStatus & { graphId: string | null } {
    const graph = graphDocOf(a.id);
    return {
      graphId: (graph?.id as string | undefined) ?? null,
      ...actionGraphStatus(
        a,
        (graph?.descriptor as GraphDescriptorDoc | undefined) ?? null
      ),
    };
  },
};
