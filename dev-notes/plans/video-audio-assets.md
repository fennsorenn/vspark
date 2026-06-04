# Plan: Video & Audio Assets

> Branch: `claude/laughing-galileo-vVikb` · Status: draft → ready-for-handoff
> This plan is the seed context for an implementer (cloud worker or local). It is a
> starting point, not an airtight spec — refine interactively as needed.

## Goal

Add first-class **video** and **audio** assets to vspark.

- **Video** behaves like images: usable as a 2D compose-layer overlay *and* as an
  in-scene 3D entity (a new `video` scene-node kind mirroring `billboard`, backed by
  `THREE.VideoTexture`). Per-instance playback config: autostart-when-shown/spawned,
  loop vs one-shot, and on-end behaviour (hide vs freeze on last frame).
- **Audio** is a new non-visual scene-node kind (modelled on `light`) supporting the
  same playback controls plus a **simple ↔ directional/positional** toggle (Web Audio
  via `THREE.Audio` / `THREE.PositionalAudio`).
- Both are controllable **from a signal-graph node** (fire-and-forget play/pause/stop/
  seek/restart/setVolume) **and from a track clip** via a new timed **event/marker lane**.

## Decisions (locked with user)

1. **Trigger model:** new fire-and-forget **media-command bus** (graph→frontend) *plus*
   a new **event lane** in track clips that fires the same commands at timed markers.
   The existing runtime-override bus and track-clip scalar lanes are state-only and are
   NOT reused for play/pause/stop/seek.
2. **3D video:** a **dedicated `video` scene-node kind** (not an extension of `billboard`).
3. **Audio audibility:** plays in the **viewer/output** (`ViewerPage`) by default; in the
   **editor** it is muted unless the user toggles a per-session "preview audio" control.
4. This document is written first for review before implementation.

## Constraints / patterns to preserve

- **Scene-node kinds are schema-free at the DB layer** — `scene_nodes.components` is a
  JSON blob; no migration is needed to add `video` / `audio`. Add the kind to the
  `NodeKind` union (`packages/shared/src/types.ts:1`) and the Zod
  `sceneNodeKindSchema` enum (`packages/shared/src/schema.ts:28`).
- **Compose-layer `video` kind already exists** end-to-end except backend file-type
  recognition and asset classification — finish it, don't rebuild it.
  (`ComposeLayerStack.tsx` already renders `<video>`; `ComposeLayerProperties.tsx`
  already filters `video/*` assets; `createKinds.ts` already lists the layer kind.)
- **Three parallel frontend-facing buses already exist** (broadcast, runtime-overrides,
  data-channels). The media-command bus is a **fourth sibling** following the identical
  pattern: backend manager → WS message kind → `useWsSync` handler → action. Mirror
  `runtime_overrides/manager.ts` for structure.
- **New signal nodes** follow the class-instance/decorator model
  (`packages/shared/src/node.ts` + `node_decorators.ts`), are registered in
  `signal/registry.ts`, and (if they introduce dynamic/new-typed ports) get an entry in
  `infer_nodes.ts`. See [signal-graph.md](../modules/signal-graph.md).
- **Transform** for spatial audio / video planes comes from `components.transform` and
  must flow through `useTransformWithOverride(node)` so clips/overrides animate them for
  free (`Viewport.tsx:603`).
- Type-check is the correctness gate (`pnpm lint`). No test runner.

## Asset model (shared by video + audio)

### Backend file-type recognition — `packages/backend/src/routes/shared.ts`

- `SUBFOLDER_BY_EXT` (line ~116): add video → `'videos'`, audio → `'audio'`:
  - video: `.mp4 .webm .mov .m4v .ogv`
  - audio: `.mp3 .wav .ogg .m4a .aac .flac`
- `MIME_BY_EXT` (line ~130): add matching MIME types (`video/mp4`, `video/webm`,
  `video/quicktime`, `video/ogg`; `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/mp4`,
  `audio/aac`, `audio/flac`).
- Upload/list/delete routes (`routes/assets.ts`) need **no change** — they are generic.

### Frontend asset classification — `packages/frontend/src/api/client.ts`

- `AssetFile.kind` union (line ~196): `'model' | 'animation' | 'image'` → add
  `'video' | 'audio'`.
- `guessAssetKind(name)` (line ~134): return `'video'` / `'audio'` for the new
  extensions. (Compose-layer code that filters on `mimeType.startsWith('video/')`
  keeps working; align audio on `mimeType.startsWith('audio/')`.)

### Asset manager UI — `packages/frontend/src/components/editor/AssetManager.tsx`

- New tabs/filters for Videos and Audio.
- Asset actions:
  - Video: "Add as video (3D)" → create a `video` scene node; "Add as video layer" →
    create a `video` compose layer; "Apply to video node" (parallel to "Apply texture").
  - Audio: "Add as audio source" → create an `audio` scene node.

## Video — 3D scene node (`video` kind)

Mirror `billboard` (`Viewport.tsx:2781` `BillboardNode`) but with a `VideoTexture`.

- **createKinds.ts** (`NODE_KIND_DEFS` + `createSceneNode`): add `video` def(s) (icon 🎞),
  default `components.video`:
  ```ts
  components.video = {
    type: 'video',
    assetId: null, sourceUrl: null,
    facing: 'world',          // 'screen' | 'world' (billboard parity)
    backface: 'none',         // 'none' | 'mirror'
    width: 1.6, height: 0.9, alpha: 1,
    autoplay: true,           // start when shown/spawned
    loop: true,               // loop vs one-shot
    onEnd: 'freeze',          // 'freeze' (last frame) | 'hide'
    muted: true, volume: 1,   // a video node may carry its own audio track
  };
  ```
- **Viewport.tsx**: new `VideoNode` component — create a hidden `<video>` element
  (`document.createElement('video')`, `crossOrigin`, `playsInline`, `muted` per config),
  wrap in `THREE.VideoTexture`, apply to a plane material (reuse billboard geometry /
  facing / backface logic). Honour `autoplay`/`loop`/`muted`. On `ended`, apply `onEnd`
  (hide group vs leave last frame). Register the element in the **media-element registry**
  (below) keyed by `node.id`. Add a `renderNodeElement` case for `kind === 'video'`.
- **PropertiesPanel.tsx**: `VideoProps` interface + `getVideoProps` + `saveVideo` +
  a `node.kind === 'video'` render block (asset picker filtered to video, facing/backface,
  size/alpha, autoplay/loop/onEnd, muted/volume).
- **SceneGraph.tsx**: `KIND_ICONS.video = '🎞'`.
- **Spawn parity:** because spawning clones a node via `spawn_clip`
  ([spawn.md](../modules/spawn.md)), a spawned `video` node with `autoplay:true`
  auto-starts on mount — this satisfies "autostart when spawned" with no extra work.

## Video — 2D compose layer (`video` kind) — finish existing

- Already renders (`ComposeLayerStack.tsx:228`). Extend its `config` to the same
  playback fields (`autoplay`/`loop`/`onEnd`/`muted`/`volume`) and surface them in
  `ComposeLayerProperties.tsx` (which already filters `video/*` assets).
- Register the `<video>` element in the media-element registry keyed by `layer.id` so the
  command bus / clip event lane can drive it.
- `onEnd: 'hide'` → set the layer invisible (or clear the override) when the clip ends;
  `'freeze'` → leave the element paused on its last frame.

## Audio — scene node (`audio` kind)

Model on `light` (`Viewport.tsx:2478` `LightNode`, `PropertiesPanel.tsx` light block).

- **types.ts / schema.ts:** add `'audio'` to `NodeKind` + `sceneNodeKindSchema`.
- **createKinds.ts:** `NODE_KIND_DEFS` entries "Audio (Simple)" / "Audio (Spatial)"
  (icon 🔊); default `components.audio`:
  ```ts
  components.audio = {
    type: 'audio',
    audioType: 'simple',      // 'simple' | 'directional'
    assetId: null, sourceUrl: null,
    autoplay: true, loop: false,
    onEnd: 'stop',            // 'stop' | 'hold' (parity w/ video onEnd naming)
    volume: 1, fadeTime: 0.0,
    // directional/positional only:
    refDistance: 1, rolloffFactor: 1, maxDistance: 100,
    coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
  };
  ```
- **Viewport.tsx:** `AudioNode` component.
  - Needs a single `THREE.AudioListener` mounted on the active camera (add once in the
    R3F tree; reuse for all audio nodes). drei `<PositionalAudio>` is available but a
    hand-rolled `THREE.PositionalAudio`/`THREE.Audio` gives finer control over the
    command bus — pick whichever is simpler during impl.
  - `simple` → `THREE.Audio` (non-spatial); `directional` → `THREE.PositionalAudio`
    positioned by `useTransformWithOverride` and oriented by rotation, with cone +
    distance params applied.
  - Draw a non-visual gizmo (circle / cone rays) when `!viewerMode`, like the light icon.
  - **Audibility gate:** compute `shouldHear = viewerMode || editorAudioPreviewEnabled`.
    In the editor, default muted; a top-bar / viewport toggle flips
    `editorAudioPreviewEnabled` (store flag, session-only, not persisted). `ViewerPage`
    passes `viewerMode` so output is always audible.
  - Register the underlying audio in the media-element registry keyed by `node.id`.
- **PropertiesPanel.tsx:** `AudioProps` + getter + saver + render block (asset picker
  filtered to audio, simple/directional toggle, volume, fade, autoplay/loop/onEnd, and
  the spatial params shown only when `directional`).
- **SceneGraph.tsx:** `KIND_ICONS.audio = '🔊'`.

## Media-command bus (graph + clip → media elements)

The piece that does NOT exist yet. Sibling of `runtime_overrides`.

### Backend — `packages/backend/src/media_control/manager.ts` (new)

- `MediaControlManager` with `dispatch(target: { kind: 'scene_node' | 'compose_layer',
  id: string }, command: MediaCommand)` where
  `MediaCommand = { action: 'play' | 'pause' | 'stop' | 'restart' | 'seek' | 'setVolume'
  | 'mute' | 'unmute', t?: number, volume?: number }`.
- Broadcasts a new WS message `media_control { targetKind, targetId, command }`.
- Fire-and-forget: **no stored state**, no snapshot-on-connect (unlike overrides). A
  late-joining client simply won't replay past one-shots — acceptable for commands.
- Wire the singleton in `index.ts`; expose via `routes/shared.ts` like other managers.

### Shared — types

- `packages/shared/src/types.ts`: add `MediaCommand`, `MediaControlMessage`, and
  `'media_control'` to `WSMessageKind`.
- New signal port type if desired: a `MediaTarget`/`SceneEntity` reference is already
  expressible via the existing `SceneEntity` port — reuse it for the node's target input.

### Signal nodes — `packages/backend/src/signal/nodes/`

Prefer **one** node `media_control` with an `action` config + optional `t`/`volume`
value inputs and a `SceneEntity` target (picker-or-wired), rather than 6 nodes. Pattern:

```ts
@SignalNode({ label: 'Media Control', tags: ['action'], color: '#7a3a6a' })
export class MediaControl extends Node {
  static readonly kind = 'media_control';
  @valueIn('target', 'SceneEntity') target!: () => string;
  @valueIn('t', 'Float') t!: () => number;       // for seek
  @valueIn('volume', 'Float') volume!: () => number;
  @eventIn('fire', 'Trigger') onFire() {
    mediaControlManager.dispatch(
      { kind: 'scene_node', id: this.target() },
      { action: cfg.action, t: this.t(), volume: this.volume() },
    );
  }
}
```

- Register in `signal/registry.ts`; add `infer_nodes.ts` entry only if ports are dynamic.
- Optional ergonomic extra: a `spawnRef` event input (like `set_scene_node_param`) so a
  freshly `spawn_clip`'d media entity can be addressed for that fire.

### Frontend

- **Media-element registry** — small module (e.g.
  `components/editor/mediaRegistry.ts`) exposing `register(id, handle)` / `unregister(id)`
  where `handle` implements `{ play, pause, stop, restart, seek(t), setVolume(v),
  mute, unmute }`. `VideoNode`, compose `<video>`, and `AudioNode` register on mount,
  unregister on unmount. (A `Map<id, handle>` ref + module-level singleton — no React
  re-render needed; commands are imperative.)
- **`useWsSync.ts`**: handle `media_control` → look up the handle by `targetId` and call
  the method. No store write.

## Track-clip event/marker lane (clip-driven triggers)

Extend track clips ([track-clips.md](../modules/track-clips.md)) with a second lane
*flavour* that carries discrete markers instead of scalar keyframes.

- **DB (new migration, e.g. `0NN_track_clip_event_lanes.sql`):** simplest path is a new
  table `track_clip_events (id, clip_id, t, action, target_kind, target_id, payload_json)`.
  (Alternative: add `lane_type` to `track_clip_lanes` + an events table keyed by lane —
  but a flat per-clip events table is less invasive and avoids reworking the scalar lane
  evaluator.)
- **Shared types + Zod:** `TrackClipEvent`, create/update schemas; include in the scene
  bundle and the clip CRUD.
- **Routes:** CRUD under `routes/track-clips.ts` (`POST/PUT/DELETE …/events`).
- **WS:** `track_clip_events_replaced` (bulk replace, mirrors keyframes).
- **Frontend evaluator** (`useTrackClipEvaluator.ts`): the rAF loop already computes `t`
  per playing clip. Track a per-clip "last fired t"; when the playhead crosses a marker's
  `t` (forward, non-looping; and per-cycle for looping) dispatch the command **directly to
  the media registry** (client-side — the clip is already client-evaluated). Handle seek/
  pause so markers don't double-fire or fire while scrubbing backward.
- **Timeline UI** (`TrackClipTimeline.tsx`): an event row showing draggable markers with
  an action + target picker (a small popover). Markers render as ▸ chips on the ruler.
- **Autoplay-on-show:** a media entity's own `autoplay` config covers "play when shown";
  the event lane covers "play this OTHER media at t=X within a clip". Both coexist.

## Suggested additional features (recommend including the ⭐ ones)

- ⭐ **`media_ended` signal event** — media nodes emit an `eventOut` when a one-shot
  finishes, so graphs can chain ("when intro video ends → start scene"). High value, low
  cost (the `ended` DOM event already fires).
- ⭐ **Volume fade in/out** (`fadeTime`) on play/stop — already stubbed in the audio
  config; gives non-jarring starts/stops. Implement via Web Audio gain ramp.
- ⭐ **Global master volume + global mute** — a store flag + a top-bar control; the
  editor preview toggle is a special case of this.
- **Audio ducking** — a `media_control` `duck`/`unduck` action (or a `mediaBus`-driven
  gain group) to lower music while an alert/SFX plays. Pairs naturally with the alert
  queue (`queue_events`).
- **Poster / first frame** for video nodes/layers (show frame 0 before autoplay or while
  paused on `freeze`).
- **Sync group** — tag several media entities with a group id so one `play` starts them
  together (karaoke / multi-angle).
- **Playback rate** — `setRate` command + config for slow-mo / speed-up.
- **Captions/subtitles track** (VTT) for video/audio — out of scope for v1, note as
  future.

## Files in scope

Backend:
- `routes/shared.ts` — video/audio ext + MIME maps.
- `media_control/manager.ts` *(new)* — command bus.
- `signal/nodes/media_control.ts` *(new)* + `signal/registry.ts` — graph node.
- `db/migrations/0NN_track_clip_events.*` *(new)* + `routes/track-clips.ts` — event lane.
- `index.ts`, `routes/shared.ts` — manager wiring.

Shared:
- `types.ts`, `schema.ts` — `NodeKind`/enum (`video`,`audio`), `MediaCommand`,
  `WSMessageKind` (`media_control`, `track_clip_events_replaced`), `TrackClipEvent`,
  `SceneNodeProperties` (optional audio fields), `infer_nodes.ts` (if needed).

Frontend:
- `api/client.ts` — asset kinds + classification + clip-event CRUD mappers.
- `components/editor/createKinds.ts` — `video` + `audio` node defs/factories.
- `components/editor/Viewport.tsx` — `VideoNode`, `AudioNode`, `AudioListener`,
  `renderNodeElement` cases.
- `components/editor/PropertiesPanel.tsx` — video + audio property blocks.
- `components/editor/ComposeLayerStack.tsx` / `ComposeLayerProperties.tsx` — finish video
  layer config + registry registration.
- `components/editor/SceneGraph.tsx` — icons.
- `components/editor/AssetManager.tsx` — video/audio tabs + actions.
- `components/editor/mediaRegistry.ts` *(new)* — imperative media-element registry.
- `hooks/useWsSync.ts` — `media_control` + clip-event handlers.
- `hooks/useTrackClipEvaluator.ts` — marker firing.
- `components/editor/TrackClipTimeline.tsx` — event/marker row UI.
- `store/editorStore.ts` — `editorAudioPreviewEnabled` (+ master volume) flag.

## Out of scope

- Captions/subtitles (VTT). Note as future.
- Video/audio recording or capture (input side) — this is playback only.
- Per-user audio routing / multi-output devices.
- Re-encoding/transcoding uploads — assets are served as uploaded.

## Acceptance / verification

- `pnpm lint` passes (type-check gate for all three packages).
- Upload an `.mp4` and `.mp3`; both classify correctly and land in `uploads/<proj>/videos`
  and `…/audio`.
- A `video` scene node renders a moving texture; `autoplay`/`loop`/`onEnd` behave; a
  spawned (`spawn_clip`) video auto-starts.
- A `video` compose layer plays as a 2D overlay with the same config.
- An `audio` node is silent in the editor by default, audible after toggling preview, and
  audible in `ViewerPage`; `directional` pans with camera/position.
- A `media_control` graph node fires `play`/`pause`/`stop`/`seek`/`restart` against a
  selected target.
- A track clip with an event marker fires the configured command at the marker time
  (forward play and per-loop), and does not double-fire on pause/scrub.
- (If included) `media_ended` event fires on one-shot completion.

## Output

Commit in coherent phases on `claude/laughing-galileo-vVikb`:
1. Asset support (ext/MIME + classification + AssetManager tabs).
2. `video` scene node + finish `video` compose layer.
3. `audio` scene node + AudioListener + editor preview gate.
4. Media-command bus + `media_control` graph node + media registry + `media_ended`.
5. Track-clip event lane (migration, routes, evaluator, timeline UI).

Update `dev-notes` (ARCHITECTURE.md statuses + a new `modules/media.md`, cross-ref
`scene-graph.md`, `compose.md`, `track-clips.md`, `signal-graph.md`) via the
`doc-updater` agent as phases land.
