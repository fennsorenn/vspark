/**
 * Graph variables: named values shared across a project's Logic graphs,
 * read and written by the `variable` / `set_variable` / `increment_variable`
 * nodes (and by `cooldown` for named groups).
 *
 * A variable is identified by (project, scope, name). `scope` keeps unrelated
 * users of a name apart: '' is the shared namespace, a Logic graph id makes the
 * variable private to that graph (see `logic_id`; deleting the graph deletes
 * its variables, `deleteVariablesInScope`).
 *
 * Each variable is ONE mesh document, in exactly one of two collections:
 *  - `variable` — persistent: committed, persisted in the `variables` table
 *    (migration 046) by the generic mesh persistence tap, back after a restart;
 *  - `runtime_variable` — short-lived: the retained `runtime` channel, never
 *    persisted, gone on restart.
 * The writer's `persistent` flag decides which, on every write: a write moves
 * the variable to the collection it names and removes it from the other, so a
 * read never sees two values. Tabs see both collections live (read-only for
 * now), which is what a future variables UI lists and resets.
 *
 * Graph-driven writes happen only here, in the backend, and synchronously, so
 * an increment is a read-modify-write that cannot interleave with another one.
 * They are kept off the backend peer's undo stack (`undo: false`): they are
 * not document edits.
 *
 * Without a mesh (unit tests that don't start one, early boot) every write is
 * a no-op and every read is `undefined`, logged once.
 */
import type { Collection } from '@vspark/mesh';
import { getMeshCollection } from '../mesh/index.js';
import {
  runtimeVariableCollection,
  type VariableDoc,
} from '../mesh/variables.js';

import {
  persistentVariableId,
  runtimeVariableId,
  variableRef,
  type VariableRef,
} from '@vspark/shared/variables';

// Naming lives in @vspark/shared/variables (the editor addresses the same
// documents); re-exported for existing importers.
export { persistentVariableId, runtimeVariableId, variableRef };
export type { VariableRef };

let warnedNoMesh = false;
function collections(): {
  persistent: Collection<VariableDoc>;
  runtime: Collection<VariableDoc>;
} | null {
  const persistent = getMeshCollection('variable') as
    | Collection<VariableDoc>
    | undefined;
  const runtime = runtimeVariableCollection();
  if (persistent && runtime) return { persistent, runtime };
  if (!warnedNoMesh) {
    warnedNoMesh = true;
    console.warn('[variables] mesh not initialised — variables are inert');
  }
  return null;
}

/** The current value, or undefined when the variable is unset. */
export function readVariable(ref: VariableRef): unknown {
  const c = collections();
  if (!c) return undefined;
  const doc =
    c.persistent.get(persistentVariableId(ref)) ??
    c.runtime.get(runtimeVariableId(ref));
  return doc?.value;
}

/** Whether the variable currently lives in the persistent collection. */
export function isPersistent(ref: VariableRef): boolean {
  return !!collections()?.persistent.get(persistentVariableId(ref));
}

/** JSON-normalize a value (both collections replicate as JSON; the persistent
 *  one also stores it as JSON). undefined → null. Returns `undefined` for a
 *  value JSON cannot represent (cycles, BigInt). */
function normalize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return undefined;
  }
}

/** Set a variable. `persistent` picks the collection it lives in from now on;
 *  a copy in the other one is removed. */
export function writeVariable(
  ref: VariableRef,
  value: unknown,
  persistent: boolean
): void {
  const c = collections();
  if (!c) return;
  const v = normalize(value);
  if (v === undefined) {
    console.warn(
      `[variables] ${ref.scope}/${ref.name}: value is not JSON-serialisable — not stored`
    );
    return;
  }
  const pid = persistentVariableId(ref);
  const rid = runtimeVariableId(ref);
  const doc = (id: string): VariableDoc => ({
    id,
    projectId: ref.projectId,
    scope: ref.scope,
    name: ref.name,
    value: v,
  });
  if (persistent) {
    c.persistent.set(pid, '', doc(pid), { undo: false });
    if (c.runtime.get(rid)) c.runtime.remove(rid);
  } else {
    c.runtime.set(rid, '', doc(rid));
    if (c.persistent.get(pid)) c.persistent.remove(pid, { undo: false });
  }
}

/** Add `by` to a numeric variable (unset or non-numeric counts as 0) and
 *  return the new value. */
export function incrementVariable(
  ref: VariableRef,
  by: number,
  persistent: boolean
): number {
  const cur = readVariable(ref);
  const base = typeof cur === 'number' && Number.isFinite(cur) ? cur : 0;
  const next = base + by;
  writeVariable(ref, next, persistent);
  return next;
}

/** Delete every variable (both collections, all projects) whose scope is
 *  `scope`. Used when a Logic graph is deleted: graph ids are unique, so its
 *  graph-local variables are exactly those scoped to its id. Returns how many
 *  were removed. A blank scope is refused — that is the shared namespace. */
export function deleteVariablesInScope(scope: string): number {
  if (scope === '') return 0;
  const c = collections();
  if (!c) return 0;
  let n = 0;
  for (const d of c.persistent.all())
    if (d.scope === scope) {
      c.persistent.remove(d.id, { undo: false });
      n++;
    }
  for (const d of c.runtime.all())
    if (d.scope === scope) {
      c.runtime.remove(d.id);
      n++;
    }
  return n;
}

/**
 * Call `cb` with the ref of every variable that changes or is removed — by a
 * graph here, or by a tab (a Start button, a goal set by hand). Synchronous:
 * a node can skip its own write by flagging it around the write. Returns an
 * unsubscribe; a no-op before the mesh is up.
 */
export function onVariableChange(
  cb: (ref: VariableRef) => void
): () => void {
  const c = collections();
  if (!c) return () => {};
  const handle = (change: { doc?: VariableDoc; id: string }) => {
    const d = change.doc;
    if (d) {
      cb({ projectId: d.projectId, scope: d.scope, name: d.name });
      return;
    }
    // A removal carries no document: recover the ref from the id.
    const ref = refFromId(change.id);
    if (ref) cb(ref);
  };
  const offs = [c.persistent.observe('**', handle), c.runtime.observe('**', handle)];
  return () => offs.forEach((off) => off());
}

/** The ref a variable document id encodes (`var:` / `rvar:` ids). */
export function refFromId(id: string): VariableRef | null {
  const m = /^r?var:([^:]*):([^:]*):(.*)$/.exec(id);
  if (!m) return null;
  try {
    return {
      projectId: m[1],
      scope: decodeURIComponent(m[2]),
      name: decodeURIComponent(m[3]),
    };
  } catch {
    return null;
  }
}

export const sameRef = (a: VariableRef | null, b: VariableRef | null) =>
  !!a &&
  !!b &&
  a.projectId === b.projectId &&
  a.scope === b.scope &&
  a.name === b.name;
