# Compose View

2D layer composition over the 3D scene. The Compose feature lets users build stacks of image / video / browser-iframe layers in front of and behind the rendered 3D scene, both scene-wide and per-camera, and previews them in an editor viewport that matches what the public `ViewerPage` produces.

Status: implemented.

## Compose scenes (decoupled from 3D scenes — migration 018)

Compose is now **independent** of the 3D `scene_nodes` tree. A compose hierarchy roots at a `compose_layers` row with `kind = 'compose_scene'`. Layers are **project-scoped** (the old per-3D-scene constraint is gone) and root back via `root_compose_scene_id`; nesting between layers goes through `parent_id` (migration 016).

Migration 018 specifics:

- Added `project_id` + `root_compose_scene_id` to `compose_layers` (backfilled from the prior `scene_id` join into `scene_nodes`).
- Created one `compose_scene` row per pre-existing 3D scene (id is the old scene_id + `_compose`), wired the legacy layers to point at it as their root.
- Dropped the `compose_layers.scene_id` column.

The frontend exposes compose scenes as a separate top-level concept from 3D scenes; the same scene-instancing flow (`1afa49d`) seeds a default compose scene per new project alongside its default 3D scene.

## Data Model

Table `compose_layers` (migration [008_compose_layers.sql](../../packages/backend/src/db/migrations/008_compose_layers.sql) + later patches 016, 018). Layers are project-scoped (was scene-scoped). `camera_node_id` is nullable — `NULL` means visible in every camera. `parent_id` (migration 016) supports nesting (`compose_scene` → group layer → image, etc.). `root_compose_scene_id` (migration 018) points at the owning `compose_scene` row.

Per-layer fields:
- `kind`: `'compose_scene' | 'image' | 'video' | 'browser' | 'text'`
- `asset_id` (image/video) or `url` (browser)
- Layout: `x`, `y` (pixel offsets from anchor corner), `width`, `height`, `anchor` (`top|bottom × left|right`), `rotation` (degrees, CSS transform around centre)
- Display: `visible`, `opacity`, `name`
- Ordering: `scene_order` (signed int), `camera_order` (int)

Shared types live in [packages/shared/src/types.ts](../../packages/shared/src/types.ts) (`ComposeLayer`, `ComposeLayerKind`, anchor enums, `SCENE_RENDER_SLOT` constant) and Zod schemas in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) (`createComposeLayerSchema`, `updateComposeLayerSchema`, `reorderComposeLayersSchema`).

## Video layer (finished) + media-command bus

The `video` compose layer is now a **config-driven `VideoLayer`** (was a hardcoded
autoplay/muted/loop `<video>`). `ComposeLayerStack.tsx` reads playback fields
(`autoplay`/`loop`/`onEnd`/`muted`/`volume`, surfaced as Playback controls in
`ComposeLayerProperties.tsx`) and registers a `MediaHandle` in the media registry
keyed by `layer.id`, so the media-command bus and the track-clip event lane can drive
play/pause/stop/seek against it.

The render **`mode` (`'editor' | 'viewer'`)** is now threaded through
`ComposeLayerStack` → `LayerView` → `LayerContent` → `SceneIncludeLayer` so video
audio honours the audibility gate (muted in the editor unless the session
`editorAudioPreviewEnabled` preview is on; audible in the viewer, subject to the
layer's own `muted` flag). See [media.md](media.md).

**Blend mode + chroma key.** `layerStyle()` applies `config.blendMode` (any CSS
`mix-blend-mode` string, skipped when `'normal'`) as `mixBlendMode` for **every** layer
kind; the video layer additionally chroma-keys via a WebGL2 `ChromaVideoCanvas` when
`config.chromaKey.enabled` (CSS can't key a `<video>`). Both surfaced in
`ComposeLayerProperties`. See [media.md](media.md) (Video FX).

## Phase 1 additions (signal-graph expansion) — implemented

Graph-driven param mutation and a text layer kind.

- **Layer kind `'text'`.** `ComposeLayerStack.TextLayer` reads `content` from `layer.config.content`, with `runtimeLayerOverrides[layer.id]['text.content']` taking precedence at render time. When `layer.config.allowHtml` is true the content is sanitised via `DOMPurify` using the shared `TEXT_SANITIZE_OPTS` allow-list exported from `packages/frontend/src/lib/textSanitize.ts` (covers `b, i, em, strong, span, br, img` with whitelisted `img` attrs for overlive emote HTML); otherwise rendered as plain text. The `'text'` kind is registered in `ComposeTree`'s `KIND_ICONS` (📝) and `ADDABLE_KINDS`.
- **New paramPaths on `compose_layer`:** `opacity`, `width`, `height`, `text.content`. `ComposeLayerOverride` gains `width`, `height`, `opacity` so clip-side animation matches the new paths; `ComposeLayerStack.LayerView` merges both `composeLayerOverrides` (clip) and `runtimeLayerOverrides[layer.id]` into `layerStyle`. Conflict: clip wins for scalar/transform overlap; `text.content` is runtime-only. See [paramPaths.md](paramPaths.md), [runtime-overrides.md](runtime-overrides.md).
- **Tmp compose layers** spawned by `spawn_clip` arrive via standard `compose_layer_added` / `compose_layer_removed` WS messages and render through the same `LayerView` code path. See [spawn.md](spawn.md).
- **Schema:** `composeLayerKindSchema` (shared/schema.ts) and the frontend `ComposeLayerKind` union (`api/client.ts`) both gain `'text'`.

## REST + WS

Routes in [packages/backend/src/routes/compose-layers.ts](../../packages/backend/src/routes/compose-layers.ts):

- `GET    /scenes/:sceneId/compose-layers`
- `POST   /scenes/:sceneId/compose-layers`
- `PUT    /compose-layers/:id`
- `DELETE /compose-layers/:id`
- `POST   /compose-layers/reorder`

The scenes bundle endpoint also returns `composeLayers` alongside `cameraEffects` so the editor hydrates everything in one request.

Mutations broadcast over WebSocket: `compose_layer_added`, `compose_layer_updated`, `compose_layer_removed`, `compose_layer_reordered`. Frontend handlers live in [hooks/useWsSync.ts](../../packages/frontend/src/hooks/useWsSync.ts).

When a scene-wide layer is deleted, the route re-anchors any camera-specific layers whose `camera_order` was anchored to that layer's `scene_order` slot. This keeps per-camera positioning sensible across the gap.

## Ordering Scheme (the `sceneOrder=0` trick)

The 3D render itself occupies `scene_order = 0` (`SCENE_RENDER_SLOT`).

- `scene_order < 0`  → layer is in front of the 3D render
- `scene_order = 0`  → the 3D render slot (no real layer ever has this; it's a pinned `[3D Scene]` row in the tree)
- `scene_order > 0`  → layer is behind the 3D render

Sort order is `(sceneOrder DESC, cameraOrder ASC)` and layers are drawn back-to-front. `cameraOrder` lets multiple layers share a `sceneOrder` slot with deterministic stacking.

This collapses three concepts (background layers, the 3D render, foreground overlays) onto a single signed axis, so a layer can be moved between in-front and behind purely by sign of `scene_order` — no separate "stack" enum. The pinned `[3D Scene]` row in `ComposeTree` is purely a UI element that visualises where 0 sits in the sorted list.

Per-camera sections in the tree show all scene-wide layers as pinned/interleaved rows alongside that camera's own layers, sorted by the same comparator, so the user sees the final composite stack from the camera's perspective.

## Editor / Viewer Shared Renderer

[components/editor/ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx) is a single renderer used by both the editor's compose viewport and the public viewer:

- Layers are absolutely positioned DOM elements (HTML/CSS), not CSS3D or WebGL textures.
- **Layers nest by `parentId` and are positioned, rotated and sized relative to their parent — not the viewport.** The renderer builds a parent→children map and renders the tree recursively: each `LayerView` renders its children *inside* its own box, so a child's CSS `left/top/width/height` (and `%` units) resolve against the parent layer's content box and its `rotate(...)` transform composes with the parent's. A layer roots the stack when it has no parent, or its parent isn't part of the rendered set (e.g. the parent is the `compose_scene` row, or a dangling/cross-scene parent), mirroring `ComposeTree`'s nesting logic. `group` layers render as transparent container boxes (their `LayerContent` is empty); only the `compose_scene` root is excluded. Because every layer box carries `overflow: hidden`, children are clipped to their parent's bounds.
- Position is anchor-relative *within the parent box*: `(x, y)` is an offset from the chosen corner (`top|bottom × left|right`), so layers stay glued to e.g. the bottom-right of their parent at any size.
- Rotation is a CSS `transform: rotate(...)` around the layer centre, composing down the parent chain.
- A `mode: 'editor' | 'viewer'` prop toggles selection chrome rendering. Layer DOM is always `pointer-events: none` — in editor mode all input is owned by the capture overlay (see below), and viewer mode is fully non-interactive.
- `LayerView` (internal to `ComposeLayerStack`) is a pure presentation wrapper; it carries no pointer handlers and `ComposeLayerStack` no longer takes `selectedId`/`onSelect` props.

The editor viewport ([ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx)) layers the following in a single positioned container (see "Z-Stack" below):

- behind-stack `ComposeLayerStack` at `zIndex 0` (`pointer-events: none`)
- a Three.js `<Canvas>` wrapper at `zIndex 1` (`pointer-events: none`) using the same camera POV + `<Environment>` + `<CameraEffects>` as `ViewerPage`
- front-stack `ComposeLayerStack` at `zIndex 2` (`pointer-events: none`)
- `ComposeEventCapture` at `zIndex 50` (owns all pointer + wheel input)
- `ComposeSelectionOverlay` at `zIndex 100` (resize / rotate handles)

The behind/front split is purely by sign of `sceneOrder`.

[ViewerPage.tsx](../../packages/frontend/src/pages/ViewerPage.tsx) does the same DOM/3D/DOM composition (without the capture or selection layers) so what the user sees in the editor matches the streamed output.

## Input Model: Single Capture Overlay

All pointer + wheel input in the compose viewport is owned by one full-viewport invisible `<div>` at `zIndex 50`: [components/editor/ComposeEventCapture.tsx](../../packages/frontend/src/components/editor/ComposeEventCapture.tsx). Nothing underneath it receives events directly — layer DOM, the 3D canvas wrapper, and the selection chrome's body are all `pointer-events: none`. Only the resize/rotate handles on `ComposeSelectionOverlay` sit above the capture layer (`zIndex 100`) because they are precise hit targets.

This replaces an earlier model in which each interactive element had its own handler and routed events between themselves with `data-compose-*` markers, `stopPropagation`, and `document.elementsFromPoint`. Centralising input fixed a class of edge cases (e.g. `pointer-events: none` elements being silently invisible to `elementsFromPoint`) and removed the need for cross-element coordination.

### Capture dispatch

`ComposeEventCapture` does click-vs-drag detection on `pointerdown` (3px threshold) and dispatches deliberately:

- **Click** → `cyclePickAt` (cycles the topmost slot at the cursor: 2D layer or 3D node).
- **Drag with a 2D layer selected** → `startDrag` from `composeLayerInteractions`.
- **Drag with a 3D node selected** → `composeSceneDragStarter` (viewport-plane drag).
- **Drag with nothing selected** → run the cycle to pick the topmost slot under the cursor, then immediately start the appropriate drag.
- **Wheel** → `composeSceneWheel` (dolly the selected 3D node along the cursor ray; the per-frame integration runs inside the canvas via `useFrame`).

### Hit testing

[components/editor/composeHitTest.ts](../../packages/frontend/src/components/editor/composeHitTest.ts) exposes `layerFrame`, `layerParentFrame`, `pointInLayer`, and `layersAtClientPoint` so the cycle/capture path can do analytical hit-testing against layer rectangles. This avoids `document.elementsFromPoint`, which excludes `pointer-events: none` elements — the very state the new model relies on.

Because layers nest, the geometry is **composed through the ancestor chain**: `layerFrame(viewport, layer, byId)` walks the parent links (`byId` lookup, cycle-guarded), composing each ancestor's frame so a nested layer's rect is computed relative to its parent box and the parents' accumulated rotation, then projected into viewport space. The returned `LayerFrame` carries the centre, unit local axes, half-extents, and the accumulated rotation. `layerParentFrame` returns the frame of the coordinate system a layer's stored `x/y/width/height` live in (its parent box, or the viewport for a root) — used by the gesture math for the `%` basis and screen→local delta projection. Passing no `byId` treats the layer as a root (the prior viewport-relative behaviour).

It also exports a module-level `composeViewportRect` getter. `ComposeView` installs the current viewport's bounding-rect lookup at mount; other modules (capture, scene interactions) resolve viewport-relative coordinates through it instead of prop-drilling refs.

### Scene-side module handles

`ComposeSceneInteractions` (mounted inside the `<Canvas>`) installs module-level handles when it mounts, in addition to the existing `composeScenePicker`:

- `composeSceneDragStarter` — start a 3D viewport-plane drag for a node from screen coords.
- `composeSceneWheel` — apply a wheel impulse to the selected 3D node.

The component itself no longer attaches an `onPointerDown` to its wrapper `<group>` nor a wheel listener on a DOM ref (the old `wheelTargetRef` prop is gone). Its in-canvas responsibility is just the `useFrame` integrator that consumes the wheel-impulse state. All pointer/wheel entry happens outside the canvas via the capture overlay.

## Anchor-Aware Drag / Resize / Rotate

The gesture math itself lives in [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts) and is invoked by the capture overlay (drag) and the selection-overlay handles (resize, rotate):

All three gestures operate in the layer's *parent* frame, supplied as a `ComposeFrame` (`{ width, height, angle }` — the parent box dims + accumulated rotation, resolved by `layerParentFrame` at the call site). This is what keeps a nested layer's drag/resize relative to its parent.

- `startDrag` — translates pointer delta into `(x, y)` delta. The screen-space delta is first projected onto the parent's local axes (via the parent `angle`) so a layer under a rotated parent tracks the cursor along the parent's orientation; the `%` basis is the parent box. Because `x/y` are offsets from the anchor corner, signs depend on which corner the layer is anchored to (e.g. dragging right increases `x` for left-anchors but decreases `x` for right-anchors).
- `startResize` — 8 handles (corners + edges) on `ComposeSelectionOverlay`. The sign math is anchor-aware so that dragging a handle in a given screen direction always grows or shrinks the layer the way the user expects, regardless of which corner the layer is anchored to. Concretely: for each axis, the resize delta is multiplied by `±1` based on (handle side) XOR (anchor side), so the handle nearest the anchor moves the anchor-relative origin while the far handle only changes size. The local-axis projection uses the layer's *accumulated* rotation (parent angle + own rotation); the anchored-edge pin only applies when fully axis-aligned, otherwise the layer grows from its centre (v1).
- `startRotate` — drag around the layer centre from the rotate handle; pointer angle relative to centre becomes `rotation` degrees. Since the parent is fixed during the gesture, the screen-angle delta equals the (parent-relative) rotation delta, so no extra compensation is needed.

All three gestures patch the Zustand store optimistically during the drag for instant visual feedback, then persist the final state with a single `PUT /compose-layers/:id` on `pointerup`. Other clients receive the change via the `compose_layer_updated` WS broadcast.

## Frontend Pieces

- [store/editorStore.ts](../../packages/frontend/src/store/editorStore.ts) — adds `composeLayers`, `leftTab` (`'scene' | 'compose' | 'graphs'`), `selectedComposeLayerId`, `composeCameraId` and matching actions.
- [components/editor/ComposeTree.tsx](../../packages/frontend/src/components/editor/ComposeTree.tsx) — left-dock tree. One Scene section + one section per camera. Pinned `[3D Scene]` row marks the render slot. ↑/↓ buttons nudge `sceneOrder`; × deletes. Add menu picks layer kind. Disabled until at least one camera node exists. Right-click context menu uses the generic `ContextMenu.tsx` (`13f0021`); supports Copy/Paste (compose-layer preset) — see [clipboard.md](clipboard.md).
- [components/editor/ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx) — central viewport with camera picker.
- [components/editor/ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx) — shared editor/viewer renderer (presentation only; no pointer handlers).
- [components/editor/ComposeEventCapture.tsx](../../packages/frontend/src/components/editor/ComposeEventCapture.tsx) — full-viewport input overlay; owns pointer + wheel routing.
- [components/editor/composeHitTest.ts](../../packages/frontend/src/components/editor/composeHitTest.ts) — analytical layer hit-testing + `composeViewportRect` module-level getter.
- [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts) — drag / resize / rotate gesture math.
- [components/editor/ComposeSelectionOverlay.tsx](../../packages/frontend/src/components/editor/ComposeSelectionOverlay.tsx) — selection chrome; resize + rotate handles only (no drag body — the capture overlay handles drag).
- `ComposeSceneInteractions` (inside the Canvas) — installs `composeScenePicker`, `composeSceneDragStarter`, `composeSceneWheel` module handles and runs the `useFrame` wheel-impulse integrator.
- [components/editor/ComposeLayerProperties.tsx](../../packages/frontend/src/components/editor/ComposeLayerProperties.tsx) — right-panel properties (name, x/y, anchor, w/h, rotation, visibility, opacity, kind-specific asset/url, stack-order). Wired into `PropertiesPanel` ahead of the effect/scene branches.

See also [frontend.md](frontend.md) for general editor structure and store conventions.

## Cross-References

- Backend route registration and the scenes bundle additions are also covered in [backend-api.md](backend-api.md).
- The Compose viewport reuses the same `<CameraEffects>` pipeline as the main viewport; see [camera-effects.md](camera-effects.md).
- Mouse-wheel inside the compose viewport never orbits/zooms the camera; instead the capture overlay forwards it to `composeSceneWheel`, which dollies the currently-selected 3D node along the cursor ray.
- [track-clips.md](track-clips.md) — track clips can target compose-layer `layer.x`, `layer.y`, `layer.rotation`. `ComposeLayerStack.LayerView` subscribes per-layer to `composeLayerOverrides[layer.id]` in the Zustand store and merges over the base on render. Overrides are runtime-only (never persisted); for `relative`-mode clips the evaluator pre-folds the base in, so the merge is always a plain replace.

## Known Limitations / Future Work

- No drag-and-drop reorder in the tree; manual ↑/↓ buttons + numeric `sceneOrder` / `cameraOrder` inputs only.
- `cameraOrder` interleaving between pinned scene layers is supported by the data model and the properties panel, but the tree UI has no fine-grained "insert between two pinned scene layers" affordance.
- Root layers are positioned in editor-pixel space against the editor frame and in viewer-window pixel space against the viewer. The same `x/y/width/height` therefore renders at different visual sizes on differently-sized viewers — anchors (and `%` units relative to the parent box) mitigate this but full resolution-independent scaling is not implemented.
- Nesting composes translation + rotation only; there is no parent→child *scaling*, so a child sized in `px` keeps its pixel size when the parent is resized (use `%` width/height for proportional children). Layer boxes clip children (`overflow: hidden`), so a `group`'s default 320×180 box will crop children placed outside it until resized.
- Selection-chrome / gesture geometry composes ancestors from their *base* (persisted) transforms; an active clip/runtime override animating a parent layer is not folded into a child's hit-test frame while editing that child.
