# Standalone Graphs

**Status: Implemented.** Despite the filename, this module covers **all three** standalone graph scopes: project, scene-node, and compose-layer. They all share a single DB table, a single REST router, and a single backend manager (`ProjectGraphManager`).

Standalone graphs exist independently of any `node_components` row. The canonical use case is [Overlive](overlive.md) event handlers at the project scope, but any cross-cutting reactive logic can live here. See [signal-graph.md](signal-graph.md) for the underlying engine.

## Scopes

| Owner kind | Use case | Context node injected |
|---|---|---|
| `project` | Project-wide event handlers (overlive, manual triggers). No spatial owner. | none |
| `scene_node` | Logic attached to a scene node (e.g. drive that node's transform or trigger its clips). | `scene_entity` (output type `SceneNode`), fed the owner scene node id |
| `compose_layer` | Logic attached to a compose layer (e.g. drive that layer's text content / opacity). | `scene_entity` (output type `ComposeLayer`), fed the owner compose layer id |

Component graphs (one per `node_components` row, hardcoded shape) are a separate concept; they're owned by the component manager and not surfaced through the same routes.

## DB — unified `graphs` table (migration 014)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `owner_kind` | TEXT | `'project'` \| `'scene_node'` \| `'compose_layer'` |
| `owner_id` | TEXT | Project / scene-node / compose-layer id |
| `name` | TEXT | |
| `enabled` | INTEGER 0/1, default 1 | |
| `descriptor` | TEXT (JSON `GraphDescriptor`), default `{"nodes":[],"edges":[]}` | |
| `node_state` | TEXT (JSON, keyed by node id), default `{}` | Per-node persisted state. Mirrors the `_nodeState` convention used by component managers, but lives on the row directly. |
| `created_at` / `updated_at` | TEXT | |

## REST surface — `routes/graphs.ts`

A single generic router serves all three owner kinds.

| Method + path | Purpose |
|---|---|
| `GET  /api/projects/:projectId/graphs` | List project-scope graphs. |
| `POST /api/projects/:projectId/graphs` | Create project-scope graph (body: `{ name }`). Routes through `projectGraphManager.create` + `reconcile`. |
| `GET  /api/projects/:projectId/scoped-graphs` | List **all** scene-node- and compose-layer-scoped graphs for the project in one query, each tagged with its owner's display name (`ownerName`) and kind (`ownerNodeKind`). Powers the Graphs panel's "Scoped Graphs" section. |
| `GET  /api/scene-nodes/:nodeId/graphs` | List scene-node-scope graphs. |
| `POST /api/scene-nodes/:nodeId/graphs` | Create scene-node-scope graph; manager auto-injects `scene_entity` bound to the node. |
| `GET  /api/compose-layers/:layerId/graphs` | List compose-layer-scope graphs. |
| `POST /api/compose-layers/:layerId/graphs` | Create compose-layer-scope graph; manager auto-injects `scene_entity` bound to the layer. |
| `PUT  /api/graphs/:id` | Patch `name` / `enabled` / `descriptor`. Goes through `projectGraphManager.update` (validates + `reconcile`s). |
| `DELETE /api/graphs/:id` | `projectGraphManager.remove` (stops runtime + deletes). |

`mapGraphRow` returns the unified `GraphRecord` shape: `{ id, ownerKind, ownerId, name, enabled, descriptor, createdAt, updatedAt }`.

## Backend lifecycle — `project_graphs/manager.ts`

`ProjectGraphManager` (singleton, mounted via `routes/shared.ts`) owns the runtime instances for all three scopes.

- **`startAllEnabled()`** — called at server boot. Hydrates and starts every `enabled = 1` row across all owner kinds.
- **`reconcile(id)`** — called on every create/update. If `enabled` it stops then re-starts the instance (picks up descriptor + node_state changes); if disabled, stops only.
- **Descriptor validation** — `validateDescriptor()` always rejects the component-context kinds `{ component_config, component_id }` (no component to read from). `scene_entity` is allowed in **scene-node- and compose-layer-scoped** graphs and rejected only in **project**-scoped graphs (no owner entity). Thrown errors surface as `400` from the PUT handler. For the allowed scopes the user authors a `scene_entity` node directly; the manager feeds its `config.nodeId` = `owner_id` at start time, and the node's **output type follows the scope** — `SceneNode` for scene-node-scoped, `ComposeLayer` for compose-layer-scoped — via `inferSceneEntity` (the scope reaches inference through `SignalGraph.fromDescriptor(..., ownerKind)` → `InferGraph` → `InferCtx.ownerKind`).
- **State persistence** — each `setState(nodeId, state)` writes the JSON map back to the row's `node_state` column.
- **Clock self-tick** — for each `clock` node in the descriptor, the manager calls `Clock.attach(...)` and stashes the cleanup; defaults to 30Hz or `defaultConfig.hz`.

External event entry point:

```ts
projectGraphManager.fire(graphId, nodeId, portName, value)
```

No-op if the graph is not running. Used by `OverliveManager.routeEvent()` to deliver Twitch / SE events into matching `overlive_*` nodes — see [overlive.md](overlive.md).

Iteration helper for managers that need to discover nodes across all running standalone graphs:

```ts
for (const { graphId, node, projectId } of projectGraphManager.iterateNodes()) { ... }
```

## Frontend

### `components/editor/GraphsSection.tsx`

Inline expandable list of standalone graphs attached to a single scene node or compose layer. Polls `api.getNodeGraphs(ownerId)` / `api.getLayerGraphs(ownerId)` every 3s, supports add / rename / toggle / delete via right-click `ContextMenu`. Selecting a graph sets `activeGraphId` in the store.

`setActiveGraph(id)` (store) does double duty: when `id != null` it also flips `leftTab` to `'graphs'`, so opening any graph — including a scoped graph from the scene/compose trees — switches the main view to the writable `SignalGraphCanvas`. Clearing the active graph (`null`) leaves the current tab alone. This is the mechanism behind "the main view is bound to the active tab" (see [frontend.md](frontend.md)).

The Graphs panel (`GraphListPanel` in `SceneGraph.tsx`) lists three groups: **Project Graphs**, **Scoped Graphs** (scene-node + compose-layer owned, via `GET /api/projects/:id/scoped-graphs`, each row labelled with its owner name + scope), and **Component Graphs** (read-only). The Scoped Graphs section exists so the active scoped graph shows as selected and can be switched without leaving the Graphs tab — the inline per-owner lists in the scene/compose trees remain the place to create them.

### `SignalGraphCanvas` — writable

The canvas is writable for all standalone graphs: node add / move / connect / disconnect / edit dispatches a `PUT /api/graphs/:id` with the updated descriptor, and the manager's `reconcile()` rehydrates the running instance. The 500ms state poll preserves React Flow selection across reloads (see `4a72b34`); noodles are independently selectable + deletable (`61af21c`).

### `api/client.ts` — unified `GraphRecord`

Single `GraphRecord` type covers all owner kinds:

- `getProjectGraphs` / `createProjectGraph`
- `getNodeGraphs` / `createNodeGraph`
- `getLayerGraphs` / `createLayerGraph`
- `updateGraph` / `deleteGraph` (owner-kind-agnostic — hit `/graphs/:id`)

## Constraints

- Standalone graphs can't reference scene nodes / components by literal id (they'd break across projects); use the injected `scene_entity` for scope-bound references or go through node-component REST surfaces.
- All event-driven entry points are external (Overlive today; future webhooks). No automatic per-frame tick beyond the descriptor's own `clock` nodes.

## Cross-references

- [overlive.md](overlive.md) — primary consumer of project-scope graphs.
- [presets.md](presets.md) — preset payloads include nested standalone graphs at the appropriate owner scope; ids are placeholder-substituted so descriptors round-trip cleanly.
- [signal-graph.md](signal-graph.md) — engine, port system, node kinds.
