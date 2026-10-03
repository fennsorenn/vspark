# Spawn Manager

**Status: Implemented (Phase 1 of the signal-graph expansion).**

Ephemeral clip-clone spawning. Lets a signal graph trigger an *instance* of a node/layer + a clip on it, play once, then disappear — without writing anything to SQLite. Designed for stream-overlay flows: a chat message spawns a flying billboard, plays a position-animation clip, despawns when the clip completes.

## Semantics

`spawn_clip(clipId)`:

1. Look up the clip and its owner (the scene node or compose layer whose params the clip's lanes target).
2. Deep-clone the owner in memory with a fresh tmp id of the form `__spawn:<uuid>`. **The clone is always unhidden** even if the source was hidden — hidden templates are the canonical pattern for "this only exists to be spawned".
3. Broadcast the tmp entity to clients using the existing CRUD WS messages: `node_added` for a scene-node clone, `compose_layer_added` for a compose-layer clone. From the frontend's perspective a spawned entity is just another node/layer with an odd id — no separate code path.
4. Duplicate the clip with its lane `target_id`s remapped to the tmp id; broadcast `track_clip_added` for the duplicated clip. Event-marker lane entries (`track_clip_events`) are cloned + retargeted alongside the lanes so a spawned clip's timed media commands address the spawned instance. See [track-clips.md](track-clips.md) and [media.md](media.md).
5. Register the clone's duration with `setEphemeralDuration(tmpClipId, duration)` and start it with `triggerClip(tmpClipId, loop)`. Nothing about a spawned clip reaches SQLite: the transport state is a `clip_playback` document like any other clip's, and the duration is registered in memory because there is no `track_clips` row to read it from.
6. Pre-register the tmp target's scene with `runtimeOverrideManager.registerTarget(...)` so any `set_*_param` call routed against the tmp id during the same event chain can resolve a `sceneId` without hitting SQLite (where the tmp id doesn't exist).

The `spawn_clip` node emits a `spawned: Event<SpawnRef>` event after step 5 with payload `{ tmpNodeId, tmpClipId, kind: 'scene_node' | 'compose_layer' }`. Downstream `set_*_param`, `set_text`, and `media_control` nodes can wire this event into their optional `spawnRef` input to address the spawned instance for that fire (overriding `targetId`, and for `set_text` overriding `targetKind`). See [media.md](media.md).

## Cleanup

The spawn manager subscribes via `onClipFinished(listener)` (see [track-clips.md](track-clips.md)). When a tracked tmp clip finishes:

- Broadcast `track_clip_removed` for the tmp clip.
- Broadcast `node_removed` or `compose_layer_removed` for the tmp entity.
- Clear all runtime overrides keyed on the tmp id via `runtimeOverrideManager.clearAllForTarget(...)`.

## Architecture

**Backend:** `packages/backend/src/spawn/manager.ts`.

- Owns the in-memory map of active spawns by `tmpId`.
- Subscribes to `onClipFinished` for cleanup.
- Persistence: none. Tmp entities and tmp clips are in-memory only; nothing reaches SQLite. This is intentional — they are ephemeral by design.

**Clip lifecycle** (`packages/backend/src/track_clips/lifecycle.ts`) — the module functions that replaced the old `TrackClipPlaybackManager` once the playhead became derived rather than owned:

- `onClipFinished(listener) -> unsubscribe` — listener registry.
- `setEphemeralDuration(clipId, duration)` / `clearEphemeralDuration(clipId)` — the duration of a clip with no `track_clips` row, which is the one thing about a spawned clone the documents cannot supply.
- `sweepFinished()` runs on a timer, computes each clip's playhead from its `clip_playback` document, stops the non-looping ones that have run past their duration, and fires the listeners. A looping clip never finishes.

## Frontend

No spawn-specific store slice. Tmp entities flow in over the existing `node_added` / `compose_layer_added` / `track_clip_added` messages, render through the same code paths as persistent entities, and pick up runtime overrides addressed to their tmp id transparently.

## Cross-references

- [track-clips.md](track-clips.md) — `onClipFinished` listener API + the derived-playhead transport a spawned clip plays on.
- [runtime-overrides.md](runtime-overrides.md) — `set_*_param` writes during a spawn flow land in this bus and apply to the tmp id; pre-registration via `registerTarget`.
- [signal-graph.md](signal-graph.md) — `spawn_clip` is the producer node; `SpawnRef` is the named type carrying the tmp ids out to downstream consumers.
- [scene-graph.md](scene-graph.md) / [compose.md](compose.md) — tmp entities reuse the same renderers as persistent ones.

## Files

- `packages/backend/src/spawn/manager.ts`
- `packages/backend/src/signal/nodes/spawn_clip.ts`
- `packages/backend/src/track_clips/lifecycle.ts` — `onClipFinished`, `setEphemeralDuration`, `sweepFinished`
- `packages/backend/src/track_clips/playbackDoc.ts` — `triggerClip` / `stopClip` write the `clip_playback` document
- `packages/backend/src/index.ts` — instantiates the spawn manager and wires it into signal-node setup
- `packages/shared/src/signal.ts` — `SpawnRef` added to `SignalTypeMap`, colour entry in `SIGNAL_TYPE_COLORS`

## Out of scope

- Persisting tmp entities beyond their lifetime — explicitly *not* a feature.
- Spawning arbitrary entities from scratch — only clone-from-clip-owner is supported.
- Cross-graph events / pub-sub — each graph remains isolated.
