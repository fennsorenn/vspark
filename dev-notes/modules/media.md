# Media (Video & Audio)

First-class **video** and **audio** in vspark: a 3D `video` scene-node kind, an
`audio` scene-node kind, the finished `video` compose layer, a fire-and-forget
**media-command bus** (graph → frontend), the `media_control` signal node, the
imperative frontend **media registry**, and a track-clip **event/marker lane** for
timed triggers.

**Status: Implemented** (including [media one-shots](#media-one-shots)).

The defining design choice: media playback is **command-based**, not state-based.
Play / pause / stop / restart / seek can't be expressed as a held scalar value
re-applied every frame, so media deliberately does NOT live in the paramPath
registry ([paramPaths.md](paramPaths.md), which is scalar-state-only) and is not
carried by the runtime-override or track-clip *scalar* lanes. Instead, commands flow
through a dedicated bus and a dedicated track-clip event lane. Continuous *spatial*
transform of a video plane / positional audio source still flows through
`components.transform` and `useTransformWithOverride`, so clips/overrides animate
position for free — only the playback actions are command-based.

## Media-command bus

A fourth frontend-facing bus, sibling of broadcast, runtime-overrides, and
data-channels. Backend manager → WS message → `useWsSync` handler → imperative
registry call.

### Backend — `packages/backend/src/media_control/manager.ts`

`MediaControlManager` (singleton `mediaControlManager`) is a thin
`dispatch(targetKind, targetId, command)` that publishes into the mesh
`media_control` collection (`packages/backend/src/mesh/runtime.ts`), keyed by
target id and parented to the target. Empty `targetId` is a no-op; so is a
dispatch before the mesh is up.

**Stateless by design**, and the channel is what enforces it: commands ride the
`control` channel — reliable but unstamped and **unretained** — not the retained
`runtime` channel the override and data-field buses use. A subscription snapshot
carries only a collection's retained channel, so a `play` from an hour ago
cannot fire on a tab that opens now. Nothing reaches SQLite.

One publish reaches local tabs, collab peers and object-share subscribers, since
the command is parented to its target and rides the same subtree grants as
everything else on that entity. The `media_control` WS kind and the collab
`runtime_control` tap that used to carry it a second time are deleted.

### Shared types — `packages/shared/src/types.ts`

- `MediaTargetKind = 'scene_node' | 'compose_layer'`.
- `MediaAction = 'play' | 'pause' | 'stop' | 'restart' | 'seek' | 'setVolume' | 'mute' | 'unmute'`.
- `MediaCommand = { action: MediaAction; t?: number; volume?: number; assetId?: string }`
  (`t` only for `seek`, `volume` only for `setVolume`, `assetId` only for `play` /
  `restart` — see [Media one-shots](#media-one-shots)).
- `MediaControlMessage = { targetKind, targetId, command }` — the shape the
  `media_control` document carries.

### Signal node — `media_control`

`packages/backend/src/signal/nodes/media_control.ts`, registered in
`signal/registry.ts`. Class-instance/decorator node (tags `['media', 'output']`,
colour `#7a3a6a`):

- `@valueIn('target', 'SceneEntity')`, `@valueIn('t', 'Float')`,
  `@valueIn('volume', 'Float')`, `@valueIn('action', 'String')` (falls back to
  `config.action`), `@valueIn('assetId', 'String')` (falls back to
  `config.assetId`; forwarded only on `play` / `restart` — see
  [Media one-shots](#media-one-shots)).
- `@eventIn('fire', 'Trigger')` → dispatches `config.action` (default `play`) to the
  target. Target id resolves from the wired `target` input, else `config.targetId`;
  `config.targetKind` (default `scene_node`) is informational only — the frontend
  registry is keyed by id alone.
- `@eventIn('spawnRef', 'SpawnRef')` → a `SpawnRef` event from `spawn_clip` retargets
  the command to the spawned instance (`ref.tmpNodeId`) for that fire, mirroring the
  `set_*_param` spawnRef pattern. See [spawn.md](spawn.md).

Ports are static (no dynamic ports), so no `infer_nodes.ts` entry is needed.

### Frontend media registry — `packages/frontend/src/components/editor/mediaRegistry.ts`

Module-level `Map<id, MediaHandle>` keyed by scene-node / compose-layer id. Commands
are imperative (no React re-render).

- `MediaHandle = { play, pause, stop, restart, seek(t), setVolume(v), mute, unmute, playSource?(url) }`.
  `stop` resets to start (and, for a video node with `onEnd:'hide'`, hides it);
  `restart` seeks to 0 and plays. `playSource` is optional and implemented only by
  the video entities (see [Media one-shots](#media-one-shots)).
- `registerMedia(id, handle)` returns an unregister fn safe for effect cleanup (only
  removes the handle if it's still the current one). `VideoNode`, the compose
  `VideoLayer`, and `AudioNode` each register on mount, unregister on unmount.
- `dispatchMediaCommand(id, cmd)` looks up the handle and calls the matching method;
  no-op when absent (entity not mounted on this client). A `play` / `restart`
  carrying an `assetId` resolves the asset's URL from the editor store's `assets`
  and calls `playSource(url)` instead; if the asset is unknown on this tab or the
  handle has no `playSource`, it falls through to the plain action.
- `sync/meshStoreFeeder.ts`'s `media_control` observer calls `dispatchMediaCommand`; the
  track-clip event evaluator calls it directly (client-side firing).

## Media one-shots

**Status: Implemented** (on `feature/media-oneshots`, based on
`feature/actions`). Two additions next to the media-command bus: playing a
sound with no entity in the scene, and playing an arbitrary collection video on
an existing video node / layer, temporarily.

### Play a sound without an entity — the `sound_cue` model

- **Shared:** `SoundCue = { id, projectId, assetId, volume?, cueId }`
  (`packages/shared/src/types.ts`). `id` is the project id; `volume` is 0..1
  (default 1); `cueId` is fresh per cue so the same sound twice is still a
  change. Mesh model `sound_cue` (`packages/shared/src/models.ts`): channel
  `control` (unretained), no parent — there is no `project` rtype to hang it
  off — and listed in `TAB_MODELS`.
- **Backend:** `mesh/runtime.ts` registers the `sound_cue` collection with the
  same tab read grant as the other runtime collections, exposed as
  `soundCueCollection()` (null before the mesh is up).
  `MediaControlManager.playSound(projectId, assetId, volume?)` publishes one
  document per project (key = project id, so cues stay in order) with a fresh
  `cueId`; volume is clamped to 0..1, and an empty project or asset is a no-op.
  Being on the unretained `control` channel, a tab that connects later does not
  replay an old cue, and nothing reaches SQLite.
- **Signal node `play_sound`** (`signal/nodes/play_sound.ts`, label "Play
  Sound", tags `['output']`): `@eventIn('fire')`, `@valueIn('assetId',
  'String')`, `@valueIn('volume', 'Float')`, each falling back to config when
  unwired. The project comes from the `_projectId` config field that
  `LogicManager` injects; without it (or without an asset) the fire does nothing.
- **Frontend:** `mesh/soundCues.ts` — `useSoundCues(projectId, audible)` observes
  `sound_cue`, ignores other projects and removals, and while `audible` plays the
  asset (URL looked up in the editor store's `assets`; unknown asset → silent) on
  a transient `new Audio()` element at the cue's volume. Autoplay rejections are
  swallowed. Mounted in `ViewerPage` (always audible) and `Editor` (audible only
  with `editorAudioPreviewEnabled`) — the same gate as the media entities (see
  [Audibility gate](#audibility-gate)).
- The sound is **not positional**: a plain `HTMLAudioElement`, outside the
  three.js `AudioListener` graph.

### Play a collection video on an existing video entity

- `MediaCommand.assetId` (only meaningful on `play` / `restart`). The
  `media_control` node forwards its `assetId` input (config fallback) only for
  those two actions.
- `dispatchMediaCommand` turns such a command into `MediaHandle.playSource(url)`
  (see [Frontend media registry](#frontend-media-registry--packagesfrontendsrccomponentseditormediaregistryts)).
- `Viewport.tsx` `VideoNode` and `ComposeLayerStack.tsx` `VideoLayer` implement
  `playSource` with a `swapUrl` state that overrides the entity's own source:
  - the swapped video plays from the start, once (loop off), then the entity's
    own `onEnd` applies (`hide` hides it; otherwise it stays on the last frame);
  - `playSource` with the URL already loaded restarts it from 0;
  - `stop` drops the swap and returns to the entity's own video, paused and not
    autoplayed (and hidden if `onEnd` is `hide`);
  - a change of the entity's own source clears the swap;
  - `restart` while swapped restarts the swapped video — inferred from the code
    (the `restart` handler seeks/plays the current element), not separately
    specified.
  - Nothing is written: the entity's saved settings are unchanged and a reload
    shows its configured video. `VideoLayer` now drives autoplay from an effect
    instead of the `autoPlay` attribute, so that the own video returning after
    a `stop` is not autoplayed.
- Audio entities (`AudioNode`) have no `playSource`, so an `assetId` on them
  falls back to the plain action.

### Exposure as Action responses

`play_sound` and `play_video` response types — see [actions.md](actions.md)
(Hotkey kind). The help page section is `actions#media` ("Sounds and videos",
EN + DE).

**Decided** (user, 2026-11-08):

- Sound is a one-shot command, not a temporary audio entity.
- The video swap is temporary and not saved.
- Both features are available as Logic nodes and as Action responses.

## Video — 3D scene node (`video` kind)

`Viewport.tsx` `VideoNode`. A flat-mounted plane textured with a live `<video>` via
`THREE.VideoTexture`, mirroring `billboard` facing / backface / size. Like billboards
it is **flat-mounted** (rendered at the top level, not nested in the React tree by
`parentId`), so reparenting doesn't remount the element and restart playback.

`components.video` config: `assetId`/`sourceUrl`, `facing` (`screen`|`world`),
`backface` (`none`|`mirror`), `width`/`height`/`alpha`, and playback:
`autoplay`, `loop`, `onEnd` (`'freeze'` last frame | `'hide'`), `muted`, `volume`.
The element registers a `MediaHandle` keyed by `node.id`. Registered in
`createKinds.ts` (`NODE_KIND_DEFS` + `createSceneNode`), `SceneGraph` `KIND_ICONS`,
and a Video block in `PropertiesPanel`. A spawned (`spawn_clip`) video with
`autoplay:true` auto-starts on mount — "autostart when spawned" for free.

## Video — 2D compose layer (`video` kind)

Finished (was a hardcoded autoplay/muted/loop `<video>`). `ComposeLayerStack.tsx`
now has a config-driven `VideoLayer` with the same playback fields, surfaced in
`ComposeLayerProperties.tsx` (Playback controls). It registers a `MediaHandle` keyed
by `layer.id`. See [compose.md](compose.md).

The render `mode` (`'editor' | 'viewer'`) is threaded through
`ComposeLayerStack` → `LayerView` → `LayerContent` → `SceneIncludeLayer` so video
audio honours the audibility gate (muted in the editor unless preview is enabled;
audible in the viewer, subject to the layer's own `muted` flag).

## Audio — 2D compose layer (`audio` kind)

`ComposeLayerStack.tsx` `AudioLayer`: a non-visual `<audio>` element that registers
a `MediaHandle` (via `registerMedia`, keyed by `layer.id`) so the media-command bus
and track-clip event lane can play/pause/restart it. It renders nothing visible and
keeps playing even when the layer is `visible:false` (the stack uses CSS
`visibility:hidden`, which doesn't stop playback). Honours the same audibility gate
as video (`mode==='viewer' || editorAudioPreviewEnabled`, plus its own `muted`
flag). Config: `assetId`/`sourceUrl`, `autoplay` (default off), `loop`, `muted`,
`volume`. Registered in `createKinds.ts` (`LAYER_KIND_DEFS`, icon 🔊, defaults
`{ autoplay:false, loop:false, muted:false, volume:1 }`), `ComposeTree.tsx`
`KIND_ICONS` (🔊), and an Audio asset selector + Playback section in
`ComposeLayerProperties.tsx` (the compatible-asset filter matches `audio/*` mimes).
See [compose.md](compose.md).

**Asset UX parity with the 3D audio node.** The audio (and image/video) asset
sections in `ComposeLayerProperties.tsx` gained a "Pick…" button that jumps to +
flashes the matching bottom-dock asset tab (`flashBottomTab`). `AssetManager.tsx` is
now aware of the selected compose layer (`selectedComposeLayerId`): it highlights the
relevant asset tab (image→images, video→videos, audio→audio) and shows an "Apply to
&lt;layer&gt;" button on image/video/audio assets that sets the selected layer's
`assetId` (compose media layers resolve their source from `assetId`).

## Video FX — chroma key + blend mode

Shared by both video surfaces (3D node + compose layer) and surfaced as an Effects
section in the properties panels.

### Shared module — `packages/frontend/src/components/editor/videoFx.ts`

- `CHROMA_GLSL` — a chroma-key GLSL function (`vfx_chroma`): keys by chrominance
  distance in **YUV** space with `similarity` (base threshold), `smoothness` (edge
  softness), and `spill` (residual-key-colour desaturation). Shared **verbatim** by
  the 3D node and the DOM layer so both key identically (the canvas path rewrites
  `texture2D` → `texture` for GLSL ES 3.00).
- `makeVideoMaterial()` — a Three.js `ShaderMaterial` for a 3D video plane: samples
  the video texture, applies chroma + `uOpacity`, supports a `uFlipX` backface
  UV-mirror flag, and linearises the (sRGB) sampled output (`pow(rgb, 2.2)`) so the
  renderer's output conversion lands back at source colour. `transparent`,
  `depthWrite:false`. `updateVideoMaterial(mat, {opacity, flipX, chroma})` pushes
  config into uniforms each render.
- `applyVideoBlend(mat, blend)` — maps `VideoBlend3D`
  (`'normal'|'additive'|'multiply'|'screen'`) to Three.js blending; `screen` is
  `CustomBlending` (Add / OneFactor / OneMinusSrcColorFactor).
- `readChroma(src)` / `CHROMA_DEFAULTS` — coerce a config blob to a
  `ChromaKeyConfig {enabled, color, similarity, smoothness, spill}`.
- `CSS_BLEND_MODES` — the full CSS `mix-blend-mode` list, used for compose layers.

### 3D video node (`VideoNode`)

Refactored from `MeshBasicMaterial` to the `videoFx` `ShaderMaterial`. Each render it
reads `components.video.chromaKey` (enabled/color/similarity/smoothness/spill) and
`components.video.blendMode: VideoBlend3D`, pushing them to the material uniforms /
blending via `updateVideoMaterial` / `applyVideoBlend`. Opacity is now a uniform
(`uOpacity` = transform opacity × `alpha`) rather than `useApplyOpacity`.

### Compose video layer DOM keying — `packages/frontend/src/components/editor/ChromaVideoCanvas.tsx`

CSS can't chroma-key a `<video>`, so DOM-layer keying needs a **WebGL2 canvas**.
`ChromaVideoCanvas` renders a playing `<video>` element to a chroma-keyed canvas per
`requestAnimationFrame` (resizes to the video's intrinsic dimensions, uploads the
frame via `texImage2D(... video)`, draws a full-screen quad with `CHROMA_GLSL`). The
`<video>` stays the source of truth and the registered `MediaHandle` target; the
canvas only displays the keyed copy. `ComposeLayerStack.tsx` `VideoLayer` mounts it
**only when `config.chromaKey.enabled`** and renders the plain `<video>` otherwise.
`config.chromaKey` holds the same `ChromaKeyConfig` shape.

### Blend mode for ALL compose layers

`ComposeLayerStack.tsx` `layerStyle()` applies `config.blendMode` (any CSS
`mix-blend-mode` string) as the layer's `mixBlendMode` — skipped when `'normal'`. A
Blend select (full CSS list) was added to `ComposeLayerProperties.tsx` for **every**
layer kind, plus a Chroma key section for video layers. See [compose.md](compose.md).

### Properties — `PropertiesPanel.tsx`

The Video block gained an Effects section: Blend (`normal/additive/multiply/screen`)
+ Chroma key (colour picker + similarity/smoothness/spill sliders), writing
`components.video.blendMode` / `components.video.chromaKey`.

## Audio — scene node (`audio` kind)

`Viewport.tsx` `AudioNode`, modelled on `light` (non-visual; draws an editor gizmo
when not `viewerMode`). Web Audio via a **shared per-camera `THREE.AudioListener`**
(`getAudioListener(camera)` helper — one listener mounted on the active camera, reused
by all audio nodes).

- `audioType: 'simple'` → `THREE.Audio` (non-spatial).
- `audioType: 'directional'` → `THREE.PositionalAudio` positioned by the node
  transform (`useTransformWithOverride`) with `refDistance` / `rolloffFactor` /
  `maxDistance` + directional cone (`coneInnerAngle` / `coneOuterAngle` /
  `coneOuterGain`).
- Shared playback config: `autoplay`, `loop`, `volume`.

Registers a `MediaHandle` keyed by `node.id`. Registered in `createKinds.ts`,
`SceneGraph` `KIND_ICONS`, and an Audio block in `PropertiesPanel` (spatial params
shown only for `directional`).

### Audibility gate

`shouldHear = viewerMode || editorAudioPreviewEnabled`. Audio is audible in the
viewer (`ViewerPage` passes `viewerMode`) but **muted in the editor** unless the
session-only `editorAudioPreviewEnabled` store flag is on (not persisted). It is
toggled by the `AudioPreviewToggle` button in the viewport overlay. Video audio
honours the same gate, plus its own `muted` flag.

## Track-clip event/marker lane

A second lane *flavour* on track clips carrying discrete timed markers (instead of
scalar keyframes) that fire media commands. See [track-clips.md](track-clips.md).

### DB — migration `021_track_clip_events`

Table `track_clip_events (id, clip_id, t, action, target_kind, target_id, payload)`,
`ON DELETE CASCADE` on clip delete, indexed `(clip_id, t)`. Registered in
`db/index.ts`. Flat per-clip table (not per-lane) — least invasive, leaves the scalar
lane evaluator untouched.

### Shared + routes

- Shared: `TrackClipEvent { id, t, action, targetKind, targetId, payload }`;
  `TrackClip.events: TrackClipEvent[]`.
- `routes/track-clips.ts`: events are loaded into the clip bundle
  (`loadClip`/`mapClip`/`mapEvent`); bulk-replace endpoint
  `PUT /track-clips/:id/events` writing the whole event map through the clip document (mirrors the
  keyframes bulk-replace pattern).
- `spawn/manager.ts` clones + retargets event markers for `spawn_clip`. See
  [spawn.md](spawn.md).

### Frontend

- `api/client.ts`: `TrackClipEventRecord` + `mapTrackClipEvent` +
  `api.replaceTrackClipEvents`. Store: `replaceTrackClipEvents`; `useWsSync` handler
  for the clip document's `events` map.
- `useTrackClipEvaluator.ts`: fires markers when the playhead crosses them. A
  module-level `lastTByClip` map + a `crossedMarker(prevT, t, markerT, duration, loop)`
  helper (handles loop wrap, re-armed per loop) drive firing. **Playing-only** (paused
  clips don't fire); each crossed marker dispatches via `dispatchMediaCommand`. The
  evaluator clears `lastTByClip` when nothing is playing and deletes per-clip entries
  on stop, so markers don't double-fire on pause / scrub-backward.
- `TrackClipTimeline.tsx`: an `EventLane` editor — a marker strip on the ruler + a
  list editor — targeting video/audio scene nodes and video compose layers.
- `ClipsSection` copy/paste carries events.

The built-in **event-alert presets** drive their sound/video through this lane rather
than a `media_control` graph node: each alert's "Alert Fade" track clip carries
markers at `t=0` that `restart` the bundled hidden `audio` "Sound" layer (and the
`video` badge for `-video` variants), firing client-side via the media registry on
each released alert. See [presets.md](presets.md).

## Asset support

Video/audio are first-class asset kinds. See [asset-management.md](asset-management.md).

- Backend `routes/shared.ts`: `SUBFOLDER_BY_EXT` + `MIME_BY_EXT` recognise video
  (`.mp4 .webm .mov .m4v .ogv` → `videos/`) and audio
  (`.mp3 .wav .ogg .m4a .aac .flac` → `audio/`).
- Frontend `api/client.ts`: `AssetKind` is now
  `'model' | 'animation' | 'image' | 'video' | 'audio'`; `guessAssetKind` classifies
  the new exts.
- `AssetManager.tsx`: Videos + Audio bottom-dock tabs (upload/list/search/delete) with
  "Add as Video" / "Add as Audio" + apply-source actions. `BottomDockTab` in
  `editorStore` gained `'videos'` | `'audio'`. `AssetThumb.tsx` renders a first-frame
  `<video>` poster for video and a 🔊 icon for audio.
- Shared: `NodeKind` + `sceneNodeKindSchema` gained `'video'`, `'audio'` (and
  backfilled the missing `'billboard'`).

## Files

**Backend:**
- `media_control/manager.ts` — `MediaControlManager` (stateless command bus)
- `media_control/manager.ts` `playSound` — one-shot sound cues
- `mesh/runtime.ts` — the `control` channel + the `media_control` and `sound_cue` collections
- `signal/nodes/media_control.ts`, `signal/nodes/play_sound.ts` (registered in `signal/registry.ts`)
- `db/migrations/021_track_clip_events.{sql,ts}` (registered in `db/index.ts`)
- `routes/track-clips.ts` — event load + `PUT /track-clips/:id/events`
- `routes/shared.ts` — video/audio ext + MIME maps
- `spawn/manager.ts` — event-marker clone/retarget
- `index.ts` — `mediaControlManager.init(ws)`

**Shared:**
- `types.ts` — `MediaTargetKind`, `MediaAction`, `MediaCommand` (incl. `assetId`), `SoundCue`,
  `MediaControlMessage`, `TrackClipEvent`, `TrackClip.events`, `WSMessageKind`
  `MediaCommand` / `MediaControlMessage`, `NodeKind` (`video`/`audio`)
- `schema.ts` — `sceneNodeKindSchema` (`video`/`audio`/`billboard`)
- `models.ts` — `media_control` and `sound_cue` mesh models
- `actions.ts` — `play_sound` / `play_video` in `RESPONSE_TYPES`

**Frontend:**
- `components/editor/mediaRegistry.ts` — `MediaHandle` registry + `dispatchMediaCommand`
  (incl. the `assetId` → `playSource` path)
- `mesh/soundCues.ts` — `useSoundCues` (mounted in `pages/ViewerPage.tsx` and `pages/Editor.tsx`)
- `components/editor/videoFx.ts` — shared chroma GLSL + `ShaderMaterial` factory +
  3D blend mapping + `CSS_BLEND_MODES`
- `components/editor/ChromaVideoCanvas.tsx` — WebGL2 per-frame chroma keying for the
  compose video layer
- `components/editor/Viewport.tsx` — `VideoNode` (now `videoFx` ShaderMaterial),
  `AudioNode`, `getAudioListener`, `AudioPreviewToggle`
- `components/editor/ComposeLayerStack.tsx` — config-driven `VideoLayer`
  (`ChromaVideoCanvas` when keying on) + `mode` threading + `layerStyle` blend mode
- `components/editor/ComposeLayerProperties.tsx` — video Playback controls + per-layer
  Blend select + video Chroma key section
- `components/editor/PropertiesPanel.tsx` — Video (incl. Effects: blend + chroma) +
  Audio blocks
- `components/editor/createKinds.ts` — `video`/`audio` defs + compose video defaults
- `components/editor/SceneGraph.tsx` — `KIND_ICONS` for video/audio
- `components/editor/AssetManager.tsx` + `AssetThumb.tsx` — Videos/Audio tabs + thumbs
- `components/editor/TrackClipTimeline.tsx` — `EventLane` editor
- `sync/meshStoreFeeder.ts` — the `media_control` observer; clip events arrive with the clip document
- `hooks/useTrackClipEvaluator.ts` — marker firing (`lastTByClip` / `crossedMarker`)
- `api/client.ts` — asset kinds + `TrackClipEventRecord` + `replaceTrackClipEvents`
- `store/editorStore.ts` — `editorAudioPreviewEnabled`, `BottomDockTab`,
  `replaceTrackClipEvents`

## Cross-References

- [scene-graph.md](scene-graph.md) — `video` / `audio` node kinds, flat-mount, gizmos.
- [compose.md](compose.md) — the finished `video` compose layer + `mode` threading.
- [track-clips.md](track-clips.md) — the event/marker lane alongside scalar lanes.
- [signal-graph.md](signal-graph.md) — the `media_control` and `play_sound` nodes.
- [actions.md](actions.md) — the `play_sound` / `play_video` response types.
- [paramPaths.md](paramPaths.md) — why media playback is command-based and
  deliberately NOT in the (scalar-state-only) paramPath registry.
- [spawn.md](spawn.md) — `spawnRef` retargeting on `media_control`; event-marker
  cloning for spawned clips.
</content>
</invoke>
