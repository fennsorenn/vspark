# Project Graphs (standalone signal graphs)

**Status: WIP.** Branch `feature/overlive-integration`.

Adds project-scoped **standalone** signal graphs that exist independently of any node component. Until now, every `SignalGraph` was owned by a `node_components` row (one graph per component, hardcoded shape per component kind, read-only in the UI). This module introduces user-authored graphs at the project level — primarily to host [Overlive](overlive.md) event handlers, but usable for any cross-cutting reactive logic.

See also [signal-graph.md](signal-graph.md) for the underlying engine.

## Scope

| | Component graphs (existing) | Project graphs (new) |
|---|---|---|
| Ownership | `node_components` row | `project_graphs` row |
| Lifecycle | Created/destroyed with component | Enabled flag on the row |
| Shape | Hardcoded per component kind | User-authored |
| Editor | Read-only canvas | **Writable** `SignalGraphCanvas` |
| Context nodes | `component_config`, `component_id`, `scene_entity` available | **NOT available** — throw at runtime |
| Inputs | Component config + scene context | Inline literals + `Account` port (Overlive) |

## DB (planned)

Migration adds `project_graphs`:

- `id` (text, pk)
- `project_id` (fk, cascade)
- `name` (text)
- `enabled` (int, 0/1)
- `descriptor` (json — `GraphDescriptor`)
- timestamps

Lifecycle: when `enabled` flips on, the backend hydrates a `SignalGraph` from the descriptor and registers it with relevant managers (notably `OverliveManager`). Flipping off disposes it.

## Backend (planned)

- `packages/backend/src/routes/project-graphs.ts` — REST CRUD + enable/disable.
- Lifecycle owner TBD (likely a `ProjectGraphManager` parallel to other component managers, or folded into `OverliveManager` if Overlive remains the only consumer).
- Engine: `component_config`, `component_id`, `scene_entity` nodes throw if executed inside a standalone graph (no component context to resolve against).

## Frontend (planned)

The Graphs panel currently lives in `components/editor/SceneGraph.tsx`'s left sidebar and lists per-component graphs read-only. Restructuring:

```
Graphs
├── <Standalone graph 1>        ← new, writable
├── <Standalone graph 2>
└── Component graphs            ← collapsible parent
    ├── <component A> graph     ← existing, read-only
    └── <component B> graph
```

Selecting a standalone graph opens the existing `SignalGraphCanvas` in writable mode.

## Constraints

- Standalone graphs **cannot** reference scene nodes or components directly. If they need to drive scene state, they go through the same broadcast/manager surfaces that REST does.
- All event-driven entry points are external (Overlive events, future webhooks). No automatic per-frame tick.

## Open questions / TBD

- WS broadcast shape for live graph edits (likely mirrors existing scene-state mutations: `project_graph_added/updated/removed`).
- Whether standalone graphs can target compose layers / track-clip triggers directly, or only via REST-equivalent nodes.
