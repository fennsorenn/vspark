# Project Graphs (standalone signal graphs)

**Status: Implemented.** Caveat: `SignalGraphCanvas` currently renders project graphs **read-only**; the writable canvas (node create/move/connect/edit persisted via `PUT /api/project-graphs/:id`) is tracked as a follow-up. Everything backend-side (CRUD, lifecycle, descriptor validation, event-fire entry point) is shipped.

Project-scoped **standalone** signal graphs exist independently of any node component. Unlike component-owned graphs (one per `node_components` row, hardcoded shape, read-only in the UI), project graphs are user-authored at the project level — primarily to host [Overlive](overlive.md) event handlers, but usable for any cross-cutting reactive logic.

See [signal-graph.md](signal-graph.md) for the underlying engine.

## Scope

| | Component graphs | Project graphs |
|---|---|---|
| Ownership | `node_components` row | `graphs` row with `owner_kind = 'project'` |
| Lifecycle | Created/destroyed with component | `enabled` flag on the row |
| Shape | Hardcoded per component kind | User-authored, persisted as `GraphDescriptor` |
| Editor | Read-only canvas | Read-only canvas today; writable canvas is a follow-up |
| Context nodes | `component_config`, `component_id`, `scene_entity` available | **Rejected** at runtime — descriptor validation throws |
| External event entry | Manager `fire()` (VMC packet, mediapipe frame, etc.) | `OverliveManager` → `ProjectGraphManager.fire()` |

## DB — unified `graphs` table (migration 014)

Project graphs no longer have a dedicated table. They live in the shared `graphs` table (introduced by migration `014_graphs_table.sql`) alongside scene-node and compose-layer graphs, distinguished by `owner_kind`:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `owner_kind` | TEXT | `'project'` \| `'scene_node'` \| `'compose_layer'` |
| `owner_id` | TEXT | Owner's id (project id for `'project'` rows) |
| `name` | TEXT | |
| `enabled` | INTEGER 0/1, default 1 | |
| `descriptor` | TEXT (JSON `GraphDescriptor`), default `{"nodes":[],"edges":[]}` | |
| `node_state` | TEXT (JSON, keyed by node id), default `{}` | Per-node persisted state. Mirrors the `_nodeState` convention used by component managers, but lives on the graph row directly. |
| `created_at` / `updated_at` | TEXT | |

## REST surface — `routes/graphs.ts`

Project graphs are served by the generic `routes/graphs.ts` (the standalone `routes/project-graphs.ts` was deleted in the convergence). The same router serves scene-node and compose-layer graphs; the project routes are the only ones that go through `ProjectGraphManager` (so the graph starts/validates immediately) — scene-node and compose-layer creates write the row directly.

| Method + path | Purpose |
|---|---|
| `GET  /api/projects/:projectId/graphs` | List `owner_kind = 'project'` graphs for a project. |
| `POST /api/projects/:projectId/graphs` | Create empty graph (body: `{ name }`). Routes through `projectGraphManager.create` + `reconcile`. |
| `PUT  /api/graphs/:id` | Patch `name` / `enabled` / `descriptor` (each optional). Project rows go through `projectGraphManager.update` (which validates + `reconcile`s); other owner kinds patch the row directly. |
| `DELETE /api/graphs/:id` | Project rows → `projectGraphManager.remove` (stop runtime + delete); other owner kinds delete the row directly. |

`mapGraphRow` returns the unified `GraphRecord` shape: `{ id, ownerKind, ownerId, name, enabled, descriptor, createdAt, updatedAt }`.

## Backend lifecycle — `project_graphs/manager.ts`

`ProjectGraphManager` (singleton, mounted via `routes/shared.ts`) owns the runtime instances.

- **`startAllEnabled()`** — called at server boot. Hydrates and starts every `enabled = 1` row.
- **`reconcile(id)`** — called on every project-graph create/update. If row is `enabled` it stops then re-starts the instance (which picks up descriptor + node_state changes); if disabled, it just stops.
- **Descriptor validation** — `validateDescriptor()` rejects any node whose kind is in `COMPONENT_CONTEXT_KINDS = { component_config, component_id, scene_entity }`. Thrown errors surface as `400` from the PUT handler.
- **State persistence** — each `setState(nodeId, state)` writes the JSON map back to the row's `node_state` column.
- **Clock self-tick** — for each `clock` node in the descriptor, the manager calls `Clock.attach(...)` and stashes the cleanup; defaults to 30Hz or `defaultConfig.hz`. State `hz` overrides at runtime.

External event entry point:

```ts
projectGraphManager.fire(graphId, nodeId, portName, value)
```

No-op if the graph is not running. Used by `OverliveManager.routeEvent()` to deliver Twitch / SE events into matching `overlive_*` nodes — see [overlive.md](overlive.md).

Iteration helper for managers that need to discover nodes across all running project graphs:

```ts
for (const { graphId, node, projectId } of projectGraphManager.iterateNodes()) { ... }
```

## Frontend — `components/editor/SceneGraph.tsx`

Graphs panel restructure (now shipped):

```
Project Graphs                  ← top-level, with add/rename/toggle/delete
  ├── <Standalone graph 1>
  └── <Standalone graph 2>
Component Graphs (collapsible, count badge)
  ├── <component A> graph       ← read-only
  └── <component B> graph
```

Both sections currently open the same `SignalGraphCanvas` in read-only mode when selected. The writable variant for project graphs is the outstanding follow-up: when implemented, edits dispatch as `PUT /api/graphs/:id` with the new descriptor and the manager's `reconcile()` rehydrates the running instance.

### `api/client.ts` — unified `GraphRecord`

The frontend converged onto a single `GraphRecord` type (`{ id, ownerKind, ownerId, name, enabled, descriptor, createdAt?, updatedAt? }`) covering all three owner kinds. The old `ProjectGraphRecord` type and `updateProjectGraph` / `deleteProjectGraph` functions were removed in favour of:

- `getProjectGraphs` / `createProjectGraph`
- `getNodeGraphs` / `createNodeGraph`
- `getLayerGraphs` / `createLayerGraph`
- `updateGraph` / `deleteGraph` (owner-kind-agnostic — hit `/graphs/:id`)

`SceneGraph.tsx` and `SignalGraphCanvas.tsx` use these generic functions.

## Constraints

- Standalone graphs cannot reference scene nodes or components directly. To drive scene state they must go through the same broadcast/manager surfaces REST does.
- All event-driven entry points are external (Overlive today; future webhooks). No automatic per-frame tick beyond the descriptor's own `clock` nodes.

## Open follow-ups

- Writable `SignalGraphCanvas` (node create/move/edit/connect → `PUT descriptor`).
- WS broadcast shape for live edits coming from other clients (`project_graph_added/updated/removed`) — not strictly needed while single-user.
- Decision on whether standalone graphs may target compose layers / track-clip triggers directly, or only via REST-equivalent nodes.
