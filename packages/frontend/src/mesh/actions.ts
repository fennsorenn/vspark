/**
 * Actions on the mesh: reads (hooks) and writes for `action` documents and the
 * Logic graph each one owns (owner_kind 'action'). See
 * dev-notes/modules/actions.md.
 *
 * Writes are authored by the tab (so they land on its undo stack) and decided
 * by the server, whose onCommitted tap keeps the graph in step
 * (backend actions/lifecycle.ts). Where the editor knows more than the server —
 * the user confirmed discarding graph edits — it writes the rebuilt graph
 * itself, in the same batch as the settings change, so one undo restores both
 * the settings AND the edited graph.
 */
import { useMemo } from 'react';
import { useCollection, useMeshSelector } from '@vspark/mesh-react';
import {
  actionGraphId,
  actionGraphStatus,
  actionKind,
  buildActionGraph,
  changesShape,
  normalizeSettings,
  templateFingerprint,
  type ActionGraphStatus,
  type ActionSettings,
} from '@vspark/shared/actions';
import { toDescriptorDoc, type GraphDescriptor } from '@vspark/shared/signal';
import { collectionOf, createDoc, patchDoc, removeDoc } from './docs';
import { meshBatch } from './peer';
import { actionLabel, watch } from './writeFeedback';
import { logicRecordOf } from './hooks';
import type { LogicRecord, RawLogic } from '../api/client';

export interface ActionRecord {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  enabled: boolean;
  settings: ActionSettings;
  templateFingerprint: string | null;
  createdAt?: string;
}

const RTYPE = 'action';

// ── reads ────────────────────────────────────────────────────────────────────

/** The open project's actions, in creation order. */
export function useProjectActions(projectId: string | undefined): ActionRecord[] {
  const col = useCollection<ActionRecord>(RTYPE);
  const all = useMeshSelector(col, '**', (c) => c.all());
  return useMemo(
    () =>
      all
        .filter((a) => a.projectId === projectId)
        .sort(
          (a, b) =>
            (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
            a.id.localeCompare(b.id)
        ),
    [all, projectId]
  );
}

/** Every action graph this tab holds, keyed by the owning action's id. */
export function useActionGraphs(): Record<string, LogicRecord> {
  const col = useCollection<RawLogic>('logic');
  return useMeshSelector(col, '**', (c) => {
    const out: Record<string, LogicRecord> = {};
    for (const g of c.all())
      if (g.ownerKind === 'action') out[g.ownerId] = logicRecordOf(g)!;
    return out;
  });
}

/** Badge state for one action given its graph (or none). */
export function statusOf(
  action: ActionRecord,
  graph: LogicRecord | undefined
): ActionGraphStatus {
  return actionGraphStatus(action, graph?.descriptor ?? null);
}

// ── writes ───────────────────────────────────────────────────────────────────

/** The graph document an action owns, if the replica has it. */
function graphDocOf(actionId: string): RawLogic | undefined {
  const col = collectionOf<RawLogic>('logic');
  const owned = (g: RawLogic | undefined) =>
    !!g && g.ownerKind === 'action' && g.ownerId === actionId;
  const direct = col.get(actionGraphId(actionId));
  if (owned(direct)) return direct;
  return col.all().find(owned);
}

/** Write the template output as the action's graph (replace or create). */
function writeGraph(a: ActionRecord, settings: ActionSettings): void {
  const existing = graphDocOf(a.id);
  const id = existing?.id ?? actionGraphId(a.id);
  const descriptor = toDescriptorDoc(
    buildActionGraph(a.kind, settings, id, a.name)
  );
  const col = collectionOf<RawLogic>('logic');
  const h = existing
    ? col.set(id, 'descriptor', descriptor)
    : col.create({
        id,
        ownerKind: 'action',
        ownerId: a.id,
        name: a.name,
        enabled: true,
        descriptor,
      } as RawLogic);
  watch(h.ack, actionLabel('logic'));
}

/** Create an action of `kind` with default settings and its graph, as one undo
 *  step. The action goes first so the graph's owner exists when it lands. */
export async function commitActionCreate(
  projectId: string,
  kind: string,
  name: string
): Promise<ActionRecord | undefined> {
  const def = actionKind(kind);
  if (!def) return undefined;
  const id = crypto.randomUUID();
  const settings = def.normalize(def.defaults());
  const action: ActionRecord = {
    id,
    projectId,
    kind,
    name,
    enabled: true,
    settings,
    templateFingerprint: templateFingerprint(kind, settings),
    createdAt: new Date().toISOString(),
  };
  const descriptor = toDescriptorDoc(
    buildActionGraph(kind, settings, actionGraphId(id), name)
  );
  let created: Promise<unknown> = Promise.resolve();
  meshBatch(() => {
    created = createDoc(RTYPE, action);
    void createDoc('logic', {
      id: actionGraphId(id),
      ownerKind: 'action',
      ownerId: id,
      name,
      enabled: true,
      descriptor,
    }).catch(() => {});
  });
  try {
    await created;
    return action;
  } catch {
    return undefined;
  }
}

/** Name / enabled — one undo step. */
export const commitActionPatch = (
  id: string,
  patch: Partial<Pick<ActionRecord, 'name' | 'enabled'>>
): void => void patchDoc(RTYPE, id, patch);

/** Delete an action AND its graph (a child document) as one undo step. */
export const commitActionDelete = (id: string): Promise<boolean> =>
  removeDoc(RTYPE, id);

function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  const cur = obj[head];
  return {
    ...obj,
    [head]: rest.length
      ? setPath(
          cur && typeof cur === 'object' && !Array.isArray(cur)
            ? (cur as Record<string, unknown>)
            : {},
          rest.join('.'),
          value
        )
      : value,
  };
}

/** The settings an edit would leave behind (normalized). */
export function nextSettings(
  a: ActionRecord,
  path: string,
  value: unknown
): ActionSettings {
  return normalizeSettings(a.kind, setPath(a.settings ?? {}, path, value));
}

/** Would this settings edit rebuild the graph? (A shape change.) */
export function editRebuildsGraph(
  a: ActionRecord,
  path: string,
  value: unknown
): boolean {
  return changesShape(a.kind, a.settings, nextSettings(a, path, value));
}

/**
 * Edit one setting (dotted path under `settings`). A value edit is one field
 * write — the running graph reads it live. A shape edit also writes the
 * rebuilt graph and its fingerprint, in one batch, so one undo restores the
 * previous settings and the previous (possibly hand-edited) graph. The caller
 * confirms first when the graph was modified (see {@link editRebuildsGraph}).
 */
export function commitActionSetting(
  a: ActionRecord,
  path: string,
  value: unknown
): void {
  const col = collectionOf<ActionRecord>(RTYPE);
  if (!col.get(a.id)) return;
  const next = nextSettings(a, path, value);
  if (!changesShape(a.kind, a.settings, next)) {
    watch(col.set(a.id, `settings.${path}`, value).ack, actionLabel(RTYPE));
    return;
  }
  meshBatch(() => {
    // Settings + fingerprint first, then the graph: on undo (reverse order)
    // the graph comes back before the settings, so the server sees the old
    // graph already in place and leaves it alone.
    watch(
      col.update(a.id, {
        settings: next,
        templateFingerprint: templateFingerprint(a.kind, next),
      }).ack,
      actionLabel(RTYPE)
    );
    writeGraph(a, next);
  });
}

/** Regenerate the graph from the template (Reset), discarding graph edits —
 *  one undo step that restores them. Creates the graph when it is missing. */
export function commitActionReset(a: ActionRecord): void {
  const col = collectionOf<ActionRecord>(RTYPE);
  if (!col.get(a.id)) return;
  const fp = templateFingerprint(a.kind, a.settings);
  meshBatch(() => {
    writeGraph(a, a.settings);
    if (a.templateFingerprint !== fp)
      watch(col.set(a.id, 'templateFingerprint', fp).ack, actionLabel(RTYPE));
  });
}

/** The graph as it would be generated now (for tests and previews). */
export function templateGraphOf(a: ActionRecord): GraphDescriptor {
  return buildActionGraph(a.kind, a.settings, actionGraphId(a.id), a.name);
}
