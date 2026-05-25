# Compose View

2D layer composition over the 3D scene. The Compose feature lets users build stacks of image / video / browser-iframe layers in front of and behind the rendered 3D scene, both scene-wide and per-camera, and previews them in an editor viewport that matches what the public `ViewerPage` produces.

Status: implemented.

## Data Model

Table `compose_layers` (migration [008_compose_layers.sql](../../packages/backend/src/db/migrations/008_compose_layers.sql)). Each row is scene-scoped; `camera_node_id` is nullable — `NULL` means scene-wide (visible in every camera).

Per-layer fields:
- `kind`: `'image' | 'video' | 'browser'`
- `asset_id` (image/video) or `url` (browser)
- Layout: `x`, `y` (pixel offsets from anchor corner), `width`, `height`, `anchor` (`top|bottom × left|right`), `rotation` (degrees, CSS transform around centre)
- Display: `visible`, `opacity`, `name`
- Ordering: `scene_order` (signed int), `camera_order` (int)

Shared types live in [packages/shared/src/types.ts](../../packages/shared/src/types.ts) (`ComposeLayer`, `ComposeLayerKind`, anchor enums, `SCENE_RENDER_SLOT` constant) and Zod schemas in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) (`createComposeLayerSchema`, `updateComposeLayerSchema`, `reorderComposeLayersSchema`).

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
- Position is anchor-relative: `(x, y)` is an offset from the chosen corner (`top|bottom × left|right`), so layers stay glued to e.g. the bottom-right of any window size.
- Rotation is a CSS `transform: rotate(...)` around the layer centre.
- A `mode: 'editor' | 'viewer'` prop toggles selection chrome (outline, handles) and pointer-event behaviour. Viewer mode is fully non-interactive.

The editor viewport ([ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx)) sandwiches a Three.js `<Canvas>` (same camera POV + `<Environment>` + `<CameraEffects>` as `ViewerPage`) between two `ComposeLayerStack` instances: a behind-stack at `zIndex 0` and a front-stack at `zIndex 2`, with the canvas at `zIndex 1`. The split is purely by sign of `sceneOrder`.

[ViewerPage.tsx](../../packages/frontend/src/pages/ViewerPage.tsx) does the same composition so what the user sees in the editor matches the streamed output.

## Anchor-Aware Drag / Resize / Rotate

Interaction handlers live in [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts):

- `startDrag` — translates pointer delta into `(x, y)` delta. Because `x/y` are offsets from the anchor corner, signs depend on which corner the layer is anchored to (e.g. dragging right increases `x` for left-anchors but decreases `x` for right-anchors).
- `startResize` — 8 handles (corners + edges). The sign math is anchor-aware so that dragging a handle in a given screen direction always grows or shrinks the layer the way the user expects, regardless of which corner the layer is anchored to. Concretely: for each axis, the resize delta is multiplied by `±1` based on (handle side) XOR (anchor side), so the handle nearest the anchor moves the anchor-relative origin while the far handle only changes size.
- `startRotate` — drag around the layer centre; pointer angle relative to centre becomes `rotation` degrees.

All three gestures patch the Zustand store optimistically during the drag for instant visual feedback, then persist the final state with a single `PUT /compose-layers/:id` on `pointerup`. Other clients receive the change via the `compose_layer_updated` WS broadcast.

## Frontend Pieces

- [store/editorStore.ts](../../packages/frontend/src/store/editorStore.ts) — adds `composeLayers`, `leftTab` (`'scene' | 'compose' | 'graphs'`), `selectedComposeLayerId`, `composeCameraId` and matching actions.
- [components/editor/ComposeTree.tsx](../../packages/frontend/src/components/editor/ComposeTree.tsx) — left-dock tree. One Scene section + one section per camera. Pinned `[3D Scene]` row marks the render slot. ↑/↓ buttons nudge `sceneOrder`; × deletes. Add menu picks layer kind. Disabled until at least one camera node exists.
- [components/editor/ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx) — central viewport with camera picker.
- [components/editor/ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx) — shared editor/viewer renderer.
- [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts) — drag / resize / rotate gestures.
- [components/editor/ComposeLayerProperties.tsx](../../packages/frontend/src/components/editor/ComposeLayerProperties.tsx) — right-panel properties (name, x/y, anchor, w/h, rotation, visibility, opacity, kind-specific asset/url, stack-order). Wired into `PropertiesPanel` ahead of the effect/scene branches.

See also [frontend.md](frontend.md) for general editor structure and store conventions.

## Cross-References

- Backend route registration and the scenes bundle additions are also covered in [backend-api.md](backend-api.md).
- The Compose viewport reuses the same `<CameraEffects>` pipeline as the main viewport; see [camera-effects.md](camera-effects.md).
- Mouse-wheel inside the compose viewport is intentionally a no-op (per user spec) — there's no camera orbit/zoom in compose mode.

## Known Limitations / Future Work

- No drag-and-drop reorder in the tree; manual ↑/↓ buttons + numeric `sceneOrder` / `cameraOrder` inputs only.
- `cameraOrder` interleaving between pinned scene layers is supported by the data model and the properties panel, but the tree UI has no fine-grained "insert between two pinned scene layers" affordance.
- Layers are positioned in editor-pixel space against the editor frame and in viewer-window pixel space against the viewer. The same `x/y/width/height` therefore renders at different visual sizes on differently-sized viewers — anchors mitigate corner placement but full resolution-independent scaling is not implemented.
