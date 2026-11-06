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

export interface VariableRef {
  projectId: string;
  /** '' = the shared namespace. */
  scope: string;
  name: string;
}

const enc = (s: string) => encodeURIComponent(s);

/** Document id in the persistent collection. Scope and name are encoded so
 *  the separators are unambiguous; the prefixes keep the two collections' ids
 *  apart (the mesh containment index keys ids across every rtype). */
export const persistentVariableId = (r: VariableRef): string =>
  `var:${r.projectId}:${enc(r.scope)}:${enc(r.name)}`;
export const runtimeVariableId = (r: VariableRef): string =>
  `rvar:${r.projectId}:${enc(r.scope)}:${enc(r.name)}`;

/** Normalize the parts of a ref read off node ports; null when unusable (no
 *  project — e.g. a graph that isn't a Logic graph — or no name). */
export function variableRef(
  projectId: unknown,
  scope: unknown,
  name: unknown
): VariableRef | null {
  if (typeof projectId !== 'string' || projectId === '') return null;
  const n = typeof name === 'string' ? name.trim() : '';
  if (n === '') return null;
  const s = typeof scope === 'string' ? scope.trim() : '';
  return { projectId, scope: s, name: n };
}

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
