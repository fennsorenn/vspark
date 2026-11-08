# Graph variables

Named values shared by a project's Logic graphs: counters, last-seen values, cooldown
timestamps. Read and written by the signal nodes `variable`, `set_variable`,
`increment_variable` (and `cooldown` for named groups) — see
[signal-graph.md](signal-graph.md#logic-helpers--conditions-text-variables-triggers-combos).
Added in phase 1 of the Actions plan ([plans/actions.md](../plans/actions.md)).

**Status:** implemented (store + nodes). No UI yet — the plan's Actions panel is
expected to list and reset variables.

## Identity

A variable is identified by **(project, scope, name)**.

- **Decided** (user, 2026-11-06): variables are **project-wide** — every Logic graph of
  the project sees the same value; finer scoping (per object / user) is deferred.
- **Decided** (user, 2026-11-06): the optional `scope` avoids collisions. `''` is the
  shared user namespace; templates use their own scope; a graph-local variable uses the
  Logic graph's id as scope, read from `logic_id`.
- The project is the `_projectId` that `LogicManager` injects into every node's config.
  Outside a Logic graph (behavior graphs) there is none, and the variable nodes do
  nothing.
- `cooldown` keeps a named group's "last passed" time (ms since epoch) in the
  short-lived variable `__cooldown/<group>`.
- Action templates ([actions.md](actions.md)): a Chat command / Chat pattern /
  Redemption counter is `<name>` in the shared scope, or — unnamed — `count`
  in the graph's own scope; the Keyword combo keeps a graph-local short-lived
  `comboReached` flag.

## Storage — `backend/src/variables/store.ts`

One mesh document per variable, `{ id, projectId, scope, name, value }`, in exactly one
of two collections (both declared in `packages/shared/src/models.ts`):

| rtype | channel | persisted | id |
|---|---|---|---|
| `variable` | `committed` | yes — `variables` table (migration 046) through the generic persistence tap (`BINDINGS` in `mesh/index.ts`, resource in `sync/resources.ts`) | `var:<projectId>:<enc(scope)>:<enc(name)>` |
| `runtime_variable` | `runtime` (retained, no ack) | no — gone on restart | `rvar:<projectId>:<enc(scope)>:<enc(name)>` |

- Two collections because a mesh collection allows at most one retained channel, and
  `committed` and `runtime` are both retained. (The plan proposed "persistent ones
  committed and persisted, short-lived ones on the runtime channel"; this is that
  proposal under that constraint.)
- The writer's `persistent` input decides where the variable lives **on every write**:
  the write goes to the named collection and removes the copy in the other one, so a
  read never sees two values. Two nodes disagreeing about `persistent` for the same
  variable therefore move it back and forth.
- `persistent` defaults to false (phase-1 choice: nothing reaches the database unless
  asked for).
- Values are JSON-normalized on write (`undefined` → `null`); a value JSON cannot
  represent is refused with a warning.
- Ids encode scope and name (`encodeURIComponent`) so the separators are unambiguous;
  the two prefixes keep the collections' ids apart, because the mesh containment index
  keys ids across every rtype.
- Neither collection has a containment parent (there is no `project` rtype), so
  variables reach subscribers by rtype only and no scene/collab grant carries them.
- `variables.project_id` cascades on project delete in SQLite; as for the other
  project-owned documents, the replica copy lingers until restart.

### Writes

Graph-driven writes happen only in the backend, synchronously inside the node's event
handler, so `increment_variable` is a read-modify-write no other increment can
interleave with. Committed writes pass `undo: false` (they are not document edits and
must not land on the backend peer's undo stack). Each persistent write is one SQLite
upsert plus the legacy `sync.document` echo every persisted rtype gets.

### Tabs

The backend grants its tabs `{ read: true }` on both collections. They are not in
`TAB_MODELS` yet, so tabs do not open them; a variables UI would add them there (and
widen the grant if it resets values from the tab).

### Without a mesh

Unit tests that don't start the mesh and the window before `initBackendMesh` have no
collections: reads return `undefined`, writes are no-ops, warned once.

## Cleanup

Deleting a Logic graph deletes every variable (both collections, all projects) whose
scope is the graph's id — `logicLifecycle.onRemoved` → `deleteVariablesInScope`. The
shared namespace (`''`) is never bulk-deleted.

## Key files

- `packages/backend/src/variables/store.ts` — `variableRef`, `readVariable`,
  `writeVariable`, `incrementVariable`, `deleteVariablesInScope`, id helpers.
- `packages/backend/src/mesh/variables.ts` — the `runtime_variable` collection.
- `packages/backend/src/signal/nodes/variable.ts` — the three nodes.
- `packages/backend/src/db/migrations/046_variables.sql` — the table.
- Tests: `packages/backend/test/nodes.variables.test.ts`.
