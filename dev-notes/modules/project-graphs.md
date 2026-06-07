# Logic

**Status: Implemented.** This module covers the **Logic** feature — user-built standalone signal graphs. (The module was formerly called "Standalone Graphs"; the doc filename `project-graphs.md` is kept, but the source dir is now `logic/` and the user-facing concept and code identifiers are now "Logic".) It covers **all three** scopes: project, scene-node ("object"), and compose-layer. They all share a single DB table, a single REST router, and a single backend manager (`LogicManager`).

> A Logic **is** a signal graph (it owns a `GraphDescriptor` edited in the `SignalGraphCanvas` substrate editor). A [Behavior](component-managers.md) is **backed by** a signal graph but is a separate, packaged-driver concept. Keep "signal graph"/"graph" for the substrate; "logic" for this feature.

Logic exists independently of any `behaviors` row. The canonical use case is [Overlive](overlive.md) event handlers at the project scope, but any cross-cutting reactive logic can live here. See [signal-graph.md](signal-graph.md) for the underlying engine.

## Scopes

| Owner kind | Use case | Context node injected |
|---|---|---|
| `project` | Project-wide event handlers (overlive, manual triggers). No spatial owner. | none |
| `scene_node` | Logic attached to a scene node (e.g. drive that node's transform or trigger its clips). | `scene_entity` (output type `SceneNode`), fed the owner scene node id |
| `compose_layer` | Logic attached to a compose layer (e.g. drive that layer's text content / opacity). | `scene_entity` (output type `ComposeLayer`), fed the owner compose layer id |

Behavior graphs (one per `behaviors` row, hardcoded shape) are a separate concept; they're owned by the behavior manager and not surfaced through the same routes.

## DB — unified `logic` table (created as `graphs` in migration 014, renamed to `logic` via migrations 022 → 025)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `owner_kind` | TEXT | `'project'` \| `'scene_node'` \| `'compose_layer'` |
| `owner_id` | TEXT | Project / scene-node / compose-layer id |
| `name` | TEXT | |
| `enabled` | INTEGER 0/1, default 1 | |
| `descriptor` | TEXT (JSON `GraphDescriptor`), default `{"nodes":[],"edges":[]}` | |
| `node_state` | TEXT (JSON, keyed by node id), default `{}` | Per-node persisted state. Mirrors the `_nodeState` convention used by behavior managers, but lives on the row directly. |
| `created_at` / `updated_at` | TEXT | |

## REST surface — `routes/logic.ts`

A single generic router serves all three owner kinds.

| Method + path | Purpose |
|---|---|
| `GET  /api/projects/:projectId/logic` | List project-scope logic. |
| `POST /api/projects/:projectId/logic` | Create project-scope logic (body: `{ name }`). Routes through `logicManager.create` + `reconcile`. |
| `GET  /api/projects/:projectId/scoped-logic` | List **all** scene-node- and compose-layer-scoped logic for the project in one query, each tagged with its owner's display name (`ownerName`) and kind (`ownerNodeKind`). Powers the Logic panel's "Scoped Logic" section. |
| `GET  /api/scene-nodes/:nodeId/logic` | List scene-node-scope logic. |
| `POST /api/scene-nodes/:nodeId/logic` | Create scene-node-scope logic; manager auto-injects `scene_entity` bound to the node. |
| `GET  /api/compose-layers/:layerId/logic` | List compose-layer-scope logic. |
| `POST /api/compose-layers/:layerId/logic` | Create compose-layer-scope logic; manager auto-injects `scene_entity` bound to the layer. |
| `PUT  /api/logic/:id` | Patch `name` / `enabled` / `descriptor`. Goes through `logicManager.update` (validates + `reconcile`s). |
| `DELETE /api/logic/:id` | `logicManager.remove` (stops runtime + deletes). |

`mapLogicRow` returns the unified `LogicRecord` shape: `{ id, ownerKind, ownerId, name, enabled, descriptor, createdAt, updatedAt }`.

## Backend lifecycle — `logic/manager.ts`

`LogicManager` (singleton `logicManager`, mounted via `routes/shared.ts`) owns the runtime instances for all three scopes.

- **`startAllEnabled()`** — called at server boot. Hydrates and starts every `enabled = 1` row across all owner kinds.
- **`reconcile(id)`** — called on every create/update. If `enabled` it stops then re-starts the instance (picks up descriptor + node_state changes); if disabled, stops only.
- **Descriptor validation** — `validateDescriptor()` always rejects the behavior-context kinds `{ behavior_config, behavior_id }` (no behavior to read from). `scene_entity` is allowed in **scene-node- and compose-layer-scoped** logic and rejected only in **project**-scoped logic (no owner entity). Thrown errors surface as `400` from the PUT handler. For the allowed scopes the user authors a `scene_entity` node directly; the manager feeds its `config.nodeId` = `owner_id` at start time, and the node's **output type follows the scope** — `SceneNode` for scene-node-scoped, `ComposeLayer` for compose-layer-scoped — via `inferSceneEntity` (the scope reaches inference through `SignalGraph.fromDescriptor(..., ownerKind)` → `InferGraph` → `InferCtx.ownerKind`).
- **State persistence** — each `setState(nodeId, state)` writes the JSON map back to the row's `node_state` column.
- **Clock self-tick** — for each `clock` node in the descriptor, the manager calls `Clock.attach(...)` and stashes the cleanup; defaults to 30Hz or `defaultConfig.hz`.

External event entry point:

```ts
logicManager.fire(graphId, nodeId, portName, value)
```

No-op if the logic is not running. Used by `OverliveManager.routeEvent()` to deliver Twitch / SE events into matching `overlive_*` nodes — see [overlive.md](overlive.md). (The `graphId` param keeps its substrate-level name; it is the logic's id.)

Iteration helper for managers that need to discover nodes across all running logic:

```ts
for (const { graphId, node, projectId } of logicManager.iterateNodes()) { ... }
```

## Frontend

### `components/editor/LogicSection.tsx` (renamed from `GraphsSection.tsx`)

Inline expandable list of logic attached to a single scene node ("object") or compose layer. Polls `api.getNodeLogic(ownerId)` / `api.getLayerLogic(ownerId)` every 3s, supports add / rename / toggle / delete via right-click `ContextMenu`. Selecting a logic sets `activeLogicId` in the store.

`setActiveLogic(id)` (store) does double duty: when `id != null` it also flips `leftTab` to `'logic'`, so opening any logic — including a scoped one from the scene/compose trees — switches the main view to the writable `SignalGraphCanvas` (the substrate editor). Clearing the active logic (`null`) leaves the current tab alone. This is the mechanism behind "the main view is bound to the active tab" (see [frontend.md](frontend.md)).

The Logic panel (`LogicListPanel` in `SceneGraph.tsx`) lists three groups: **Global Logic** (project scope), **Scoped Logic** (scene-node + compose-layer owned, via `GET /api/projects/:id/scoped-logic`, each row labelled with its owner name + scope), and **Behavior Logic** (read-only). The Scoped Logic section exists so the active scoped logic shows as selected and can be switched without leaving the Logic tab — the inline per-owner lists in the scene/compose trees remain the place to create them.

### `SignalGraphCanvas` — writable

The canvas (the signal-graph substrate editor, name kept) is writable for all logic: node add / move / connect / disconnect / edit dispatches a `PUT /api/logic/:id` with the updated descriptor, and the manager's `reconcile()` rehydrates the running instance. The 500ms state poll preserves React Flow selection across reloads (see `4a72b34`); noodles are independently selectable + deletable (`61af21c`).

### `api/client.ts` — unified `LogicRecord`

Single `LogicRecord` type covers all owner kinds (project-scope helpers `getProjectLogic` / `createProjectLogic`; scoped list via `getProjectScopedLogic` → `ScopedLogicRecord`):

- `getNodeLogic` / `createNodeLogic`
- `getLayerLogic` / `createLayerLogic`
- `getLogic` / `updateLogic` / `deleteLogic` (owner-kind-agnostic — hit `/logic/:id`)

## Constraints

- Logic can't reference scene nodes / behaviors by literal id (they'd break across projects); use the injected `scene_entity` for scope-bound references or go through behavior REST surfaces.
- All event-driven entry points are external (Overlive today; future webhooks). No automatic per-frame tick beyond the descriptor's own `clock` nodes.

## Cross-references

- [overlive.md](overlive.md) — primary consumer of project-scope logic.
- [presets.md](presets.md) — preset payloads include nested logic at the appropriate owner scope; ids are placeholder-substituted so descriptors round-trip cleanly.
- [signal-graph.md](signal-graph.md) — engine, port system, node kinds.
- [component-managers.md](component-managers.md) — Behaviors: the packaged-driver concept, distinct from Logic.
