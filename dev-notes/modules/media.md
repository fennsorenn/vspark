# Media (Video & Audio)

First-class **video** and **audio** in vspark: a 3D `video` scene-node kind, an
`audio` scene-node kind, the finished `video` compose layer, a fire-and-forget
**media-command bus** (graph → frontend), the `media_control` signal node, the
imperative frontend **media registry**, and a track-clip **event/marker lane** for
timed triggers.

**Status: Implemented.**

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
`dispatch(targetKind, targetId, command)` that broadcasts a `media_control` WS
message. **Stateless by design**: no stored state, no snapshot-on-connect (a late
joiner shouldn't replay past one-shots), no SQLite. Init'd in `index.ts` with the
shared `WSSync`. Empty `targetId` is a no-op.

### Shared types — `packages/shared/src/types.ts`

- `MediaTargetKind = 'scene_node' | 'compose_layer'`.
- `MediaAction = 'play' | 'pause' | 'stop' | 'restart' | 'seek' | 'setVolume' | 'mute' | 'unmute'`.
- `MediaCommand = { action: MediaAction; t?: number; volume?: number }` (`t` only
  for `seek`, `volume` only for `setVolume`).
- `MediaControlMessage = { targetKind, targetId, command }` — payload of the
  `media_control` WS message.
- `'media_control'` added to `WSMessageKind`.

### Signal node — `media_control`

`packages/backend/src/signal/nodes/media_control.ts`, registered in
`signal/registry.ts`. Class-instance/decorator node (tags `['media', 'output']`,
colour `#7a3a6a`):

- `@valueIn('target', 'SceneEntity')`, `@valueIn('t', 'Float')`,
  `@valueIn('volume', 'Float')`.
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

- `MediaHandle = { play, pause, stop, restart, seek(t), setVolume(v), mute, unmute }`.
  `stop` resets to start (and, for a video node with `onEnd:'hide'`, hides it);
  `restart` seeks to 0 and plays.
- `registerMedia(id, handle)` returns an unregister fn safe for effect cleanup (only
  removes the handle if it's still the current one). `VideoNode`, the compose
  `VideoLayer`, and `AudioNode` each register on mount, unregister on unmount.
- `dispatchMediaCommand(id, cmd)` looks up the handle and calls the matching method;
  no-op when absent (entity not mounted on this client).
- `useWsSync` routes the `media_control` message to `dispatchMediaCommand`; the
  track-clip event evaluator calls it directly (client-side firing).

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
  `TrackClip.events: TrackClipEvent[]`; `WSMessageKind 'track_clip_events_replaced'`.
- `routes/track-clips.ts`: events are loaded into the clip bundle
  (`loadClip`/`mapClip`/`mapEvent`); bulk-replace endpoint
  `PUT /track-clips/:id/events` broadcasting `track_clip_events_replaced` (mirrors the
  keyframes bulk-replace pattern).
- `spawn/manager.ts` clones + retargets event markers for `spawn_clip`. See
  [spawn.md](spawn.md).

### Frontend

- `api/client.ts`: `TrackClipEventRecord` + `mapTrackClipEvent` +
  `api.replaceTrackClipEvents`. Store: `replaceTrackClipEvents`; `useWsSync` handler
  for `track_clip_events_replaced`.
- `useTrackClipEvaluator.ts`: fires markers when the playhead crosses them. A
  module-level `lastTByClip` map + a `crossedMarker(prevT, t, markerT, duration, loop)`
  helper (handles loop wrap, re-armed per loop) drive firing. **Playing-only** (paused
  clips don't fire); each crossed marker dispatches via `dispatchMediaCommand`. The
  evaluator clears `lastTByClip` when nothing is playing and deletes per-clip entries
  on stop, so markers don't double-fire on pause / scrub-backward.
- `TrackClipTimeline.tsx`: an `EventLane` editor — a marker strip on the ruler + a
  list editor — targeting video/audio scene nodes and video compose layers.
- `ClipsSection` copy/paste carries events.

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
- `signal/nodes/media_control.ts` (registered in `signal/registry.ts`)
- `db/migrations/021_track_clip_events.{sql,ts}` (registered in `db/index.ts`)
- `routes/track-clips.ts` — event load + `PUT /track-clips/:id/events`
- `routes/shared.ts` — video/audio ext + MIME maps
- `spawn/manager.ts` — event-marker clone/retarget
- `index.ts` — `mediaControlManager.init(ws)`

**Shared:**
- `types.ts` — `MediaTargetKind`, `MediaAction`, `MediaCommand`,
  `MediaControlMessage`, `TrackClipEvent`, `TrackClip.events`, `WSMessageKind`
  (`media_control`, `track_clip_events_replaced`), `NodeKind` (`video`/`audio`)
- `schema.ts` — `sceneNodeKindSchema` (`video`/`audio`/`billboard`)

**Frontend:**
- `components/editor/mediaRegistry.ts` — `MediaHandle` registry + `dispatchMediaCommand`
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
- `hooks/useWsSync.ts` — `media_control` + `track_clip_events_replaced` handlers
- `hooks/useTrackClipEvaluator.ts` — marker firing (`lastTByClip` / `crossedMarker`)
- `api/client.ts` — asset kinds + `TrackClipEventRecord` + `replaceTrackClipEvents`
- `store/editorStore.ts` — `editorAudioPreviewEnabled`, `BottomDockTab`,
  `replaceTrackClipEvents`

## Cross-References

- [scene-graph.md](scene-graph.md) — `video` / `audio` node kinds, flat-mount, gizmos.
- [compose.md](compose.md) — the finished `video` compose layer + `mode` threading.
- [track-clips.md](track-clips.md) — the event/marker lane alongside scalar lanes.
- [signal-graph.md](signal-graph.md) — the `media_control` node.
- [paramPaths.md](paramPaths.md) — why media playback is command-based and
  deliberately NOT in the (scalar-state-only) paramPath registry.
- [spawn.md](spawn.md) — `spawnRef` retargeting on `media_control`; event-marker
  cloning for spawned clips.
</content>
</invoke>
