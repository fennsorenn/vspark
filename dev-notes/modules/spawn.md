# Spawn Manager

**Status: Implemented (Phase 1 of the signal-graph expansion).**

Ephemeral clip-clone spawning. Lets a signal graph trigger an *instance* of a node/layer + a clip on it, play once, then disappear — without writing anything to SQLite. Designed for stream-overlay flows: a chat message spawns a flying billboard, plays a position-animation clip, despawns when the clip completes.

## Semantics

`spawn_clip(clipId)`:

1. Look up the clip and its owner (the scene node or compose layer whose params the clip's lanes target).
2. Deep-clone the owner in memory with a fresh tmp id of the form `__spawn:<uuid>`. **The clone is always unhidden** even if the source was hidden — hidden templates are the canonical pattern for "this only exists to be spawned".
3. Broadcast the tmp entity to clients using the existing CRUD WS messages: `node_added` for a scene-node clone, `compose_layer_added` for a compose-layer clone. From the frontend's perspective a spawned entity is just another node/layer with an odd id — no separate code path.
4. Duplicate the clip with its lane `target_id`s remapped to the tmp id; broadcast `track_clip_added` for the duplicated clip. Event-marker lane entries (`track_clip_events`) are cloned + retargeted alongside the lanes so a spawned clip's timed media commands address the spawned instance. See [track-clips.md](track-clips.md) and [media.md](media.md).
5. Call `TrackClipPlaybackManager.triggerEphemeral(tmpClipId, duration, loop)` (new) to play the duplicated clip without writing `started_at` to the DB.
6. Pre-register the tmp target's scene with `runtimeOverrideManager.registerTarget(...)` so any `set_*_param` call routed against the tmp id during the same event chain can resolve a `sceneId` without hitting SQLite (where the tmp id doesn't exist).

The `spawn_clip` node emits a `spawned: Event<SpawnRef>` event after step 5 with payload `{ tmpNodeId, tmpClipId, kind: 'scene_node' | 'compose_layer' }`. Downstream `set_*_param`, `set_text`, and `media_control` nodes can wire this event into their optional `spawnRef` input to address the spawned instance for that fire (overriding `targetId`, and for `set_text` overriding `targetKind`). See [media.md](media.md).

## Cleanup

The spawn manager subscribes via `TrackClipPlaybackManager.onClipFinished(listener)` (new — see [track-clips.md](track-clips.md)). When a tracked tmp clip finishes:

- Broadcast `track_clip_removed` for the tmp clip.
- Broadcast `node_removed` or `compose_layer_removed` for the tmp entity.
- Clear all runtime overrides keyed on the tmp id via `runtimeOverrideManager.clearAllForTarget(...)`.

## Architecture

**Backend:** `packages/backend/src/spawn/manager.ts`.

- Owns the in-memory map of active spawns by `tmpId`.
- Subscribes to `TrackClipPlaybackManager.onClipFinished` for cleanup.
- Persistence: none. Tmp entities and tmp clips are in-memory only; nothing reaches SQLite. This is intentional — they are ephemeral by design.

**Playback manager additions** (`packages/backend/src/track_clips/playback.ts`):

- `onClipFinished(listener) -> unsubscribe` — listener registry.
- `triggerEphemeral(clipId, duration, loop)` — starts playback without DB reads/writes (no `started_at` persistence, no `loop+autoplay` hydration logic).
- An internal `ephemeral: Set<clipId>`; `stopInternal` skips the `started_at` write for ids in the set and fires the `onClipFinished` listeners.

## Frontend

No spawn-specific store slice. Tmp entities flow in over the existing `node_added` / `compose_layer_added` / `track_clip_added` messages, render through the same code paths as persistent entities, and pick up runtime overrides addressed to their tmp id transparently.

## Cross-references

- [track-clips.md](track-clips.md) — `onClipFinished` listener API + `triggerEphemeral` mode + ephemeral set.
- [runtime-overrides.md](runtime-overrides.md) — `set_*_param` writes during a spawn flow land in this bus and apply to the tmp id; pre-registration via `registerTarget`.
- [signal-graph.md](signal-graph.md) — `spawn_clip` is the producer node; `SpawnRef` is the named type carrying the tmp ids out to downstream consumers.
- [scene-graph.md](scene-graph.md) / [compose.md](compose.md) — tmp entities reuse the same renderers as persistent ones.

## Files

- `packages/backend/src/spawn/manager.ts`
- `packages/backend/src/signal/nodes/spawn_clip.ts`
- `packages/backend/src/track_clips/playback.ts` — `onClipFinished`, `triggerEphemeral`, ephemeral set
- `packages/backend/src/index.ts` — instantiates the spawn manager and wires it into signal-node setup
- `packages/shared/src/signal.ts` — `SpawnRef` added to `SignalTypeMap`, colour entry in `SIGNAL_TYPE_COLORS`

## Out of scope

- Persisting tmp entities beyond their lifetime — explicitly *not* a feature.
- Spawning arbitrary entities from scratch — only clone-from-clip-owner is supported.
- Cross-graph events / pub-sub — each graph remains isolated.
