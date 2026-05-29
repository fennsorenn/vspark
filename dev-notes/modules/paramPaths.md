# Param Path Registry

**Status: Implemented (Phase 1 of the signal-graph expansion).**

A shared enumeration of which `paramPath`s are valid per target kind, together with the value type of each (`Float | String | Bool`). Lives in `packages/shared/src/paramPaths.ts` and is re-exported via the `./paramPaths` subpath of the `@vspark/shared` package so both backend and frontend agree on what is animatable / overridable and what type a path's value carries.

## Shape

```ts
type ParamPathEntry = {
  type: 'Float' | 'String' | 'Bool'
  defaultValue: number | string | boolean
  animatable: boolean       // false → excluded from track-clip lane creation (e.g. text.content)
  kinds?: readonly string[] // optional: restrict to specific scene-node / compose-layer kinds
}

// Registry keyed by (target_kind, paramPath) → ParamPathEntry
```

A `coerceParamValue(entry, raw)` helper is exported alongside the registry; it normalises an `Any` input into the declared type (used by the `set_*_param` and `set_text` signal nodes until Phase 2 inference replaces the `Any` value port).

## Why a registry

Before this change, valid paramPaths were implicit: the track-clip evaluator hardcoded `position.{x,y,z}`, `rotation.{x,y,z}`, `scale.{x,y,z}` for scene nodes and `x`, `y`, `rotation` for compose layers. Phase 1 added non-scalar paths (`text.content`, `opacity` for both kinds; `width`, `height` for compose layers) plus a runtime-override bus that mutates them from the graph, so three consumers need to agree on the type of a path:

1. **Track-clip evaluator** (`trackClipEvaluator.ts`) — validates Float paths and rejects animating a String/Bool field.
2. **`set_scene_node_param` / `set_compose_layer_param` / `set_text` signal nodes** — validate the path at fire time and coerce the `value: Any` input into the declared type via `coerceParamValue`.
3. **Runtime overrides bus** — knows whether a value is transform / opacity / text / etc. for routing.

## Entries

**Scene node** (`target_kind: 'scene_node'`):
- `position.x|y|z`, `rotation.x|y|z` (radians), `scale.x|y|z` — `Float`, animatable.
- `opacity` — `Float`, default 1, animatable. Lives on `components.transform.opacity`.
- `text.content` — `String`, default `''`, **not animatable**. Restricted to `kinds: ['text_troika', 'text_canvas']`.

**Compose layer** (`target_kind: 'compose_layer'`):
- `x`, `y`, `rotation` — `Float`, animatable.
- `opacity`, `width`, `height` — `Float`, animatable.
- `text.content` — `String`, default `''`, **not animatable**. Restricted to `kinds: ['text']`.

## Cross-references

- [track-clips.md](track-clips.md) — lane creation excludes entries with `animatable: false`; the evaluator's compose-layer write path now uses a `readComposeParam`/`writeComposeParam` table covering `x/y/rotation/width/height/opacity`.
- [runtime-overrides.md](runtime-overrides.md) — override bus types each `(targetKind, targetId, paramPath)` slot via this registry.
- [signal-graph.md](signal-graph.md) — `set_*_param` and `set_text` nodes consult the registry at fire time for coercion. Phase 2 inference will derive the `value` port's `ResolvedType` from the registry automatically.
- [scene-graph.md](scene-graph.md) — `opacity` and the new `text_troika`/`text_canvas` kinds drive new registry entries.
- [compose.md](compose.md) — `text` layer kind and the new compose paramPaths.

## Out of scope

- Animating non-scalar params (vector, color) — the registry stays scalar-only.
- Persisting registry state — it is code, not data.

## Files

- `packages/shared/src/paramPaths.ts` — registry + `coerceParamValue`
- `packages/shared/package.json` — exposes the `./paramPaths` subpath export
- Consumers: `packages/frontend/src/components/editor/trackClipEvaluator.ts`, `packages/backend/src/signal/nodes/{set_scene_node_param,set_compose_layer_param,set_text}.ts`, `packages/backend/src/runtime_overrides/manager.ts`
