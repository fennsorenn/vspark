# Param Path Registry

**Status: WIP — Phase 1 of the signal-graph expansion (branch `feature/graph-runtime-overrides-spawn-text`).**

A shared enumeration of which `paramPath`s are valid per target kind, together with the value type of each (`Float | String | Bool`). Lives in `packages/shared/src/paramPaths.ts` (new) so both backend and frontend agree on what is animatable / overridable and what type a path's value carries.

## Why a registry

Before this change, valid paramPaths were implicit: the track-clip evaluator hardcoded `position.{x,y,z}`, `rotation.{x,y,z}`, `scale.{x,y,z}` for scene nodes and `x`, `y`, `rotation` for compose layers. With Phase 1 adding non-scalar paths (`text.content`, `opacity` for both kinds; `width`, `height` for compose layers) and a runtime overrides bus that mutates them from the graph, three consumers now need to know the type of a path:

1. **Track-clip evaluator** (`trackClipEvaluator.ts`) — to validate Float paths and reject animating a string field.
2. **`set_scene_node_param` / `set_compose_layer_param` / `set_text` signal nodes** — to validate paths at fire time and coerce the `value: Any` input into the declared type (until Phase 2 inference replaces the Any port).
3. **Runtime overrides bus** — to know whether a value is a transform / opacity / text / etc. for routing and serialisation.

A single shared registry removes the inconsistencies these three would otherwise drift into.

## Initial entries

**Scene node:**
- Existing: `position.{x,y,z}`, `rotation.{x,y,z}`, `scale.{x,y,z}` — all `Float`.
- New: `opacity` (Float, default 1; added to `components.transform`), `text.content` (String, only valid on `text_troika` / `text_canvas` kinds).

**Compose layer:**
- Existing: `x`, `y`, `rotation` — `Float`.
- New: `opacity` (Float), `width` (Float), `height` (Float), `text.content` (String, only valid on `text` kind).

## Cross-references

- [track-clips.md](track-clips.md) — track-clip lane validation consults this registry; the existing `param_path` enumeration in [data model](track-clips.md#data-model-migration-009) becomes a subset of the registry. Track clips remain scalar-only (Float), so non-scalar registry entries are excluded from lane creation.
- [runtime-overrides.md](runtime-overrides.md) — override bus uses this registry to type each `(targetKind, targetId, paramPath)` slot.
- [signal-graph.md](signal-graph.md) — `set_*_param` nodes consult this registry at fire time for coercion. Phase 2 inference will derive the `value` port's `ResolvedType` from the registry automatically.
- [scene-graph.md](scene-graph.md) — `opacity` and the new `text_*` kinds drive new registry entries.
- [compose.md](compose.md) — `text` layer kind and the new compose paramPaths.

## Out of scope

- Animating non-scalar params (vector, color) — the registry stays scalar-only.
- Persisting registry state — it is code, not data.

## Files (planned/in-progress)

- `packages/shared/src/paramPaths.ts` (new)
- Consumers: track-clip evaluator, signal `set_*_param` nodes, runtime overrides bus.
