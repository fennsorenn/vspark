# Spawn Manager

**Status: WIP — Phase 1 of the signal-graph expansion (branch `feature/graph-runtime-overrides-spawn-text`).**

Ephemeral clip-clone spawning. Lets a signal graph trigger an *instance* of a node/layer + a clip on it, play once, then disappear — without writing anything to SQLite. Designed for stream-overlay flows: a chat message spawns a flying billboard, plays a position-animation clip, despawns when the clip completes.

## Semantics

`spawn_clip(clipId)`:
1. Look up the clip and its owner (the scene node or compose layer whose params the clip's lanes target).
2. Deep-clone the owner with a fresh tmp id. **The clone is always unhidden** even if the source was hidden — hidden templates are the canonical pattern for "this only exists to be spawned".
3. Duplicate the clip with its lane `target_id`s remapped to the tmp id.
4. Start the duplicated clip.
5. On clip completion (`clipFinished` event from `TrackClipPlaybackManager`), clean up: stop and remove the tmp clip, remove the tmp entity.

The `spawn_clip` node emits a `spawned: Event<SpawnRef>` event after step 4, payload `{ tmpNodeId, tmpClipId, kind: 'scene_node' | 'compose_layer' }`. Downstream `set_*_param` nodes can wire this event into their optional `spawnRef` input to address the spawned instance for that fire (overriding `targetId`).

## Architecture

**Backend:** `packages/backend/src/spawn/manager.ts` (new).

- Owns the in-memory map of active spawns by `tmpId`.
- Listens to `clipFinished` events from `TrackClipPlaybackManager` (a new emission added to `track_clips/playback.ts` — today only `stopTimer` fires). Cleans up on completion.
- Publishes tmp entities to the frontend via:
  - New WS messages: `tmp_entity_added`, `tmp_entity_removed` (carrying the cloned entity shape).
  - The runtime overrides bus for any initial-state overrides set by downstream `set_*_param` nodes in the same event chain.

**Persistence:** none. Tmp entities and tmp clips are in-memory only; nothing reaches SQLite. This is intentional — they are ephemeral by design.

## Frontend

- `editorStore.ts` gains a tmp-entity slice parallel to the persistent scene-node / compose-layer slices.
- `useWsSync.ts` handles `tmp_entity_added` / `tmp_entity_removed`.
- `Viewport.tsx` renders tmp scene-nodes through the same code path as persistent ones, reading transform from the merged override + base.
- `ComposeLayerStack.tsx` similarly renders tmp compose layers.

Existing override application paths (track-clip + runtime overrides) already operate on `targetId` and will work transparently against tmp ids.

## Cross-references

- [track-clips.md](track-clips.md) — playback depends on the new `clipFinished` emission for cleanup. Lane target remapping reuses the existing lane shape.
- [runtime-overrides.md](runtime-overrides.md) — `set_*_param` writes during a spawn flow land in the same override bus and apply to the tmp id.
- [signal-graph.md](signal-graph.md) — `spawn_clip` is the producer node; `SpawnRef` is the named type carrying the tmp ids out to downstream consumers.
- [scene-graph.md](scene-graph.md) — tmp scene nodes use the same node kinds and renderers as persistent nodes.

## Files (planned/in-progress)

- `packages/backend/src/spawn/manager.ts` (new)
- `packages/backend/src/signal/nodes/spawn_clip.ts` (new)
- `packages/backend/src/track_clips/playback.ts` — add `clipFinished` event emission
- `packages/backend/src/index.ts` — instantiate and wire into the signal-node setup
- `packages/shared/src/types.ts` — add `WSMessageKind` variants
- `packages/shared/src/signal.ts` — add `SpawnRef` to `SignalTypeMap`
- Frontend store / `useWsSync.ts` / `Viewport.tsx` / `ComposeLayerStack.tsx` — render tmp entities

## Out of scope

- Persisting tmp entities beyond their lifetime — explicitly *not* a feature.
- Spawning arbitrary entities from scratch — only clone-from-clip-owner is supported.
- Cross-graph events / pub-sub — each graph remains isolated.
