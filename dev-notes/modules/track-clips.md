# Track Clips

**Status: Implemented.**

> **Event/marker lane (implemented).** Besides scalar keyframe lanes, a clip carries
> discrete timed **event markers** (`track_clip_events` table, migration 021) that
> fire fire-and-forget media commands at marker times, dispatched client-side to the
> media registry. See [Event/Marker Lane](#eventmarker-lane) below and [media.md](media.md).

Timeline-based parameter animation. A **track clip** is a short, triggerable, optionally-looping clip that animates scalar parameters on scene nodes or compose layers. Authored in the bottom-dock tab whose `bottomTab` id is `'clips'` (UI label is **Timeline** after the vocab rename; the tab-id string was kept); played back from a synced transport document (`clip_playback`) that every peer derives its own playhead from, so the editor and `ViewerPage` stay in sync without anyone streaming a playhead. Supports play / pause / resume / stop / seek (scrub).

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
  autoplay, created_at

track_clip_lanes
  id, clip_id, target_kind ('scene_node' | 'compose_layer'),
  target_id, param_path, default_value

track_clip_keyframes
  id, lane_id, t (s from clip start), value, easing ('linear' | 'step' | 'bezier'),
  in_handle_t, in_handle_v, out_handle_t, out_handle_v (bezier only, nullable)
```

Each lane is a single scalar. The UI groups three sibling lanes (`position.x/y/z`, etc.) into a collapsible row.

**The document keys its children by id.** SQLite stays relational (three tables), but the clip DTO — what the mesh replicates and what the REST routes return — carries `lanes`, `lanes[].keyframes` and `events` as `{ [id]: element }` maps, not arrays. An array is ONE mesh path, so two people editing different keyframes of a lane overwrote each other wholesale; keyed, each element is its own path (`lanes.<laneId>.keyframes.<kfId>`) and the edits merge. A deleted element is present as `null` and readers skip it; only live elements get rows, so tombstones never reach the DB. See `@vspark/shared/idMap` and [mesh.md](mesh.md).

Order is therefore not storage: keyframes and events sort by `t`, lanes by (targetKind, targetId, paramPath). `mapTrackClip` in the frontend api client is the boundary — above it the keyed document, below it the ordered lists the store and UI use.

There is no playhead anchor on the clip row. It lives on the clip's `clip_playback` document (`start_epoch`), and every peer derives the playhead from there — see "Playback State Model" below. (`track_clips.started_at` was the old anchor; migration 040 dropped it once nothing read it.)

**Supported `param_path` values** (Phase 1 — sourced from the shared paramPath registry, scalar/animatable entries only; see [paramPaths.md](paramPaths.md)):

- Scene node: `position.x|y|z`, `rotation.x|y|z` (radians), `scale.x|y|z`, `opacity`.
- Compose layer: `x`, `y`, `rotation`, `width`, `height`, `opacity`.

Non-scalar registry entries (e.g. `text.content`) are excluded from lane creation — they are runtime-override-only.

**Phase 1 additions (signal-graph expansion) — implemented:**

- New animatable paramPaths: `opacity` on both target kinds; `width`, `height` on compose layers. The evaluator's `NodeAccumulator` now carries `opacity`, and `readNodeParam`/`writeNodeParam` handle `opacity` for `scene_node`. The compose-layer write path was refactored from a hardcoded `x`/`y`/`rotation` switch into a `readComposeParam` / `writeComposeParam` table covering `x/y/rotation/width/height/opacity` — adding a future scalar compose paramPath is one table entry.
- `onClipFinished(listener)` (now in `track_clips/lifecycle.ts`) listener registry; the spawn manager subscribes to it for tmp-entity cleanup.
- Ephemeral (spawned) clips: `setEphemeralDuration` / `clearEphemeralDuration` in `track_clips/lifecycle.ts` let a clip that has no row be swept for completion like a persisted one. Used by `spawn_clip`. See [spawn.md](spawn.md).
- New canonical `start_clip` signal node generalises `track_clip_trigger` (existing kind retained for back-compat).

**Easing kinds:** `linear`, `step`, `bezier` (per-keyframe outgoing-segment easing; bezier uses the four handle fields).

Shared types (`TrackClip`, `TrackClipLane`, `TrackClipKeyframe`, `TrackClipMode`, `TargetKind`, `Easing`) live in `packages/shared/src/types.ts`; Zod schemas in `schema.ts`. The transport document's type is `ClipPlaybackDoc` in `packages/shared/src/clipPlayback.ts`, next to the derivation helpers.

## Playback State Model

One document per clip that has ever been played (`ClipPlaybackDoc` in
`packages/shared/src/clipPlayback.ts`):

```
{ id: 'pb:<clipId>', clipId, state: 'playing' | 'paused' | 'stopped',
  startEpoch: number | null,   // ms anchor; playhead = (now - startEpoch) / 1000 * speed
  pausedAtT:  number | null,   // frozen seconds-from-clip-start
  speed, loop }
```

`stopped` is a state, not the absence of a row: absence-means-stopped would make
every Stop a delete and every Play a create, which is tombstone churn on the
most-pressed control in the app. A clip that has never been played has no
document at all.

The id is DERIVED (`pb:` + clipId), not minted, so two tabs pressing Play on a
never-played clip produce one document racing on LWW rather than two documents
colliding on `UNIQUE(clip_id)`.

## Playback Authority — none; the transport is a document

Playback state lives in the `clip_playback` table (migration 037) and syncs like
any other document: `{ state: playing | paused | stopped, startEpoch, pausedAtT,
speed, loop }`, one row per clip, id `pb:<clipId>`. There is no manager, no
in-memory map, and no playhead on the wire — every peer DERIVES the playhead
from `startEpoch` against the wall clock (`playheadAt` / `anchorFor` /
`displayPlayhead` in `@vspark/shared/clipPlayback`). This is principle 1 in
[mesh.md](mesh.md): sync the inputs, derive the outputs.

Writers:

- `packages/frontend/src/mesh/playbackWrites.ts` — the editor's transport
  buttons, writing the document with `undo: false` (transport is a view action,
  not a document edit).
- `packages/backend/src/track_clips/playbackDoc.ts` — the same writes for the
  REST control routes and signal-graph triggers.
- `packages/backend/src/track_clips/lifecycle.ts` — a 250ms sweep that moves a
  finished non-looping clip to `stopped`, plus autoplay at boot and the
  `onClipFinished` listeners the spawn manager uses for tmp-entity cleanup.

Late joiners need no snapshot: they subscribe to the collection and receive the
current documents like everything else.

## Trigger Surfaces

A clip can be started/controlled from:

1. **Editor UI** — transport buttons in `TrackClipTimeline` (play / pause / resume / stop) and the `ScrubRuler` for seek.
2. **REST** — see below.
3. **Signal graph** — node kind `track_clip_trigger`, event input `fire`, config `clipId`. Registered in `packages/backend/src/signal/registry.ts`. Lets VMC events, the API controller, or any other graph drive clips. See [signal-graph.md](signal-graph.md).

All paths write the same `clip_playback` document.

## REST Routes

`packages/backend/src/routes/track-clips.ts`:

- `GET    /scene-nodes/:nodeId/track-clips` / `GET /compose-layers/:layerId/track-clips` — list (clips + lanes + keyframes)
- `POST   /scene-nodes/:nodeId/track-clips` / `POST /compose-layers/:layerId/track-clips`
- `PUT    /track-clips/:id` — patch clip-level fields
- `DELETE /track-clips/:id`
- `POST   /track-clips/:id/lanes`
- `PUT    /track-clip-lanes/:id`
- `DELETE /track-clip-lanes/:id`
- `PUT    /track-clip-lanes/:id/keyframes` — bulk replace, for callers that only have a list
- `PUT    /track-clips/:id/events` — bulk replace of the event lane
- `POST   /track-clips/:id/trigger`
- `POST   /track-clips/:id/stop`
- `POST   /track-clips/:id/pause`
- `POST   /track-clips/:id/resume`
- `POST   /track-clips/:id/seek` — body `{ t: number }`

Every mutation route writes THROUGH the `track_clip` mesh collection rather than
SQLite, addressing the path it changes (`lanes.<id>`, `lanes.<id>.keyframes`) —
see [mesh.md](mesh.md), principle 5. The editor does not use these: it writes the
document directly through `packages/frontend/src/mesh/clipWrites.ts`, one element
per write, so a dragged keyframe is one undo step and concurrent edits to
different keyframes merge. A drag rides the `preview` channel and commits once on
release.

The scene-bundle endpoint includes `trackClips` so the editor hydrates everything in one request.

## WS Messages

The playback kinds (`track_clip_started` / `_paused` / `_stopped` /
`_playback_snapshot`) are gone with the backend playhead. The document kinds
(`track_clip_added` / `_updated` / `_removed`, the lane/keyframe/event kinds)
are still broadcast by the REST routes for legacy consumers, but nothing in the
editor reads them: clips arrive through the mesh replica and the store feeder.
The spawn manager still emits `track_clip_added` inline for ephemeral spawned
clips. See [sync.md](sync.md) and [spawn.md](spawn.md).

## Frontend Evaluator

`packages/frontend/src/hooks/useTrackClipEvaluator.ts` is mounted in both `Editor.tsx` and `ViewerPage.tsx`.

Per rAF tick, for each entry in the store's `clipPlayback` slice:

1. Compute `t` with `playheadAt(doc, clip.duration, now)`:
   - `playing` → elapsed since `startEpoch`, modulo the duration when looping, clamped otherwise.
   - `paused` → `pausedAtT`. The evaluator still re-evaluates every tick so edits to lanes / keyframes / handles while paused take effect immediately.
2. For each lane, `evaluateLane` finds the bracketing keyframes and interpolates (linear / step / cubic-bezier with root-finding on the X handle). Pure interpolation utilities live in `components/editor/trackClipEvaluator.ts`.
3. Compose an **absolute** target value and write it into one of two override maps in the Zustand store. For `relative` clips the evaluator pre-folds the base in (`base + (raw − lane.defaultValue)`) so consumers always just *replace* with the override.
4. Completion is not the evaluator's business: the backend's 250ms sweep moves a finished non-looping clip to `stopped`, and every peer sees that through the document.

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
    - Playing → shifts the document's `startEpoch` anchor.
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
- `packages/backend/src/db/migrations/037_clip_playback.sql` + `.ts` — the transport document's table
- `packages/backend/src/track_clips/playbackDoc.ts` — trigger / stop / pause / resume / seek / syncPlaybackLoop / removePlayback, all writing the `clip_playback` document
- `packages/backend/src/track_clips/lifecycle.ts` — 250ms completion sweep, autoplay at boot, `onClipFinished` listeners, ephemeral durations
- `packages/backend/src/routes/track-clips.ts` — CRUD + `/trigger /stop /pause /resume /seek` + `PUT /track-clips/:id/events` (event-marker bulk replace); event load via `loadClip`/`mapClip`/`mapEvent`. Mounted in `routes/index.ts`; scene bundle in `routes/scenes.ts` includes nested `trackClips` (with `events`)
- `packages/backend/src/signal/nodes/track_clip_trigger.ts` (registered in `signal/registry.ts`)
- `packages/backend/src/index.ts` — starts the clip lifecycle sweep

**Shared:**
- `packages/shared/src/types.ts` — `TrackClip` (with `events`), `TrackClipLane`, `TrackClipKeyframe`, `TrackClipEvent`, `TrackClipMode`, `TrackClipTargetKind`, `TrackClipEasing`; the child collections are `IdMap`s
- `packages/shared/src/idMap.ts` — `IdMap`, `itemsOf`, `byId`, `sortedBy`
- `packages/shared/src/clipPlayback.ts` — `ClipPlaybackDoc`, `playbackDocId`, `playheadAt`, `anchorFor`, `displayPlayhead`
- `packages/shared/src/schema.ts` — Zod schemas + `*Input` types

**Frontend:**
- `packages/frontend/src/api/client.ts` — `TrackClipRecord`/`TrackClipLaneRecord`/`TrackClipKeyframeRecord`/`TrackClipEventRecord` (ordered lists), `mapTrackClip*` helpers (the keyed-document boundary), the REST surface used as fallback; `getScenes` returns `trackClips`
- `packages/frontend/src/store/editorStore.ts` — slice: `trackClips`, `selectedTrackClipId`, `clipPlayback` (the transport documents), ephemeral `nodeTransformOverrides` + `composeLayerOverrides`, `bottomTab: BottomDockTab`
- `packages/frontend/src/mesh/clipWrites.ts` — per-element clip writes (lane / keyframe / event), preview + commit
- `packages/frontend/src/mesh/playbackWrites.ts` — transport writes (`undo: false`)
- `packages/frontend/src/sync/meshStoreFeeder.ts` — mirrors clip documents into the store through `mapTrackClip`
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
