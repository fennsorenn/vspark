# Runtime Overrides

**Status: Implemented (Phase 1 of the signal-graph expansion).**

A backend bus that lets signal-graph nodes mutate scene-node and compose-layer params at runtime, transient by default with an opt-in persistent mode. Designed as a **parallel** surface to the existing track-clip override slots — same shape, separate slice — so the established playback path stays untouched.

## Motivation

Track clips animate fixed paramPaths along a timeline. Stream-overlay flows need *event-driven* mutations (set text content on a spawned billboard, jump opacity, set position once). These don't fit the clip model and shouldn't pollute SQLite for every transient change. The runtime overrides bus is the missing surface for graph-driven, mostly-ephemeral param writes.

## Architecture

**Backend:** `packages/backend/src/runtime_overrides/manager.ts`. The manager validates and coerces; the overrides themselves live in the mesh `runtime_override` collection (`packages/backend/src/mesh/runtime.ts`), one document per overridden path, keyed `${targetKind}:${targetId}:${paramPath}` and parented to the target. It holds no map of its own.

Public surface:

- `set(targetKind, targetId, paramPath, value, opts?: { persist?: boolean })` — validate against the paramPath registry, coerce, and commit the document. With `persist: true` the manager also calls the injected persist hook so the write reaches SQLite via the appropriate REST/manager path.
- `clear(targetKind, targetId, paramPath?)` — remove one document, or every document for a target.
- `clearAllForTarget(targetKind, targetId)` — convenience used by the spawn manager on cleanup.
- `registerTarget(targetId, sceneId)` — pre-registers a target's scene so subsequent `set` calls don't need to look it up in SQLite. The spawn manager calls this for ephemeral tmp ids that don't exist in the DB.

**Persist hook.** Initialised via `init({ persist })` from `packages/backend/src/index.ts`. The hook is currently injected as `null`; when `persist: true` is requested on a `set` call, the manager keeps the in-bus value and logs a warning. Implementing the hook (write-through to scene-nodes / compose-layers routes) is left as a follow-up; no graph or sample relies on it today.

**Transport.** One retained mesh channel, no WS kinds. See [mesh.md](mesh.md) for the channel; the short version:

- The `runtime` channel is reliable + stamped + **retained**, with **no ack**. Retained because an override is durable state — a tab that connects later must see the current value, which is what the deleted `runtime_override_snapshot` message used to arrange by hand. No ack because an acked write is a logged one, and a graph firing overrides would otherwise consume the user's undo stack.
- Containment parent is the target, so overrides ride the existing scene-subtree grants to collab peers and object-share subscribers. The `_share_override` envelope and the collab `runtime_control` tap that used to carry them are deleted.
- A clear is a document **remove**, including the whole-target form — which the receiver sees as one remove per path, not a single message with an optional `paramPath`.

**Frontend:** `editorStore.ts` exposes two parallel slices:

- `runtimeNodeOverrides: Record<nodeId, Partial<Record<paramPath, scalar>>>`
- `runtimeLayerOverrides: Record<layerId, Partial<Record<paramPath, scalar>>>`

Actions: `setRuntimeOverride`, `clearRuntimeOverride`. `sync/meshStoreFeeder.ts` drives them from the `runtime_override` collection — an upsert sets, a remove clears. On remove the target is parsed out of the document id, since there is no document left to read it from.

## Read paths

**Scene node** — `Viewport.tsx` `useTransformWithOverride(node)` merges both override sources:

- `position`, `rotation`, `scale` axes and `opacity` — **clip override beats runtime override** when both are present (in-progress clips are not interrupted by a stale runtime write).
- For paths only ever written by the runtime bus (`text.content`), the runtime override is the only source.

Opacity application uses the new `useApplyOpacity(groupRef, opacity)` hook (per-frame mesh walk; see [scene-graph.md](scene-graph.md) for the per-material cache + transparent-flag restore).

**Compose layer** — `ComposeLayerStack.LayerView` merges `runtimeLayerOverrides[layer.id]` into `layerStyle` alongside `composeLayerOverrides`. Same conflict policy: clip wins for scalar/transform overlap; runtime is the only surface for `text.content`.

## Open behaviours (chosen)

- **Scope.** An override is addressed to its target, not to a scene: the document's containment parent is the entity, and the scene falls out of that entity's own parent chain. The manager still resolves a scene id, but only to refuse an override on an entity that is in no scene.
- **Persist-mode failure.** If `persist: true` is requested but the write-through path fails (or the hook isn't wired), the in-bus value is kept and a `console.warn` is logged. No automatic rollback — logic that need a persisted edit should treat this as best-effort.

## Cross-references

- [paramPaths.md](paramPaths.md) — the override bus uses the shared registry to type each `(targetKind, targetId, paramPath)` slot.
- [track-clips.md](track-clips.md) — track-clip overrides live in `nodeTransformOverrides` / `composeLayerOverrides`. Runtime overrides are a separate, parallel layer. Conflict resolution: track-clip wins for transform/scalar overlap.
- [signal-graph.md](signal-graph.md) — `set_scene_node_param`, `set_compose_layer_param`, and `set_text` are the producers writing into this bus.
- [spawn.md](spawn.md) — `spawn_clip` pre-registers tmp targets via `registerTarget(...)` so subsequent set-param calls against the tmp id don't try to resolve the scene out of SQLite.

## Files

- `packages/backend/src/runtime_overrides/manager.ts` — manager
- `packages/backend/src/index.ts` — `init({ persist: null })` at boot; passed into signal-node setup
- `packages/backend/src/mesh/runtime.ts` — the `runtime` channel + the `runtime_override` collection, keying and containment
- `packages/frontend/src/store/editorStore.ts` — `runtimeNodeOverrides`, `runtimeLayerOverrides` slices + actions
- `packages/frontend/src/sync/meshStoreFeeder.ts` — the `runtime_override` observer
- `packages/frontend/src/mesh/peer.ts` — the tab's channel + rtype registration
- `packages/frontend/src/components/editor/Viewport.tsx` — `useTransformWithOverride`, `useApplyOpacity`
- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — `LayerView` merge
