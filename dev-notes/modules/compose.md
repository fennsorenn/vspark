# Compose View

2D layer composition. The Compose feature lets users build a stack of image / video / browser-iframe / text / feed layers, and the 3D camera output is itself a layer in that stack (a `camera_view` layer — see below), all previewed in an editor viewport that matches what the public `ViewerPage` produces.

Status: implemented.

## Fixed-resolution stage (letterbox scale-to-fit)

Compose layout is **resolution-independent**. Each compose scene has a canonical pixel resolution (`composeScene.width` × `composeScene.height`, default 1920×1080 — new `compose_scene` rows default to 1920×1080 in `routes/compose-layers.ts`). Layer `x/y/width/height` are authored in that canonical pixel space, so the editor preview and the streamed viewer render identically regardless of window size.

`ComposeView` renders all layers into a fixed-size **stage** (`ComposeStage`, exported from `ComposeView.tsx`) whose intrinsic size is the canonical resolution; a `ResizeObserver` measures the container and the stage is CSS `transform: scale()` letterbox-fit (centered, aspect-preserving) into it. `ViewerPage` compose mode renders through the same `ComposeStage`. Helpers exported from `ComposeView.tsx`: `ComposeStage`, `composeSceneResolution(scene)` (falls back to the defaults for missing/zero dims), `DEFAULT_COMPOSE_WIDTH` / `DEFAULT_COMPOSE_HEIGHT`. The compose header shows a **read-only** `W×H` display; the resolution is edited in the compose-scene settings panel (see "Compose-scene settings panel" below).

The letterbox area around the stage (`ComposeView`'s viewport, editor only) is drawn as **diagonal two-tone grey stripes** (`const LETTERBOX_BG` in `ComposeView.tsx`) to signal "outside the canvas".

The interaction layer is **scale-aware** so gestures map screen pixels back to canonical pixels:

- `composeHitTest.ts` exposes a module-level `composeStageScale` getter (client→canonical scale); `layersAtClientPoint` divides the client-space rect by it before hit-testing.
- `composeLayerInteractions.ts` `ComposeFrame` gained a `scale` field; `startDrag` / `startResize` divide screen-space pointer deltas by it.
- `ComposeSelectionOverlay` renders **inside** the scaled stage (in canonical coords) and takes a `scale` prop to counter-scale its chrome (handle/border sizes) so handles stay a constant on-screen size.

`ComposeLayerStack` and the R3F `CameraCanvas` render at canonical layout size and are CSS-scaled by the stage. The `camera_view` layer's `CameraCanvas` is **keyed on the stage size** so it remounts when the resolution changes — see "Resolution-change remount" below.

## Compose-scene settings panel

Selecting a compose scene (compose tab, no layer selected) shows its settings in the right inspector via **`ComposeSceneProperties`** (exported from `ComposeLayerProperties.tsx`, wired from `PropertiesPanel.tsx` after the layer-selected branch: no `selectedComposeLayerId` → look up `activeComposeSceneId` in `composeScenes` → render `ComposeSceneProperties`). It holds:

- **Resolution** — a `VecInput` (`vs-compose-resolution`, W×H, floor 16) persisted to the `compose_scene` row's `width`/`height` (`updateComposeSceneLocal` + `PUT /compose-layers/:id`). This replaces the two `NumInput`s that used to live in the `ComposeView` header.
- **Preview background** — a source picker (`vs-compose-bg-mode`: transparent / color / image) writing `config.previewBg` (see below), with a color swatch (`vs-compose-bg-color`) or image-asset select (`vs-compose-bg-image`) shown per mode.

i18n keys under `compose.sceneProps.*` (`resolution`, `previewBgHeader`, `previewBgHint`, `previewBgMode`, `bgTransparent` / `bgColor` / `bgImage`).

### Preview background (editor-only)

A per-compose-scene `config.previewBg` (`PreviewBg` = `{ mode?: 'transparent' | 'color' | 'image', color?, assetId? }`, exported from `ComposeView.tsx`) drives the **editor** stage background via the exported helper `previewBgStyle(scene, assets)`. The default (missing / `'transparent'`) is a transparency **checkerboard** (`CHECKER_STYLE`), signalling that the real viewer/OBS output is transparent there; `'color'` fills with `config.previewBg.color`; `'image'` resolves `assetId` against the passed assets and uses it as a cover background. `ComposeView` spreads `previewBgStyle(composeScene, assets)` onto the stage. The **viewer** stage (`ComposeStage` in `ViewerPage`) stays transparent — the preview background never affects streamed output.

### Resolution-change remount

Changing the scene resolution left the `camera_view`'s R3F canvas backing stale (react-use-measure doesn't reliably re-measure a `Canvas` living inside the CSS transform-scaled stage). Fixed by keying the `camera_view`'s `CameraCanvas` on the stage size via **`ComposeStageSizeContext`** (a string context exported from `ComposeLayerStack.tsx`). Both `ComposeView` (editor) and `ViewerPage` (viewer) provide it with value `` `${canonW}x${canonH}` `` around their `ComposeLayerStack`; `CameraViewLayer` reads it and sets it as the `CameraCanvas` `key`, so the canvas remounts + re-measures on a resolution change. `CameraCanvas` keeps `resize={{ offsetSize: true }}` (measures unscaled layout/offset size, not the scaled bounding rect) so it fills its layer at canonical resolution.

## Compose scenes (decoupled from 3D scenes — migration 018)

Compose is now **independent** of the 3D `scene_nodes` tree. A compose hierarchy roots at a `compose_layers` row with `kind = 'compose_scene'`. Layers are **project-scoped** (the old per-3D-scene constraint is gone) and root back via `root_compose_scene_id`; nesting between layers goes through `parent_id` (migration 016).

Migration 018 specifics:

- Added `project_id` + `root_compose_scene_id` to `compose_layers` (backfilled from the prior `scene_id` join into `scene_nodes`).
- Created one `compose_scene` row per pre-existing 3D scene (id is the old scene_id + `_compose`), wired the legacy layers to point at it as their root.
- Dropped the `compose_layers.scene_id` column.

The frontend exposes compose scenes as a separate top-level concept from 3D scenes; the same scene-instancing flow (`1afa49d`) seeds a default compose scene per new project alongside its default 3D scene.

## Data Model

Table `compose_layers` (migration [008_compose_layers.sql](../../packages/backend/src/db/migrations/008_compose_layers.sql) + later patches 016, 018). Layers are project-scoped (was scene-scoped). `camera_node_id` is nullable — on a `camera_view` layer it names the 3D camera node whose output that layer renders. `parent_id` (migration 016) supports nesting (`compose_scene` → group layer → image, etc.). `root_compose_scene_id` (migration 018) points at the owning `compose_scene` row. `compose_scene` rows additionally carry `width`/`height` (the canonical compose resolution).

Per-layer fields:
- `kind`: `'compose_scene' | 'scene_include' | 'camera_view' | 'image' | 'video' | 'audio' | 'browser' | 'text' | 'feed' | 'group'`
- `asset_id` (image/video/audio), `url` (browser), or `camera_node_id` (camera_view)
- Layout: `x`, `y` (pixel offsets from anchor corner), `width`, `height`, `anchor` (`top|bottom × left|right`), `rotation` (degrees, CSS transform around centre)
- Display: `visible`, `name` (opacity is not a column — it lives in `config.opacity`)
- Ordering: `order_key` (TEXT, string fractional key) — see [Ordering](#ordering)

Shared types live in [packages/shared/src/types.ts](../../packages/shared/src/types.ts) (`ComposeLayer`, `ComposeLayerKind`, anchor enums) and Zod schemas in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) (`createComposeLayerSchema`, `updateComposeLayerSchema`).

## Ordering

Sibling order is a **string fractional key**: `compose_layers.order_key` (`orderKey` on the DTO), generated by [packages/shared/src/fracIndex.ts](../../packages/shared/src/fracIndex.ts). Migration [036_compose_layer_order_key.ts](../../packages/backend/src/db/migrations/036_compose_layer_order_key.ts) added it and dropped the integer `scene_order` / `camera_order` pair, backfilling each sibling group in its then-current paint order so the visible stack was unchanged.

- **Sort is `(orderKey, id)` ascending, and ascending = back→front.** Plain lexicographic on the key; `id` breaks the tie because two peers inserting into the same gap can generate the *same* key, and every peer has to break that tie identically. The alphabet is an ASCII subset in ascending byte order, so JS `<` and SQLite `BINARY` agree.
- **Scope is the sibling set `(rootComposeSceneId, parentId)`.** Nesting a layer restarts the range; keys from different groups are never compared. `compose_scene` rows (both fields null) are their own top-level group.
- **A move writes ONE row.** `keyBetween(before, after)` returns a key strictly between the moved layer's new neighbours, so no other sibling is touched and concurrent moves by two peers commute. The integer model renumbered the whole group on every drag (`1..n`), and LWW merged two such renumberings into a stack neither peer asked for. This is also why there is no bulk reorder endpoint any more — a move is a single-field update.
- **The 3D camera output is an ordinary layer** — a `camera_view` layer (`ComposeLayerStack.CameraViewLayer`, which mounts a `CameraCanvas`). It holds no privileged slot: siblings with a lower key paint behind it, higher keys in front.

Direction per consumer — they deliberately disagree, so check which one you are reading:

| Site | Sort | Why |
|---|---|---|
| `orderSiblings` ([ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx)) | ascending | paint order: first painted = back |
| `layersAtClientPoint` ([composeHitTest.ts](../../packages/frontend/src/components/editor/composeHitTest.ts)) | descending | a hit test wants the front-most layer first |
| `ComposeTree` rows, `moveComposeLayer` | descending | the tree lists front-first, so the row *above* is the sibling *after* in paint order |

Keys are generated in exactly four places: `commitLayerCreate` / `orderKeyForIndex` ([mesh/layerWrites.ts](../../packages/frontend/src/mesh/layerWrites.ts)), `moveComposeLayer` (tree drag-drop), `moveTo` ([ComposeLayerProperties.tsx](../../packages/frontend/src/components/editor/ComposeLayerProperties.tsx)), and `keyAfter(lastSiblingKey(…))` in [routes/compose-layers.ts](../../packages/backend/src/routes/compose-layers.ts) for a create that arrives without one. A new layer lands at the **front** of its sibling group.

Reordering UI: **drag-and-drop in the compose tree is primary** (see "Tree drag-and-drop"); the **Stack order** section of the properties panel has Back / Backward / Forward / Front buttons (`vs-layer-order-back` / `-backward` / `-forward` / `-front`) as the precision path. Both re-key only the moved layer. There are no numeric order inputs and no per-row nudge buttons.

`fracIndex` was written and unit-tested long before it was used — it shipped with the permissioned-sync-mesh design and was then *unreachable*: absent from `@vspark/shared`'s package.json exports map, the frontend tsconfig paths, and the vite/vitest aliases. Adopting it meant wiring all four (`035ab5a`). If you add a shared submodule, that is the checklist.

> **Historical — three successive ordering models. An old comment describing either of the first two is stale, not a design note.**
>
> 1. **Signed axis** (original compose implementation; already gone at the first commit of the current git history, 2026-07-04). The 3D render was a virtual `scene_order = 0` slot; `sceneOrder < 0` painted *in front* of it, `> 0` behind, with a pinned `[3D Scene]` row in the tree, and `camera_order` positioned per-camera layers inside a scene-wide layer's slot.
> 2. **Plain ascending integers** (live until 2026-08-12). `scene_order` ascending = back→front, the 3D output an ordinary `camera_view` layer, `camera_order` only a tie-break within one `scene_order` — which `moveComposeLayer` flattened to 0 on every reorder.
> 3. **Fractional `order_key`** (migration 036, 2026-08-12) — current, described above.
>
> Model 1's residue outlived model 1 by at least the whole span of the current git history, and produced two live bugs, both fixed on 2026-08-12. The DELETE route "re-anchored" camera layers that shared the deleted layer's `scene_order` (`d4155da`); under model 2 those integers were assigned per *sibling group*, so every group started at 1 and deleting a layer in one group silently moved an unrelated `camera_view` layer in another. And `layersAtClientPoint` sorted ascending while calling the result front-first (`035ab5a`) — true only under the signed model, so after the flip clicking overlapping layers picked the back-most one. An unused `SCENE_RENDER_SLOT = 0` constant survived in `shared/types.ts` until the same commit.

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

There is also a non-visual **`audio` layer kind** (`ComposeLayerStack.AudioLayer`):
a `<audio>` element that registers a `MediaHandle` and keeps playing even when the
layer is `visible:false` (the stack uses CSS `visibility:hidden`). Same playback
config (`autoplay`/`loop`/`muted`/`volume`) and audibility gate as video. See
[media.md](media.md) (Audio — 2D compose layer).

## Phase 1 additions (signal-graph expansion) — implemented

Graph-driven param mutation and a text layer kind.

- **Layer kind `'text'`.** `ComposeLayerStack.TextLayer` reads `content` from `layer.config.content`, with `runtimeLayerOverrides[layer.id]['text.content']` taking precedence at render time. When `layer.config.allowHtml` is true the content is sanitised via `DOMPurify` using the shared `TEXT_SANITIZE_OPTS` allow-list exported from `packages/frontend/src/lib/textSanitize.ts` (covers `b, i, em, strong, span, br, img` with whitelisted `img` attrs for overlive emote HTML); otherwise rendered as plain text. The `'text'` kind is registered in `ComposeTree`'s `KIND_ICONS` (📝) and `ADDABLE_KINDS`.
- **New paramPaths on `compose_layer`:** `opacity`, `width`, `height`, `text.content`. `ComposeLayerOverride` gains `width`, `height`, `opacity` so clip-side animation matches the new paths; `ComposeLayerStack.LayerView` merges both `composeLayerOverrides` (clip) and `runtimeLayerOverrides[layer.id]` into `layerStyle`. Conflict: clip wins for scalar/transform overlap; `text.content` is runtime-only. See [paramPaths.md](paramPaths.md), [runtime-overrides.md](runtime-overrides.md).
- **Tmp compose layers** spawned by `spawn_clip` arrive via standard `compose_layer_added` / `compose_layer_removed` WS messages and render through the same `LayerView` code path. See [spawn.md](spawn.md).
- **Schema:** `composeLayerKindSchema` (shared/schema.ts) and the frontend `ComposeLayerKind` union (`api/client.ts`) both gain `'text'`.

## Writes: mesh-authored CRUD + previews

Compose-layer CRUD is **authored on the tab's mesh peer**, not by REST calls. [mesh/layerWrites.ts](../../packages/frontend/src/mesh/layerWrites.ts) binds the `compose_layer` rtype to the generic helpers in [mesh/writes.ts](../../packages/frontend/src/mesh/writes.ts); a compose scene is just a layer row, so both slices go through the same adapter (`kind === 'compose_scene'` picks the store slice).

Why authorship matters: mesh-native undo lives on the peer that authors a **committed** write. A UI write that goes through REST is authored by the *server*, so it lands on nobody's undo stack.

- `commitLayerCreate` mints the id in the tab, so the create is this tab's and undoable. The backend re-derives the server-owned `projectId` in the collection's `validate` hook (`guardClientComposeLayer`, [backend/src/mesh/docGuards.ts](../../packages/backend/src/mesh/docGuards.ts)) and nacks what the REST route would have refused; a nack rolls the tab's optimistic write back. New layers land at the front of their sibling group — see [Ordering](#ordering).
- `commitLayerPatch` / `commitLayerPath` — one committed write = one undo step. Dotted paths stamp exactly their own path, so two tabs editing different fields of one layer no longer clobber each other the way the whole-doc REST `PUT` did.
- `commitLayerDelete` removes descendants **explicitly, children before parents**, inside one `meshBatch`. Leaving it to the server's SQL FK cascade would tombstone only the root, and undo would then restore a parent whose children are gone from the database for good. Deleting a compose scene is the same path.
- `commitPromoteLayerToNode` issues the node create and the layer removes inside one `meshBatch`. Grouping is bound when a write is **issued**, not when it is logged (with a remote authority the undo entry is only pushed on ack), so awaiting the create before issuing the delete would split one action in two.
- Every helper falls back to the REST route when the peer can't author the write (peer not armed, authority offline, or the replica doesn't hold the doc). The fallback is correct but **not undoable**.

Reads come back the same way: [sync/meshStoreFeeder.ts](../../packages/frontend/src/sync/meshStoreFeeder.ts) mirrors the `compose_layer` collection into the store's `composeScenes` / `composeLayers` slices, so a committed write re-renders through the normal selector path — there is no optimistic store write to make.

The REST routes still exist — they back the fallback ladder and are what scripted/e2e clients seed through — and they are mesh write-through: each validates, computes any server-owned field, then writes the canonical DTO into the mesh collection (`getMeshCollection('compose_layer')`) and returns the re-read row. The backend `onCommitted` tap is what persists it, saves the tombstone on a remove, and clears that target's runtime overrides (which is why the DELETE route no longer does either itself). Routes in [packages/backend/src/routes/compose-layers.ts](../../packages/backend/src/routes/compose-layers.ts):

- `GET    /projects/:projectId/compose-scenes`
- `POST   /projects/:projectId/compose-scenes`
- `GET    /compose-scenes/:composeSceneId/layers`
- `POST   /compose-scenes/:composeSceneId/layers`
- `PUT    /compose-layers/:id`
- `DELETE /compose-layers/:id`

The scenes bundle endpoint also returns `composeLayers` alongside `cameraEffects` so the editor hydrates everything in one request.

WebSocket kinds left for compose layers: `compose_layer_added` / `compose_layer_removed`, still emitted inline by the spawn manager for **ephemeral tmp layers** and handled in [hooks/useWsSync.ts](../../packages/frontend/src/hooks/useWsSync.ts) (see [spawn.md](spawn.md)). `compose_layer_updated`, `compose_layer_reordered` and `compose_layer_preview` survive only as members of the `WSMessageKind` union — no producer, no consumer.

### Previews (in-flight gestures)

Drag / resize / rotate ride the mesh **`preview` channel**: lossy, unstamped, unretained, capped at ~30 Hz per gesture (`PREVIEW_INTERVAL_MS` in `composeLayerInteractions.ts`). An ephemeral write lands as a per-key overlay composed over the retained doc on read, and is cleared by any retained write at or above its path — so the committed write at pointer-up supersedes it. Nothing is persisted and no undo entry is logged. This replaces the bespoke `compose_layer_preview` WS kind, which did the same job beside the mesh rather than through it.

Two properties are easy to get wrong:

- **One overlay per field.** `previewLayerFields` issues `col.set(id, field, value, { channel: 'preview' })` per key. A *pathless* ephemeral write is a **root** overlay, and `Replica.ephemeral` clears the per-path overlays when one lands — so a single `{ x: 400 }` root write would compose to a doc that is only `{ x: 400 }`, losing the id along with everything else.
- **The channel is the discriminator.** The feeder tweens (`smoothComposeLayer`) ops with `op === 'ephemeral'` and applies retained ops directly, because an ephemeral op *is* an in-flight gesture by construction and a retained op *is* model state. No heuristic, and a cold page load can't animate every layer in from wherever the store happened to sit. Mid-gesture the committed value retargets the running tween rather than snapping, because the preview channel is lossy and the final preview frame may never have landed.

With no peer able to author (offline authority), `previewLayerFields` still writes the store locally so the gesture stays visible in this tab.

## Tree drag-and-drop (reparent + reorder)

`ComposeTree` supports dragging a layer row onto another to reparent and reorder.
Drop classification is shared with the stage tree via `dropZoneFromEvent` /
`DropZone` in [components/editor/dnd.ts](../../packages/frontend/src/components/editor/dnd.ts)
(top/bottom ~28% bands = `before`/`after` sibling placement, middle = `inside`
nest-as-child).

`moveComposeLayer` handles both axes in **one committed write**: it computes the
new `orderKey` from the neighbours around the drop slot and adds `parentId` to the
same patch when the drop re-parents (see [Ordering](#ordering) for the key math and
for why the tree's front-first list swaps the neighbours). Dropping a layer onto a
compose scene's empty area moves it to that scene's **top level**
(`parentId: null`). A drag across compose *scenes* — and a Ctrl/⌘ copy-drop — goes
through `transferComposeLayer` instead (serialise → instantiate preset, then delete
the source), because the whole subtree has to be re-homed.

Compose scenes (`compose_scene` rows) are now **click-selectable** (selecting one
clears the layer/node selection) and carry their own context menu: **paste layer
at top level**, **paste logic**, and **delete scene**. i18n keys:
`compose.tree.ctx.pasteLayerAtRoot`, `compose.tree.ctx.nothingToPaste`,
`compose.tree.ctx.deleteScene`.

## Editor / Viewer Shared Renderer

[components/editor/ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx) is a single renderer used by both the editor's compose viewport and the public viewer:

- Layers are absolutely positioned DOM elements (HTML/CSS), not CSS3D or WebGL textures.
- **Layers nest by `parentId` and are positioned, rotated and sized relative to their parent — not the viewport.** The renderer builds a parent→children map and renders the tree recursively: each `LayerView` renders its children *inside* its own box, so a child's CSS `left/top/width/height` (and `%` units) resolve against the parent layer's content box and its `rotate(...)` transform composes with the parent's. A layer roots the stack when it has no parent, or its parent isn't part of the rendered set (e.g. the parent is the `compose_scene` row, or a dangling/cross-scene parent), mirroring `ComposeTree`'s nesting logic. `group` layers render as transparent container boxes (their `LayerContent` is empty); only the `compose_scene` root is excluded. **Layer boxes do not clip children by default** — `layerStyle` uses `overflow: visible` unless the layer's `config.clipContents === true`, so a child positioned outside its parent's box still shows (see "Layer QOL" below).
- Position is anchor-relative *within the parent box*: `(x, y)` is an offset from the chosen corner (`top|bottom × left|right`), so layers stay glued to e.g. the bottom-right of their parent at any size.
- Rotation is a CSS `transform: rotate(...)` around the layer centre, composing down the parent chain.
- A `mode: 'editor' | 'viewer'` prop toggles selection chrome rendering. Layer DOM is always `pointer-events: none` — in editor mode all input is owned by the capture overlay (see below), and viewer mode is fully non-interactive.
- `LayerView` (internal to `ComposeLayerStack`) is a pure presentation wrapper; it carries no pointer handlers and `ComposeLayerStack` no longer takes `selectedId`/`onSelect` props.

The editor viewport ([ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx)) renders a single `ComposeStage` (the fixed-resolution, CSS-scaled stage — see "Fixed-resolution stage" above) containing:

- one `ComposeLayerStack` for the whole scene (`pointer-events: none`). There is no behind/front split — the 3D camera output is a `camera_view` layer *inside* the stack (`CameraViewLayer` → `CameraCanvas`, which supplies the camera POV + `<Environment>` + `<CameraEffects>`), so its z-position is just its place in the sibling sort ([Ordering](#ordering)).
- `ComposeEventCapture` (owns all pointer + wheel input)
- `ComposeSelectionOverlay` (resize / rotate handles), rendered inside the scaled stage in canonical coords with a `scale` prop.

[ViewerPage.tsx](../../packages/frontend/src/pages/ViewerPage.tsx) renders the same `ComposeStage` + `ComposeLayerStack` (without the capture or selection layers) so what the user sees in the editor matches the streamed output.

## Input Model: Single Capture Overlay

All pointer + wheel input in the compose viewport is owned by one full-viewport invisible `<div>` at `zIndex 50`: [components/editor/ComposeEventCapture.tsx](../../packages/frontend/src/components/editor/ComposeEventCapture.tsx). Nothing underneath it receives events directly — layer DOM, the 3D canvas wrapper, and the selection chrome's body are all `pointer-events: none`. Only the resize/rotate handles on `ComposeSelectionOverlay` sit above the capture layer (`zIndex 100`) because they are precise hit targets.

This replaces an earlier model in which each interactive element had its own handler and routed events between themselves with `data-compose-*` markers, `stopPropagation`, and `document.elementsFromPoint`. Centralising input fixed a class of edge cases (e.g. `pointer-events: none` elements being silently invisible to `elementsFromPoint`) and removed the need for cross-element coordination.

### Capture dispatch

`ComposeEventCapture` does click-vs-drag detection on `pointerdown` (3px threshold) and dispatches deliberately:

- **Click** → `cyclePickAt` (cycles the topmost slot at the cursor: 2D layer or 3D node).
- **Drag with a 2D layer selected** → `startDrag` from `composeLayerInteractions`.
- **Drag with a 3D node selected** → `composeSceneDragStarter` (viewport-plane drag).
- **Drag with nothing selected** → run the cycle to pick the topmost slot under the cursor, then immediately start the appropriate drag.
- **Wheel** → `composeSceneWheel` (perspective camera: dolly the selected 3D node along the cursor ray; orthographic camera: scale the selected node — the per-frame integration runs inside the canvas via `useFrame`).

### Hit testing

[components/editor/composeHitTest.ts](../../packages/frontend/src/components/editor/composeHitTest.ts) exposes `layerFrame`, `layerParentFrame`, `pointInLayer`, and `layersAtClientPoint` so the cycle/capture path can do analytical hit-testing against layer rectangles. This avoids `document.elementsFromPoint`, which excludes `pointer-events: none` elements — the very state the new model relies on.

Because layers nest, the geometry is **composed through the ancestor chain**: `layerFrame(viewport, layer, byId)` walks the parent links (`byId` lookup, cycle-guarded), composing each ancestor's frame so a nested layer's rect is computed relative to its parent box and the parents' accumulated rotation, then projected into viewport space. The returned `LayerFrame` carries the centre, unit local axes, half-extents, and the accumulated rotation. `layerParentFrame` returns the frame of the coordinate system a layer's stored `x/y/width/height` live in (its parent box, or the viewport for a root) — used by the gesture math for the `%` basis and screen→local delta projection. Passing no `byId` treats the layer as a root (the prior viewport-relative behaviour).

It also exports a module-level `composeViewportRect` getter. `ComposeView` installs the current viewport's bounding-rect lookup at mount; other modules (capture, scene interactions) resolve viewport-relative coordinates through it instead of prop-drilling refs.

### Scene-side module handles

`ComposeSceneInteractions` (mounted inside the `<Canvas>`) installs module-level handles when it mounts, in addition to the existing `composeScenePicker`:

- `composeSceneDragStarter` — start a 3D viewport-plane drag for a node from screen coords.
- `composeSceneWheel` — apply a wheel impulse to the selected 3D node. For a **perspective** camera this dollies the node along the cursor ray; for an **orthographic** camera (dolly has no visual effect there) it instead **scales the node about the cursor point** using the same **dolly inertia** as the perspective path — the wheel adds an impulse to a log-scale velocity (`ln(scale)/sec`) that the `useFrame` integrator damps with the shared `WHEEL_DAMPING`, clamped to `[MIN_NODE_SCALE, MAX_NODE_SCALE]`, debounced-persisted.

The component itself no longer attaches an `onPointerDown` to its wrapper `<group>` nor a wheel listener on a DOM ref (the old `wheelTargetRef` prop is gone). Its in-canvas responsibility is just the `useFrame` integrator that consumes the wheel-impulse state. All pointer/wheel entry happens outside the canvas via the capture overlay.

## Anchor-Aware Drag / Resize / Rotate

The gesture math itself lives in [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts) and is invoked by the capture overlay (drag) and the selection-overlay handles (resize, rotate):

All three gestures operate in the layer's *parent* frame, supplied as a `ComposeFrame` (`{ width, height, angle }` — the parent box dims + accumulated rotation, resolved by `layerParentFrame` at the call site). This is what keeps a nested layer's drag/resize relative to its parent.

- `startDrag` — translates pointer delta into `(x, y)` delta. The screen-space delta is first projected onto the parent's local axes (via the parent `angle`) so a layer under a rotated parent tracks the cursor along the parent's orientation; the `%` basis is the parent box. Because `x/y` are offsets from the anchor corner, signs depend on which corner the layer is anchored to (e.g. dragging right increases `x` for left-anchors but decreases `x` for right-anchors).
- `startResize` — 8 handles (corners + edges) on `ComposeSelectionOverlay`. The sign math is anchor-aware so that dragging a handle in a given screen direction always grows or shrinks the layer the way the user expects, regardless of which corner the layer is anchored to. Concretely: for each axis, the resize delta is multiplied by `±1` based on (handle side) XOR (anchor side), so the handle nearest the anchor moves the anchor-relative origin while the far handle only changes size. The local-axis projection uses the layer's *accumulated* rotation (parent angle + own rotation); the anchored-edge pin only applies when fully axis-aligned, otherwise the layer grows from its centre (v1).
- `startRotate` — drag around the layer centre from the rotate handle; pointer angle relative to centre becomes `rotation` degrees. Since the parent is fixed during the gesture, the screen-angle delta equals the (parent-relative) rotation delta, so no extra compensation is needed.

All three gestures apply to the Zustand store during the drag for instant local feedback and emit throttled previews on the mesh `preview` channel for other tabs, then commit the final state with one `commitLayerPatch` on `pointerup` — one committed write, one undo step. See "Writes: mesh-authored CRUD + previews".

## Layer QOL

Editor-only quality-of-life polish in `ComposeLayerStack` / `ComposeLayerProperties` / `ComposeSelectionOverlay`:

- **Clip contents toggle.** Off by default (`overflow: visible`); a per-layer "Clip contents to bounds" checkbox (`ComposeLayerProperties`, `vs-layer-clip`) sets `config.clipContents = true` to clip children to the layer box.
- **Empty-layer placeholders.** An image / video / browser layer with no asset/url renders an editor-only placeholder (a labelled icon) via `Placeholder`, which gained a `mode` prop and renders **nothing** in viewer mode — so the streamed output shows empty, not a placeholder. The placeholder uses container-query units (`containerType: 'size'`, `cqmin` font sizes) so the icon scales with the box and visibly fills the element at its real dimensions.
- **Selection opacity floor.** In editor mode the selected layer gets an opacity floor of 0.25 (`ComposeLayerStack` `boostOpacityIds`), so a near-invisible layer stays visible/editable while selected. The floor now covers the **whole branch** the selection sits on — `boostOpacityIds` walks up to the top-level (branch-root) ancestor, then collects that root's entire subtree — so everything grouped with the selection stays visible, not just the direct ancestor path. Viewer mode is unaffected.
- **Container-ancestor outlines.** `ComposeSelectionOverlay` draws dashed outlines of the selected layer's container (group / nesting) ancestors so the nesting context is visible while editing a child.

## Image drag-and-drop (OS files)

Dropping OS image files onto the compose viewport (`ComposeView` `onDrop`, filtered to `image/*`):

- onto **empty space** → uploads the image and creates a new `image` layer at the cursor (canonical coords), one per dropped file, cascading;
- onto an existing **image layer** → replaces that layer's asset;

A `dropTarget` state (`'new'` or a layer id) drives a highlight so the target is shown during the drag. The upload reuses the AssetManager upload path; AssetManager's own upload `<input>`s now also accept `multiple` files (`handleUploadFiles(FileList)`). See [asset-management.md](asset-management.md).

## Frontend Pieces

- [store/editorStore.ts](../../packages/frontend/src/store/editorStore.ts) — adds `composeLayers`, `composeScenes`, `activeComposeSceneId`, `leftTab` (`'scene' | 'compose' | 'graphs'`), `selectedComposeLayerId` and matching actions.
- [components/editor/ComposeTree.tsx](../../packages/frontend/src/components/editor/ComposeTree.tsx) — left-dock tree of the active compose scene's layers, listed front-first (the 3D output appears as a `camera_view` layer row, 📷). Per-row buttons: visibility, lock, `×` delete (`vs-layer-visibility` / `vs-layer-lock` / `vs-layer-delete`) — reordering is drag-and-drop, see [Ordering](#ordering). Add menu picks layer kind. Right-click context menu uses the generic `ContextMenu.tsx` (`13f0021`); supports Copy/Paste (compose-layer preset) — see [clipboard.md](clipboard.md). Supports drag-and-drop reparent/reorder and compose-scene selection (see below).
- [components/editor/ComposeView.tsx](../../packages/frontend/src/components/editor/ComposeView.tsx) — central viewport; renders the active compose scene into the fixed-resolution `ComposeStage` (striped `LETTERBOX_BG` around it, `previewBgStyle` on it); header shows a read-only `W×H` display. Also exports `ComposeStage` / `composeSceneResolution` / `DEFAULT_COMPOSE_WIDTH` / `DEFAULT_COMPOSE_HEIGHT` / `previewBgStyle` / `PreviewBg`, shared with `ViewerPage` and `ComposeLayerProperties`.
- [components/editor/ComposeLayerStack.tsx](../../packages/frontend/src/components/editor/ComposeLayerStack.tsx) — shared editor/viewer renderer (presentation only; no pointer handlers).
- [components/editor/ComposeEventCapture.tsx](../../packages/frontend/src/components/editor/ComposeEventCapture.tsx) — full-viewport input overlay; owns pointer + wheel routing.
- [components/editor/composeHitTest.ts](../../packages/frontend/src/components/editor/composeHitTest.ts) — analytical layer hit-testing + `composeViewportRect` module-level getter.
- [components/editor/composeLayerInteractions.ts](../../packages/frontend/src/components/editor/composeLayerInteractions.ts) — drag / resize / rotate gesture math.
- [components/editor/ComposeSelectionOverlay.tsx](../../packages/frontend/src/components/editor/ComposeSelectionOverlay.tsx) — selection chrome; resize + rotate handles only (no drag body — the capture overlay handles drag). Renders inside the scaled stage in canonical coords; takes a `scale` prop to counter-scale handle chrome and also draws dashed container-ancestor outlines.
- `ComposeSceneInteractions` (inside the Canvas) — installs `composeScenePicker`, `composeSceneDragStarter`, `composeSceneWheel` module handles and runs the `useFrame` wheel-impulse integrator.
- [components/editor/ComposeLayerProperties.tsx](../../packages/frontend/src/components/editor/ComposeLayerProperties.tsx) — right-panel properties (name, x/y, anchor, w/h, rotation, visibility, opacity, "Clip contents to bounds" toggle `vs-layer-clip`, kind-specific asset/url, and the **Stack order** buttons — see [Ordering](#ordering)). Wired into `PropertiesPanel` ahead of the effect/scene branches. Also exports **`ComposeSceneProperties`** (compose-scene resolution + preview background — see "Compose-scene settings panel").

See also [frontend.md](frontend.md) for general editor structure and store conventions.

## Cross-References

- [mesh.md](mesh.md) — the replicated document store the compose writes above run on: collections, channels, grants, undo, and the backend bindings/`onCommitted` tap.
- Backend route registration and the scenes bundle additions are also covered in [backend-api.md](backend-api.md).
- The Compose viewport reuses the same `<CameraEffects>` pipeline as the main viewport; see [camera-effects.md](camera-effects.md).
- Mouse-wheel inside the compose viewport never orbits/zooms the camera; instead the capture overlay forwards it to `composeSceneWheel`, which dollies the currently-selected 3D node along the cursor ray (perspective) or scales it (orthographic).
- The legacy single-camera viewer route `/viewer/:projectId/:nodeId` renders **only** the camera's 3D output (no compose layers). Compose layers are shown exclusively by the compose-scene viewer (`/viewer/:projectId/compose/:composeSceneId`, via the `composeSceneId` param), whose whole stack — including the `camera_view` 3D layer — is the streamed output. Both render through `ComposeStage`.
- [track-clips.md](track-clips.md) — track clips can target compose-layer `layer.x`, `layer.y`, `layer.rotation`. `ComposeLayerStack.LayerView` subscribes per-layer to `composeLayerOverrides[layer.id]` in the Zustand store and merges over the base on render. Overrides are runtime-only (never persisted); for `relative`-mode clips the evaluator pre-folds the base in, so the merge is always a plain replace.

## Known Limitations / Future Work

- Ordering has no cross-sibling-set affordance: a layer can only be re-keyed within its own `(rootComposeSceneId, parentId)` group, so "move in front of that layer over there" is a reparent first (drag onto the target's parent), then a reorder. See [Ordering](#ordering).
- Nesting composes translation + rotation only; there is no parent→child *scaling*, so a child sized in `px` keeps its pixel size when the parent is resized (use `%` width/height for proportional children). Layer boxes no longer clip children by default (`overflow: visible`); opt into clipping per-layer via the "Clip contents to bounds" toggle (`config.clipContents`).
- Selection-chrome / gesture geometry composes ancestors from their *base* (persisted) transforms; an active clip/runtime override animating a parent layer is not folded into a child's hit-test frame while editing that child.
