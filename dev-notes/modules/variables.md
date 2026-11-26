# Graph variables

Named values shared by a project's Logic graphs: counters, last-seen values, cooldown
timestamps. Read and written by the signal nodes `variable`, `set_variable`,
`increment_variable` (and `cooldown` for named groups), and used as the state store of
`deadline` (timer state) and `tally` (per-viewer totals) — see
[signal-graph.md](signal-graph.md#logic-helpers--conditions-text-variables-triggers-combos).
Added in phase 1 of the Actions plan ([plans/actions.md](../plans/actions.md)).

**Status:** implemented (store + nodes). Tab reads and writes are implemented on
`feature/stream-widgets` (not yet merged to `dev`) for the stream-widget composites
([composites.md](composites.md)). No general variables UI yet — the plan's Actions
panel is expected to list and reset variables.

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

## Naming — `@vspark/shared/variables`

The naming helpers live in the shared subpath `@vspark/shared/variables` (registered in
the shared `package.json` exports, backend + frontend `tsconfig` paths, frontend
`vite.config.ts` + `vitest.config.ts` aliases and backend `bundle.mjs`), because the
editor addresses the same documents: `VariableRef`, `variableRef(projectId, scope,
name)` (normalizes; null without a project or name), `persistentVariableId`,
`runtimeVariableId`. `backend/src/variables/store.ts` re-exports them for existing
importers.

The same subpath holds the value shapes and pure transitions of the state nodes, so
the editor's buttons apply exactly what the nodes apply:

- **Deadline** — `DeadlineState { endsAt, remaining, total, running, finished }`,
  `DEADLINE_IDLE`, `deadlineStateOf` (any stored value → a valid state),
  `remainingOf`, `deadlineOps.start / pause / resume / add / finish / reset`.
- **Tally** — `TallyState { totals, recent }`, `TALLY_EMPTY`, `tallyStateOf`,
  `tallyAdd`, `tallyTop`.
- `parseDateTime` (used by `date_time` and the countdown's Start button).

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

### Change notifications

`onVariableChange(cb)` calls `cb(ref)` for every change or removal in either
collection, whatever its origin (a graph here or a tab). It is synchronous, so a node
can skip its own write by setting a flag around it (`deadline` and `tally` do, with a
`writing` field). A removal carries no document; the ref is recovered from the id
with `refFromId`. `sameRef` compares two refs. Before the mesh is up it returns a
no-op unsubscribe.

### Tabs

- **Decided (user, 2026-11-09):** tabs may **write** project variables. The editor's
  timer buttons (Start / Pause / Resume / Reset) and a goal count set by hand put the
  variable document directly; the nodes holding the variable react through
  `onVariableChange`.
- `variable` and `runtime_variable` are in `TAB_MODELS` (`packages/shared/src/models.ts`),
  so tabs open both collections.
- `variable` binding (`mesh/index.ts`): `clients: TAB_AUTHORED`, with
  `validate: guardVariable(data, 'var')` — the document's id must be the one its
  (project, scope, name) gives in that collection's scheme, and the project must
  exist; otherwise the write is rejected.
- `runtime_variable` (`mesh/variables.ts`): the tab grant is read + create + update +
  delete, with no validation (observed; under the local single-user trust model).
- Frontend `packages/frontend/src/mesh/variables.ts`: `useVariable(ref)` (live value;
  the persistent copy wins if both exist) and `writeVariable(ref, value, persistent)`,
  which writes the named collection and removes the copy in the other, like the
  backend store. Writes pass `undo: false` — runtime state, not document edits (the
  same rule the backend store follows). Callers: `CompositeControls.tsx`
  (`TimerControl`, `VariableControl`).

### Without a mesh

Unit tests that don't start the mesh and the window before `initBackendMesh` have no
collections: reads return `undefined`, writes are no-ops, warned once.

## Name suggestions (editor)

- **Decided (user, 2026-11-09):** inputs that name a variable, a scope or a named
  trigger suggest the names already in use (on that scope) and still accept any new
  name typed freely — in Actions, logic node default inputs and composite settings
  (and behaviors, should they get such inputs).
- `packages/frontend/src/mesh/names.ts` collects the names from the tab's replica:
  stored variables (`variable` / `runtime_variable`); the `name` / `scope` config of
  nodes in `VARIABLE_NODE_KINDS` (`variable`, `set_variable`, `increment_variable`,
  `deadline`, `tally`), with the scope taken from the `scope` setting, or the graph's
  id when wired from `logic_id` (a scope wired from anything else is unknown and the
  node is not listed); `cooldown` groups (scope `COOLDOWN_SCOPE` = `__cooldown`);
  `send_trigger` / `on_trigger` names; and Actions settings (`counter.name` in the
  shared scope, `cooldown.group`, `trigger`). A graph document carries no project
  id: `graphProject` resolves it from the owner (project, action, layer, scene node,
  or a behavior's node). Exports `variableNames`,
  `triggerNames`, `scopeOptions`, `uniqueName` (first free `<base>`, `<base> 2`, …),
  `triggerBases` (`<base>` of `<base> start|pause|resume|reset` sets),
  `nodePortNameSpec`, `useNameSuggestions(spec)` and `currentProjectDocs()`
  (non-hook snapshot).
- Rendered as a `<datalist>` (the blendshape-name input in `PropertiesPanel` was the
  precedent): `DraftText`'s `suggestions` prop / the exported `SuggestionList`
  (`components/editor/actions/draftInputs.tsx`); `SignalNodeCard`'s StaticInput for
  String ports via `nodePortNameSpec` (`SignalGraphCanvas` passes each node's
  `scopeSource`: `'graph'` | `'other'`); composite settings via their `suggest` field
  ([composites.md](composites.md)); Actions' trigger / counter name / cooldown group
  fields ([actions.md](actions.md)).
- Test: `packages/frontend/test/names.test.tsx`.

## Cleanup

Deleting a Logic graph deletes every variable (both collections, all projects) whose
scope is the graph's id — `logicLifecycle.onRemoved` → `deleteVariablesInScope`. The
shared namespace (`''`) is never bulk-deleted.

## Key files

- `packages/shared/src/variables.ts` — naming, deadline / tally state and
  transitions, `parseDateTime`.
- `packages/backend/src/variables/store.ts` — `readVariable`, `writeVariable`,
  `incrementVariable`, `deleteVariablesInScope`, `onVariableChange`, `refFromId`,
  `sameRef` (+ re-exported naming).
- `packages/backend/src/mesh/index.ts` — the `variable` binding and `guardVariable`.
- `packages/frontend/src/mesh/variables.ts` — `useVariable`, `writeVariable`.
- `packages/frontend/src/mesh/names.ts` — names in use, for input suggestions.
- `packages/backend/src/mesh/variables.ts` — the `runtime_variable` collection.
- `packages/backend/src/signal/nodes/variable.ts` — the three variable nodes;
  `deadline.ts`, `tally.ts` — the state nodes.
- `packages/backend/src/db/migrations/046_variables.sql` — the table.
- Tests: `packages/backend/test/nodes.variables.test.ts`,
  `packages/backend/test/nodes.widgets.test.ts`, `packages/shared/test/variables.test.ts`.
