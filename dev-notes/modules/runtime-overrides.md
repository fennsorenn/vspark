# Runtime Overrides

**Status: WIP — Phase 1 of the signal-graph expansion (branch `feature/graph-runtime-overrides-spawn-text`).**

A backend bus that lets signal-graph nodes mutate scene-node and compose-layer params at runtime, transient by default with an opt-in persistent mode. Designed as a **parallel** surface to the existing track-clip override slots — same shape, separate slice — so the established playback path stays untouched.

## Motivation

Track clips animate fixed paramPaths along a timeline. Stream-overlay flows need *event-driven* mutations (set text content on a spawned billboard, jump opacity, set position once). These don't fit the clip model and shouldn't pollute SQLite for every transient change. The runtime overrides bus is the missing surface for graph-driven, mostly-ephemeral param writes.

## Architecture

**Backend:** `packages/backend/src/runtime_overrides/manager.ts` (new). Mirrors `broadcastBus` conceptually.

- Per-scene state of overrides keyed by `(targetKind, targetId, paramPath)`.
- Public surface (planned): `set(targetKind, targetId, paramPath, value, opts?: { persist?: boolean })`, `clear(targetKind, targetId, paramPath?)`, `snapshotFor(sceneId)`.
- Two modes:
  - **ephemeral** — lives only in this bus; no DB write.
  - **persistent** — also writes through the existing scene-node / compose-layer REST routes (for `persist: true` on a set-param node).

**WS messages** (new in `WSMessageKind`):
- `runtime_override_set { sceneId, targetKind, targetId, paramPath, value }`
- `runtime_override_clear { sceneId, targetKind, targetId, paramPath? }`
- `runtime_override_snapshot` — sent on client connect, mirrors the track-clip snapshot pattern.

**Frontend:** new Zustand slices in `editorStore.ts`:
- `runtimeNodeOverrides: Record<nodeId, Partial<Record<paramPath, value>>>`
- `runtimeLayerOverrides: Record<layerId, Partial<Record<paramPath, value>>>`

Both are parallel to the existing `nodeTransformOverrides` / `composeLayerOverrides` slots that the track-clip evaluator writes into.

## Read paths

**Scene node** — `Viewport.tsx` `useTransformWithOverride(node)` is extended to merge `runtimeNodeOverrides[node.id]` in addition to the existing transform overrides. Conflict policy on transform/scalar params: **track-clip override wins** (so an in-progress clip is not interrupted by a stale runtime override). For non-transform params (`text.content`, `opacity` on compose, generic config keys) the runtime override is the only override surface.

**Compose layer** — `ComposeLayerStack.LayerView` merges `runtimeLayerOverrides[layer.id]` into `layerStyle` alongside `composeLayerOverrides`.

## Cross-references

- [paramPaths.md](paramPaths.md) — the override bus uses the shared paramPath registry to know each value's type (so the runtime can coerce/validate).
- [track-clips.md](track-clips.md) — track-clip overrides live in `nodeTransformOverrides` / `composeLayerOverrides`. Runtime overrides are a separate, parallel layer. Documented conflict resolution: track-clip wins for transform/scalar overlap.
- [signal-graph.md](signal-graph.md) — the WIP `set_scene_node_param`, `set_compose_layer_param`, and `set_text` nodes are the producers writing into this bus.
- [spawn.md](spawn.md) — `spawn_clip` uses the override bus + new `tmp_entity_*` WS messages to publish ephemeral clones to the frontend without touching SQLite.

## Files (planned/in-progress)

- `packages/backend/src/runtime_overrides/manager.ts` (new)
- `packages/backend/src/index.ts` — instantiate and wire into signal-node setup
- `packages/shared/src/types.ts` — add new `WSMessageKind` variants
- `packages/frontend/src/store/editorStore.ts` — add `runtimeNodeOverrides`, `runtimeLayerOverrides` slices
- `packages/frontend/src/hooks/useWsSync.ts` — handle `runtime_override_*` messages
- `packages/frontend/src/components/editor/Viewport.tsx` — extend `useTransformWithOverride`
- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — extend `LayerView` merge

## Open items / unclear

- Whether the override bus is project-scoped or scene-scoped at the manager level (the plan keys by scene; confirm during implementation).
- Exact persistence-mode error semantics when the REST write fails (does the in-bus override roll back?).
