# Runtime Overrides

**Status: Implemented (Phase 1 of the signal-graph expansion).**

A backend bus that lets signal-graph nodes mutate scene-node and compose-layer params at runtime, transient by default with an opt-in persistent mode. Designed as a **parallel** surface to the existing track-clip override slots — same shape, separate slice — so the established playback path stays untouched.

## Motivation

Track clips animate fixed paramPaths along a timeline. Stream-overlay flows need *event-driven* mutations (set text content on a spawned billboard, jump opacity, set position once). These don't fit the clip model and shouldn't pollute SQLite for every transient change. The runtime overrides bus is the missing surface for graph-driven, mostly-ephemeral param writes.

## Architecture

**Backend:** `packages/backend/src/runtime_overrides/manager.ts`. **Scene-scoped** — the in-memory map is keyed first by `sceneId` and within that by `(targetKind, targetId, paramPath)`. Mirrors `broadcastBus` conceptually.

Public surface:

- `set(targetKind, targetId, paramPath, value, opts?: { persist?: boolean })` — store in the in-memory bus, broadcast `runtime_override_set`. With `persist: true` the manager calls the injected persist hook so the write also reaches SQLite via the appropriate REST/manager path.
- `clear(targetKind, targetId, paramPath?)` — clear one path or all paths for a target; broadcasts `runtime_override_clear`.
- `clearAllForTarget(targetKind, targetId)` — convenience used by the spawn manager on cleanup.
- `registerTarget(sceneId, targetKind, targetId)` — pre-registers a target's scene so subsequent `set` calls don't need to look it up in SQLite. The spawn manager calls this for ephemeral tmp ids that don't exist in the DB.
- `sendSnapshotTo(ws)` — emits `runtime_override_snapshot` on client connect, mirroring the track-clip snapshot pattern.

**Persist hook.** Initialised via `init({ persist })` from `packages/backend/src/index.ts`. The hook is currently injected as `null`; when `persist: true` is requested on a `set` call, the manager keeps the in-bus value and logs a warning. Implementing the hook (write-through to scene-nodes / compose-layers routes) is left as a follow-up; no graph or sample relies on it today.

**WS messages** (in `WSMessageKind`):

- `runtime_override_set { sceneId, targetKind, targetId, paramPath, value }`
- `runtime_override_clear { sceneId, targetKind, targetId, paramPath? }`
- `runtime_override_snapshot { entries }` — sent on client connect.

**Frontend:** `editorStore.ts` exposes two parallel slices:

- `runtimeNodeOverrides: Record<nodeId, Partial<Record<paramPath, scalar>>>`
- `runtimeLayerOverrides: Record<layerId, Partial<Record<paramPath, scalar>>>`

Actions: `setRuntimeOverride`, `clearRuntimeOverride`, `replaceRuntimeOverrides` (snapshot replace). `useWsSync.ts` dispatches the three new WS message kinds into these actions.

## Read paths

**Scene node** — `Viewport.tsx` `useTransformWithOverride(node)` merges both override sources:

- `position`, `rotation`, `scale` axes and `opacity` — **clip override beats runtime override** when both are present (in-progress clips are not interrupted by a stale runtime write).
- For paths only ever written by the runtime bus (`text.content`), the runtime override is the only source.

Opacity application uses the new `useApplyOpacity(groupRef, opacity)` hook (per-frame mesh walk; see [scene-graph.md](scene-graph.md) for the per-material cache + transparent-flag restore).

**Compose layer** — `ComposeLayerStack.LayerView` merges `runtimeLayerOverrides[layer.id]` into `layerStyle` alongside `composeLayerOverrides`. Same conflict policy: clip wins for scalar/transform overlap; runtime is the only surface for `text.content`.

## Open behaviours (chosen)

- **Scope.** Scene-scoped at the manager level. All set/clear/snapshot operations carry `sceneId`.
- **Persist-mode failure.** If `persist: true` is requested but the write-through path fails (or the hook isn't wired), the in-bus value is kept and a `console.warn` is logged. No automatic rollback — graphs that need a persisted edit should treat this as best-effort.

## Cross-references

- [paramPaths.md](paramPaths.md) — the override bus uses the shared registry to type each `(targetKind, targetId, paramPath)` slot.
- [track-clips.md](track-clips.md) — track-clip overrides live in `nodeTransformOverrides` / `composeLayerOverrides`. Runtime overrides are a separate, parallel layer. Conflict resolution: track-clip wins for transform/scalar overlap.
- [signal-graph.md](signal-graph.md) — `set_scene_node_param`, `set_compose_layer_param`, and `set_text` are the producers writing into this bus.
- [spawn.md](spawn.md) — `spawn_clip` pre-registers tmp targets via `registerTarget(...)` so subsequent set-param calls against the tmp id don't try to resolve the scene out of SQLite.

## Files

- `packages/backend/src/runtime_overrides/manager.ts` — manager
- `packages/backend/src/index.ts` — `init({ persist: null })` at boot; passed into signal-node setup
- `packages/shared/src/types.ts` — `runtime_override_set/clear/snapshot` `WSMessageKind` variants
- `packages/frontend/src/store/editorStore.ts` — `runtimeNodeOverrides`, `runtimeLayerOverrides` slices + actions
- `packages/frontend/src/hooks/useWsSync.ts` — handlers
- `packages/frontend/src/components/editor/Viewport.tsx` — `useTransformWithOverride`, `useApplyOpacity`
- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — `LayerView` merge
