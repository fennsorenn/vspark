# Track Clips

**Status: Implemented.**

> **Event/marker lane (implemented).** Besides scalar keyframe lanes, a clip carries
> discrete timed **event markers** (`track_clip_events` table, migration 021) that
> fire fire-and-forget media commands at marker times, dispatched client-side to the
> media registry. See [Event/Marker Lane](#eventmarker-lane) below and [media.md](media.md).

Timeline-based parameter animation. A **track clip** is a short, triggerable, optionally-looping clip that animates scalar parameters on scene nodes or compose layers. Authored in the bottom-dock tab whose `bottomTab` id is `'clips'` (UI label is **Timeline** after the vocab rename; the tab-id string was kept); played back with a backend-authoritative playhead so multiple clients (editor + `ViewerPage`) stay in sync. Supports play / pause / resume / stop / seek (scrub).

## How this differs from `animation_clips`

The existing `animation_clips` table is FBX-bone-only — load-once and played through a Three.js `AnimationMixer` (see [animation.md](animation.md)). Track clips are a separate concept and a separate table:

| | `animation_clips` (FBX) | `track_clips` |
|---|---|---|
| Source | Imported FBX/BVH | Authored in the editor timeline |
| Targets | Whole VRM skeleton via retargeting | Scalar params on scene nodes / compose layers |
| Runtime | `AnimationMixer` (Three.js) | rAF loop in `useTrackClipEvaluator` |
| Storage | Asset file + retargeted tracks | Keyframes per lane in SQLite |

The two systems coexist; they do not share storage or playback.

## Data Model (migration 009)

Three scene-scoped tables:

```
track_clips
  id, scene_id, name, duration (s), loop, mode ('override' | 'relative'),
  autoplay, started_at (nullable epoch ms, persisted only for autoplay+loop+playing),
  created_at

track_clip_lanes
  id, clip_id, target_kind ('scene_node' | 'compose_layer'),
  target_id, param_path, default_value

track_clip_keyframes
  id, lane_id, t (s from clip start), value, easing ('linear' | 'step' | 'bezier'),
  in_handle_t, in_handle_v, out_handle_t, out_handle_v (bezier only, nullable)
```

Each lane is a single scalar. The UI groups three sibling lanes (`position.x/y/z`, etc.) into a collapsible row.

**Supported `param_path` values** (Phase 1 — sourced from the shared paramPath registry, scalar/animatable entries only; see [paramPaths.md](paramPaths.md)):

- Scene node: `position.x|y|z`, `rotation.x|y|z` (radians), `scale.x|y|z`, `opacity`.
- Compose layer: `x`, `y`, `rotation`, `width`, `height`, `opacity`.

Non-scalar registry entries (e.g. `text.content`) are excluded from lane creation — they are runtime-override-only.

**Phase 1 additions (signal-graph expansion) — implemented:**

- New animatable paramPaths: `opacity` on both target kinds; `width`, `height` on compose layers. The evaluator's `NodeAccumulator` now carries `opacity`, and `readNodeParam`/`writeNodeParam` handle `opacity` for `scene_node`. The compose-layer write path was refactored from a hardcoded `x`/`y`/`rotation` switch into a `readComposeParam` / `writeComposeParam` table covering `x/y/rotation/width/height/opacity` — adding a future scalar compose paramPath is one table entry.
- `TrackClipPlaybackManager.onClipFinished(listener)` listener registry; the spawn manager subscribes to it for tmp-entity cleanup.
- `TrackClipPlaybackManager.triggerEphemeral(clipId, duration, loop)`: plays a clip without DB reads or `started_at` writes; the manager tracks an internal `ephemeral: Set<clipId>` so `stopInternal` skips persistence and fires the `onClipFinished` listeners for ephemeral entries. Used by `spawn_clip`. See [spawn.md](spawn.md).
- New canonical `start_clip` signal node generalises `track_clip_trigger` (existing kind retained for back-compat).

**Easing kinds:** `linear`, `step`, `bezier` (per-keyframe outgoing-segment easing; bezier uses the four handle fields).

Shared types (`TrackClip`, `TrackClipLane`, `TrackClipKeyframe`, `TrackClipMode`, `TargetKind`, `Easing`, `TrackClipPlaybackEntry`) live in `packages/shared/src/types.ts`; Zod schemas in `schema.ts`.

## Playback State Model

Playback state per clip is a discriminated union, used identically on both backend (`packages/backend/src/track_clips/playback.ts`) and frontend (`TrackClipPlayback` in `packages/frontend/src/store/editorStore.ts`):

```
{ kind: 'playing', startedAt: number }   // epoch ms anchor; t = (now - startedAt) / 1000
{ kind: 'paused',  pausedAtT: number }   // frozen seconds-from-clip-start
```

Both states flow through `track_clip_playback_snapshot` so late-joining clients pick up paused clips too. The snapshot entry carries either `startedAt` or `pausedAtT`; the snapshot is no longer always-`startedAt`.

## Playback Authority

`TrackClipPlaybackManager` (`packages/backend/src/track_clips/playback.ts`, wired in `index.ts` and exposed via `routes/shared.ts` as `_trackClipPlayback`) is the single source of truth for "what is playing/paused right now". It owns only the playhead anchor — **it does not evaluate keyframes**; clients do that locally. Public surface: `trigger / stop / pause / resume / seek / hydrateAutoplay / sendSnapshotTo / onClipUpdated / onClipDeleted / onClipFinished / triggerEphemeral`. The last two are Phase-1 additions for the spawn flow — see [spawn.md](spawn.md).

In-memory map: `Map<clipId, PlaybackEntry>` where the entry is the discriminated union above (plus `loop`, `sceneId`).

### Operations

**`trigger(clipId)`** (start from stopped):
1. Set entry to `{ kind: 'playing', startedAt: Date.now() }`.
2. Broadcast `track_clip_started { clipId, startedAt, serverNow }` — clients compute a one-shot clock offset.
3. If `loop && autoplay`, persist `started_at` to the DB so the loop resumes in-phase after a backend restart.
4. If non-looping, schedule an auto-stop timer for `duration` ms; on fire, broadcast `track_clip_stopped`.

**`pause(clipId)`**: freezes wall-clock advancement at the current playhead, wrapping into `[0, duration)` for looping clips. Clears any auto-stop timer. Broadcasts `track_clip_paused { clipId, pausedAtT, serverNow }`. Does **not** persist anything — paused state is ephemeral; only `loop+autoplay+playing` persists `started_at`.

**`resume(clipId)`**: re-anchors `startedAt = Date.now() − pausedAtT*1000` so elapsed time picks up where it left off. Reinstates the auto-stop timer for non-looping clips with the remaining duration. Broadcasts `track_clip_started`.

**`seek(clipId, t)`**: clamps/wraps `t` to clip duration.
- If playing: shifts `startedAt` so elapsed equals `t`, resets the auto-stop timer, broadcasts `track_clip_started`.
- If paused (or no entry exists yet): creates/updates a paused entry at `t`, broadcasts `track_clip_paused`. So a clip that has never been played can be scrubbed and shows up as paused at the scrubbed time.

**`stop(clipId)`**: clear the in-memory entry, broadcast `track_clip_stopped`, clear any persisted `started_at`.

**On backend boot:** load every `loop=1 AND autoplay=1` clip. If `started_at` is null, set it to `Date.now()` and persist. Insert into the map as `{ kind: 'playing', startedAt }`.

**Late-joiner sync:** `wsSync.onClientConnected` fires `sendSnapshotTo`, which delivers `track_clip_playback_snapshot { entries, serverNow }` where each entry contains its `clipId`, `loop`, and either `startedAt` or `pausedAtT`.

## Trigger Surfaces

A clip can be started/controlled from:

1. **Editor UI** — transport buttons in `TrackClipTimeline` (play / pause / resume / stop) and the `ScrubRuler` for seek.
2. **REST** — see below.
3. **Signal graph** — node kind `track_clip_trigger`, event input `fire`, config `clipId`. Registered in `packages/backend/src/signal/registry.ts`. Lets VMC events, the API controller, or any other graph drive clips. See [signal-graph.md](signal-graph.md).

All paths go through `TrackClipPlaybackManager`.

## REST Routes

`packages/backend/src/routes/track-clips.ts`:

- `GET    /scenes/:sceneId/track-clips` — list (clips + lanes + keyframes)
- `POST   /scenes/:sceneId/track-clips`
- `PUT    /track-clips/:id` — patch clip-level fields
- `DELETE /track-clips/:id`
- `POST   /track-clips/:id/lanes`
- `PUT    /track-clip-lanes/:id`
- `DELETE /track-clip-lanes/:id`
- `PUT    /track-clip-lanes/:id/keyframes` — bulk replace (drag-then-commit on `pointerup`)
- `POST   /track-clips/:id/trigger`
- `POST   /track-clips/:id/stop`
- `POST   /track-clips/:id/pause`
- `POST   /track-clips/:id/resume`
- `POST   /track-clips/:id/seek` — body `{ t: number }`

The scene-bundle endpoint includes `trackClips` so the editor hydrates everything in one request.

## WS Messages

In `WSMessageKind`:

`track_clip_added`, `track_clip_updated`, `track_clip_removed`, `track_clip_lane_added`, `track_clip_lane_updated`, `track_clip_lane_removed`, `track_clip_keyframes_replaced`, `track_clip_events_replaced`, `track_clip_started`, `track_clip_stopped`, `track_clip_paused`, `track_clip_playback_snapshot`.

Handled in `packages/frontend/src/hooks/useWsSync.ts` following the compose-layer pattern. The snapshot handler reads either `startedAt` or `pausedAtT` per entry.

**Clip create/delete now flow through the sync layer** — `sync.document.upsert`/`remove` for rtype `track_clip` on the single `'sync'` WS kind — instead of the bespoke `track_clip_added`/`track_clip_removed` kinds for persistent clips. The legacy `track_clip_added`/`removed` handlers are kept because the spawn manager still emits them inline for ephemeral spawned clips. Lanes, keyframes, events, and playback messages above stay on their legacy kinds. See [sync.md](sync.md) and [spawn.md](spawn.md).

## Frontend Evaluator

`packages/frontend/src/hooks/useTrackClipEvaluator.ts` is mounted in both `Editor.tsx` and `ViewerPage.tsx`.

Per rAF tick, for each entry in `trackClipPlayback`:

1. Compute `t`:
   - `kind: 'playing'` → `t = ((Date.now() - clockOffsetMs) - startedAt) / 1000`, then `resolveClipTime` either modulos by duration (loop) or clamps (non-loop).
   - `kind: 'paused'` → `t = pausedAtT` (wall clock is not advanced). The evaluator still re-evaluates every tick so edits to lanes / keyframes / handles while paused take effect immediately. Paused clips do **not** complete — non-looping clips won't auto-clear while paused.
2. For each lane, `evaluateLane` finds the bracketing keyframes and interpolates (linear / step / cubic-bezier with root-finding on the X handle). Pure interpolation utilities live in `components/editor/trackClipEvaluator.ts`.
3. Compose an **absolute** target value and write it into one of two override maps in the Zustand store. For `relative` clips the evaluator pre-folds the base in (`base + (raw − lane.defaultValue)`) so consumers always just *replace* with the override.
4. When a playing non-looping clip's `t` reaches the clamp end, the evaluator clears it from `trackClipPlayback`.

**Override slots in the store** (both ephemeral, never persisted):

- `nodeTransformOverrides: Record<nodeId, Partial<{ position:{x,y,z}, rotation:{x,y,z}, scale:{x,y,z}, opacity:number }>>`
- `composeLayerOverrides: Record<layerId, Partial<{ x, y, rotation, width, height, opacity }>>`

**Application** (no direct Three.js mutation):

- **Scene node** — `Viewport.tsx` defines `useTransformWithOverride(node)`, which subscribes per-node to its slot in `nodeTransformOverrides` and merges with the persisted transform. All `getTransform(node)` sites go through this hook. Per-node subscription keeps re-render scope tight.
- **Compose layer** — `ComposeLayerStack.LayerView` subscribes per-layer to `composeLayerOverrides[layer.id]` and merges into `layerStyle`. DOM-side. See [compose.md](compose.md).

When a clip stops or is cleared, the override entries go away and the target snaps back to its persisted base. Paused clips keep their override applied at the frozen `t`.

**Edge cases handled:**
- Loop boundary (modulo in `resolveClipTime`).
- Cross-client clock drift via the one-shot `clockOffsetMs`.
- Targets deleted mid-playback: skipped.
- Bezier handles outside the segment: root-finder clamps without breaking monotonicity.
- Pause: no auto-complete, no wall-clock advancement, but full lane re-evaluation each frame.

## Event/Marker Lane

A second lane *flavour* carrying **discrete timed markers** instead of interpolated
scalar keyframes. Markers fire fire-and-forget **media commands** (play/pause/stop/
restart/seek/setVolume/mute) at a given playhead `t`, dispatched client-side to the
media registry. Distinct from the scalar lanes — it reuses none of their evaluator.
Full media model in [media.md](media.md).

**DB — migration 021 (`track_clip_events`):** flat per-clip table
`track_clip_events (id, clip_id, t, action, target_kind, target_id, payload)`,
`ON DELETE CASCADE` on clip delete, indexed `(clip_id, t)`. Registered in
`db/index.ts`. A flat per-clip table (rather than per-lane) keeps the scalar lane
evaluator untouched.

**Shared:** `TrackClipEvent { id, t, action, targetKind, targetId, payload }`
(`action: MediaAction`, `targetKind: MediaTargetKind`); `TrackClip.events`;
`WSMessageKind 'track_clip_events_replaced'`.

**Routes** (`routes/track-clips.ts`): events are loaded into the clip bundle
(`loadClip`/`mapClip`/`mapEvent`); bulk-replace endpoint
`PUT /track-clips/:id/events` broadcasts `track_clip_events_replaced` (mirrors the
keyframe bulk-replace). `spawn/manager.ts` clones + retargets event markers when
spawning a clip (see [spawn.md](spawn.md)).

**Evaluator** (`useTrackClipEvaluator.ts`): a module-level `lastTByClip` map plus a
`crossedMarker(prevT, t, markerT, duration, loop)` helper fire each marker once when
the playhead crosses it. **Playing-only** (paused clips don't fire); the helper
handles loop wrap so a marker re-arms each loop. Crossed markers dispatch via
`dispatchMediaCommand`. `lastTByClip` is cleared when nothing is playing and the
per-clip entry deleted on stop, so markers don't double-fire on pause / scrub.

**UI** (`TrackClipTimeline.tsx`): an `EventLane` — a marker strip on the ruler plus a
list editor — targeting video/audio scene nodes and video compose layers.
`ClipsSection` copy/paste carries events.

**Presets:** preset serialize/deserialize round-trip the event/marker lane alongside
scalar lanes/keyframes — `serialize.ts`'s `serializeClipEvents()` emits an `events`
array per clip (with `targetPresetId` remapped like lanes) and `deserialize.ts`
premints event presetIds and inserts `track_clip_events` rows. See [presets.md](presets.md).

## Frontend Recorder

`packages/frontend/src/hooks/useTrackClipRecorder.ts` is the entry point for the "set keyframe" buttons in the Properties panel. Exposes:

- `canRecord` — true when the bottom dock is on the `'clips'` tab **and** a track clip is selected. Drives button visibility.
- `currentPlayhead()` — returns `pausedAtT` when the selected clip is paused, the live computed `t` when playing, or `0` when there is no playback entry. So keyframes record at wherever the timeline cursor sits, including a scrubbed-while-stopped position.
- Lazily finds-or-creates the lane (keyed on `targetKind + targetId + paramPath`, defaulting `defaultValue = current value`), then upserts a keyframe at the current playhead. Existing keyframes within ±1ms of the playhead are overwritten; otherwise a new linear keyframe is inserted and the lane is re-sorted.

## Authoring UI

Sixth tab `'clips'` in `packages/frontend/src/components/editor/AssetManager.tsx` mounts `<TrackClipTimeline />` in a flex-row layout (bypasses the standard padded scroll area). The bottom-dock active tab (`bottomTab: BottomDockTab`) has been lifted from `AssetManager.tsx` local state into the editor store, so other components (notably the Properties panel) can gate UI on which tab is open.

`packages/frontend/src/components/editor/TrackClipTimeline.tsx`:

- **Left column**: clip list with create / select / delete.
- **Right column**: timeline editor.
  - **Header**: name, duration, loop, autoplay (disabled unless `loop`), mode, and transport buttons.
    - Stopped → **▶ Play**
    - Playing → **❚❚ Pause** / **■ Stop**
    - Paused → **▶ Resume** / **■ Stop**
  - **`ScrubRuler`** row above the lanes: tick marks every 0.5s (1s if duration > 10s, 5s if > 30s), red playhead with arrow tip, draggable to seek. Works in all three states:
    - Stopped → seek creates a paused entry at the dragged `t`.
    - Playing → shifts the `startedAt` anchor.
    - Paused → moves the frozen playhead.
  - **Lane rows**: one per lane with a delete button; click-to-insert-keyframe, draggable dots, double-click to edit value, right-click to delete. A live red playhead is drawn through each row.
  - Both `ScrubRuler` and the per-lane playhead share a single `computePlayheadT` helper so they always agree.

Adding a lane pre-seeds the target dropdown from current selection (`selectedNodeId` → scene-node params; `selectedComposeLayerId` → compose-layer params).

Keyframe edits are optimistic during drag and persisted on `pointerup` via `PUT /track-clip-lanes/:id/keyframes` (bulk replace) — same pattern as compose-layer drags.

## Set-Keyframe Buttons (Properties Panel)

Each numeric input in the Properties panel gets a small **◆** button next to it; each group header (Position / Rotation / Scale; or x/y/rotation for compose layers) gets a **◆ set group** button that records all axes at once.

- Scene node transforms: `packages/frontend/src/components/editor/PropertiesPanel.tsx` (position / rotation / scale, all three axes each).
- Compose layers: `packages/frontend/src/components/editor/ComposeLayerProperties.tsx` (x / y / rotation).

**Visibility gating**: buttons render only when `useTrackClipRecorder().canRecord` is true — i.e. the bottom dock is on `'clips'` AND a track clip is selected. The `bottomTab` store field exists to support this gate.

**Click semantics**: delegated to `useTrackClipRecorder` (see above). Lane is created on first click if needed.

**Rotation note**: scene-node rotation is stored in radians; the UI shows degrees but the keyframe stores the radian value so the lane matches the persisted transform.

## Files

**Backend:**
- `packages/backend/src/db/migrations/009_track_clips.sql` + `.ts`; `021_track_clip_events.sql` + `.ts` (event/marker lane)
- `packages/backend/src/track_clips/playback.ts` — `TrackClipPlaybackManager`; play / pause / resume / seek / stop, discriminated union entries
- `packages/backend/src/routes/track-clips.ts` — CRUD + `/trigger /stop /pause /resume /seek` + `PUT /track-clips/:id/events` (event-marker bulk replace); event load via `loadClip`/`mapClip`/`mapEvent`. Mounted in `routes/index.ts`; scene bundle in `routes/scenes.ts` includes nested `trackClips` (with `events`)
- `packages/backend/src/signal/nodes/track_clip_trigger.ts` (registered in `signal/registry.ts`)
- `packages/backend/src/index.ts` — manager init + snapshot-on-WS-connect wiring
- `packages/backend/src/routes/shared.ts` — `_trackClipPlayback` accessor

**Shared:**
- `packages/shared/src/types.ts` — `TrackClip` (with `events`), `TrackClipLane`, `TrackClipKeyframe`, `TrackClipEvent`, `TrackClipMode`, `TrackClipTargetKind`, `TrackClipEasing`, `TrackClipStartedMessage`, `TrackClipPausedMessage`, `TrackClipPlaybackEntry` (discriminated), `TrackClipPlaybackSnapshot`; `WSMessageKind` union includes `track_clip_paused`, `track_clip_events_replaced`
- `packages/shared/src/schema.ts` — Zod schemas + `*Input` types

**Frontend:**
- `packages/frontend/src/api/client.ts` — `TrackClipRecord`/`TrackClipLaneRecord`/`TrackClipKeyframeRecord`/`TrackClipEventRecord`, `mapTrackClip*` + `mapTrackClipEvent` helpers, full CRUD + trigger/stop/pause/resume/seek + `replaceTrackClipEvents`; `getScenes` returns `trackClips`
- `packages/frontend/src/store/editorStore.ts` — slice: `trackClips`, `selectedTrackClipId`, `trackClipPlayback` (discriminated entries), ephemeral `nodeTransformOverrides` + `composeLayerOverrides`, `bottomTab: BottomDockTab`; clip/lane/keyframe CRUD actions, playback set/replace, override set
- `packages/frontend/src/hooks/useWsSync.ts` — handlers for all `track_clip_*` messages including `track_clip_paused` and the dual-shape snapshot
- `packages/frontend/src/components/editor/trackClipEvaluator.ts` — pure `evaluateLane` + `resolveClipTime`
- `packages/frontend/src/hooks/useTrackClipEvaluator.ts` — rAF loop; honours paused entries (no wall-clock advance, no auto-complete, still re-evaluates each frame); fires event markers via `lastTByClip` + `crossedMarker` → `dispatchMediaCommand`
- `packages/frontend/src/hooks/useTrackClipRecorder.ts` — **new**; `canRecord`, `currentPlayhead`, lane-find-or-create + keyframe upsert
- `packages/frontend/src/components/editor/Viewport.tsx` — `useTransformWithOverride` per-node hook
- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — `LayerView` per-layer override subscription merged into `layerStyle`
- `packages/frontend/src/components/editor/TrackClipTimeline.tsx` — timeline editor with `ScrubRuler`, transport state machine, shared `computePlayheadT`
- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — ◆ set-keyframe buttons on scene-node transform inputs and group headers
- `packages/frontend/src/components/editor/ComposeLayerProperties.tsx` — ◆ set-keyframe buttons on compose-layer x/y/rotation
- `packages/frontend/src/components/editor/AssetManager.tsx` — sixth `'clips'` tab; reads/writes `bottomTab` from the store instead of local state
- `packages/frontend/src/pages/Editor.tsx`, `pages/ViewerPage.tsx` — hydrate `setTrackClips` from bundle; mount evaluator

## Cross-References

- [compose.md](compose.md) — compose layers are one of the two target kinds; `LayerView` reads `composeLayerOverrides[layer.id]` per-render.
- [signal-graph.md](signal-graph.md) — the `track_clip_trigger` node lives alongside other input-source / trigger nodes.
- [media.md](media.md) — the event/marker lane fires media commands through the media registry; video/audio nodes and video compose layers are its targets.
- [animation.md](animation.md) — distinguishes the two clip systems; track clips do **not** go through `AnimationMixer` or the retargeting pipeline.
- [frontend.md](modules/frontend.md) — `bottomTab` is one of the lifted-to-store dock selectors; the Properties panel gates the ◆ recorder buttons on it.
