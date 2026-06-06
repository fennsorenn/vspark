# Frontend

React + React Three Fiber application. Entry: `packages/frontend/src/`.

## Routes — `App.tsx`

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | Home | Project list and selection |
| `/editor/:projectId` | Editor | Main workspace |
| `/viewer/:projectId/:nodeId` | Viewer | Read-only 3D view |
| `/media-input/:projectId` | MediaInput | Mic + camera capture page |

## State — `store/editorStore.ts`

Single Zustand store for the entire editor session. Key slices:

**Update state**
- `updateAvailable: boolean`
- `updateInfo: UpdateInfo | null` — version, release notes, download URL
- `pendingReload: boolean` — set after an update is applied; triggers a page reload on the next WS reconnect

Actions: `setUpdateAvailable(info)`, `setPendingReload(value)`.

**Scene state**
- `projectId`, `projectName`
- `scenes: SceneItem[]`, `activeSceneId`
- `nodes: NodeRecord[]`, `selectedNodeId`

**Behavior state**
- `behaviors: Behavior[]`, `selectedBehaviorId`
- `vmcStatus: Record<behaviorId, boolean>` — receiver connected
- `vmcTracking: Record<behaviorId, boolean>` — motion detected

**VRM skeleton**
- `vrmBonesByNode: Record<nodeId, string[]>`
- `vrmExpressionsByNode: Record<nodeId, string[]>`
- `vrmMorphTargetsByNode: Record<nodeId, string[]>`

Default per-avatar expression weights are stored on the scene node itself, not in a dedicated slice: `node.properties.defaultExpressions` (`Record<expressionName, number>`, only non-zero weights kept). Mirrored on the store `NodeProperties` and the api-client `NodeProperties`; the shared field is `SceneNodeProperties.defaultExpressions`.

**Logic / signal graph**
- `activeLogicId` (the active Logic; substrate canvas still `SignalGraphCanvas`), `selectedSignalNodeId`
- `behaviorKinds`

**Clipboard**
- `clipboardPayload: ClipboardPayload | null` — sync mirror of the OS clipboard for context-menu gating; see [clipboard.md](clipboard.md).

**Camera effects**
- `cameraEffects: CameraEffect[]`, `selectedEffect`
- 16 effect kinds: ToneMapping, Bloom, Vignette, DOF, ChromaticAberration, SSAO, Outline, Noise, Scanline, Pixelation, ASCII, DotScreen, Glitch, SMAA, TiltShift, Water

Actions are standard Zustand setters; all CRUD actions also call the relevant REST endpoint.

## WebSocket sync — `hooks/useWsSync.ts`

Maintains a persistent WS connection to `/ws` (auto-selects `wss` on HTTPS). Auto-reconnects every 3 seconds.

Incoming message handlers:
| Kind | Effect |
|------|--------|
| `vmc_status` | `setVmcStatus(behaviorId, connected)` |
| `vmc_tracking_state` | `setVmcTracking(behaviorId, tracking)` |
| `vmc_pose` | Writes pose data into store for Viewport to consume |
| `vmc_blendshapes` | Writes blendshape weights into store |
| `node_updated` | Patches node in store |
| `node_added` | Adds node to store (dedup check) |
| `node_removed` | Removes node from store |
| `camera_effect_added/updated/removed` | Updates effects slice |
| `server_update` | Sets `updateAvailable` + `updateInfo` in store |

**pendingReload-on-reconnect**: a `pendingReloadRef` (not store state — avoids re-render) is set when a `server_update` message carries `reloadOnReconnect: true`. On the next `ws.onopen`, if the ref is set, the page is reloaded. Normal reconnects are unaffected.

## Browser uplinks

### `hooks/useLipsyncUplink.ts`
Polls mic analysis at ~30fps (33ms throttle). Reads `mic.getVisemes()` and sends `{ kind: 'lipsync_input', behaviorId, visemes }` over WS.

### `hooks/useTrackingUplink.ts`
Wires MediaPipe camera result callback. On each frame, sends `{ kind: 'tracking_input', behaviorId, ...result }` over WS. Rate is set by MediaPipe's native output (~30fps).

## 3D Viewport — `components/editor/Viewport.tsx`

React Three Fiber canvas. Responsible for the entire 3D scene.

**Registries** (module-level Maps, not React state — for performance):
- `nodeGroupRegistry: Map<nodeId, THREE.Group>` — scene node → 3D object
- `vrmRegistry: Map<nodeId, VRM>` — avatar nodes → loaded VRM instance
- `godrayCasterRegistry: Map<nodeId, THREE.Mesh>`

**Material overrides (implemented)**: after VRM load and whenever `node.properties.materialOverrides` changes (effect keyed on `JSON.stringify` of the record; VRM-loaded signal is `vrmBonesByNode`), Viewport calls `applyMaterialOverrides(vrm, overrides)` from `components/editor/materialOverrides.ts` to switch each material between MToon and PBR and apply per-material param overrides. `disposeMaterialOverrides(vrm)` is called on VRM unload to free the lazily-built PBR materials. See [material-overrides.md](material-overrides.md).

**Per-frame work** (`useFrame`):
1. Read `vmc_pose` from store → apply quaternions to VRM bones
2. Apply expressions/blendshapes (see below)
3. Advance timeline animations
4. Simulate particles

**Expression/blendshape application** (pre-`expressionManager.update()` pass): default expression weights (`node.properties.defaultExpressions`) are applied first via `vrm.expressionManager.setValue` as a per-frame baseline, then the latest broadcast blendshapes (`getVmcBlendshapes`) are overlaid on top. So live broadcasts (VMC, lipsync, tracking) override the defaults per-key, and the defaults re-assert when the bus emits an empty record (no active producer). The morph-target-name guard (`!morphMap.has(name)`) is preserved.

**Pose gate (current rules, implemented)**: the `vmcCompRef` and tracking-lost gates were dropped. The broadcast pose is applied whenever `pose != null && Object.keys(pose).length > 0 && fresh`. The bus's fallback frame (empty `bones`) trips application off — that is the sole "stop applying" signal.

`blendMode` no longer gates whether the pose is applied; it selects the composition strategy inside Step 2:

- **override**: broadcast pose fully replaces the animation result (existing logic).
- **additive**: layered on top of animation per-bone. For each bone present in the broadcast pose:
  1. Read the bone's *rest raw* quaternion captured at avatar load (`restRawQ`).
  2. Treat the broadcast quaternion as the *posed raw* (`posedRawQ`).
  3. Extract the source-rig delta: `delta = restRawQ⁻¹ * posedRawQ`.
  4. Compose: `bone.quaternion = animQ * delta`, then slerp from `animQ` toward this result by `blend`.

  Bones absent from the broadcast pose are restored to `animQ`. This is how breathing (and any future additive producer) layers cleanly on top of an FBX-driven animation.

`blendTransitionTime` is now read from the VRM avatar node's `properties.blendTransitionTime` (default 0.5s) and controls the ramp between blend modes (and between "apply" and "don't apply" when the bus drops the last producer).

`poseTimeout` is retained as a client-side safety net for missed WS transition messages — flagged for review once the new flow proves robust. See [component-managers.md](component-managers.md) BroadcastBus section.

**Animation retargeting**: FBX/BVH bone names → VRM bone names. Supports Mixamo and UE4 rig conventions. World-space delta retargeting (not local-space — see memory `feedback_fbx_retargeting.md`).

**Calibration**: `VmcCalibration` data (body offsets, arm IK params) is applied as post-processing on incoming poses before setting VRM bones.

**Post-processing effects**: Applied per camera node's `cameraEffects` list. Each effect kind maps to a `@react-three/postprocessing` effect.

**Particle system**: Emission and simulation handled entirely within Viewport via a custom particle buffer.

## TopBar + UpdateDialog — `components/editor/TopBar.tsx` + `components/editor/UpdateDialog.tsx`

TopBar checks update status on mount (`GET /api/update-status`). When an update is available it shows an amber "↑ Update" badge. A "⚙ ver" button is always visible and opens `UpdateDialog`.

`UpdateDialog` is a floating panel (top-right, dark style matching MediaInputWindow):
- Displays current version, latest version, and scrollable release notes.
- **Channel selector**: dropdown for `stable` / `recent` / `experimental`; saves to `config.json` via `PUT /api/config`.
- **Update Now flow**: `POST /api/update/download` → polls `GET /api/update-status` until `downloadReady` → `POST /api/update/apply` (server exits; client reloads on reconnect via `pendingReloadRef`).
- **Later**: dismisses the dialog without downloading.

## Editor panels

### `SceneGraph.tsx`
Node hierarchy tree. Context menu: Add Child, Move Into, Unparent, Delete. Expandable bone list per avatar node with VRM expression/bone visualization. Hidden node toggle.

### Main view ↔ tab binding
The center view is bound strictly to the left-dock tab (`leftTab`, `Editor.tsx`): **Scene** → 3D `Viewport` (kept mounted, just hidden under other tabs, to preserve the WebGL context), **Logic** (the tab labelled "Logic"; `leftTab` value is still `'graphs'`) → `SignalGraphCanvas` (or a placeholder when no logic is open), **Compose** → `ComposeView`. The bottom dock shows the signal `NodePalette` on the Logic tab and the `AssetManager` otherwise. Opening any logic routes through `setActiveLogic`, which also switches `leftTab` to `'graphs'` (see [project-graphs.md](project-graphs.md)).

The right-hand `PropertiesPanel` is likewise tab-scoped: **Scene** targets 3D scene nodes (and their behaviors / camera effects / scene settings) only, **Compose** targets compose layers, **Logic** shows a placeholder (signal nodes are edited inline on the canvas). A leftover selection from another tab never leaks into the inspector.

### Left dock — Compose tab
Second tab in the editor's left dock alongside Scene Graph (and Logic). `leftTab` state (`'scene' | 'compose' | 'graphs'`; the `'graphs'` value drives the "Logic" tab) lives in the store. The tab is disabled until at least one camera node exists. Selecting it swaps the centre viewport to `ComposeView`, which renders the chosen camera's output: 3D canvas sandwiched between two `ComposeLayerStack` DOM stacks (behind / in front), reusing `<SceneNodes>` + `<CameraEffects>` so it matches `ViewerPage`. The same `ComposeLayerStack` runs in `ViewerPage` (in `mode='viewer'`) so the streamed output matches the editor preview. Per-layer fields are edited via `ComposeLayerProperties` in `PropertiesPanel`. See [compose.md](compose.md) for the data model, ordering scheme, and anchor-aware drag/resize math.

### `PropertiesPanel.tsx`
Inspector for the selected node. Sections:
- **Transform**: position, rotation, scale with drag-to-adjust (ns-resize NumInput)
- **Light**: type, color, intensity
- **Camera**: fov, near, far
- **Behaviors** (tab labelled "Behaviors"): per-kind config editors for VMC receiver, breathing, lipsync, tracking; calibration wizard (head neutral, arm reach captures)
- **Avatar**: VRM-node controls — idle-animation URL (with `<datalist>`) + speed/offset + playback transport; **Default Expression** sliders; read-only **Morph Targets** list
- **Animation clips**: clip selection and playback
- **Camera effects**: add/configure post-processing per camera
- **Particle emitter**: emitter config
- **FBX debug**: toggle debug model visibility

**Blend-time relocation + breathing UI (implemented)**:
- `blendTime` removed from the vmc_receiver behavior UI.
- New **Blend transition** input on VRM avatar nodes writes to `node.properties.blendTransitionTime` (persisted via the `scene_nodes.properties` JSON column, migration 007). Default 0.5s. Controls the Viewport ramp between blend modes and between apply/don't-apply.
- New `BreathingProps` panel for breathing behaviors: **Chest amplitude** + **Shoulder lift** fields, writing to behavior config `chestAmplitude` / `shoulderAmplitude`. See [component-managers.md](component-managers.md) BreathingManager.

**Avatar section (implemented)**:
- The inline animation-asset list (the grid of clickable animation buttons) was removed. Animations are picked via the bottom-dock **Animations** tab; the Avatar section's **Pick…** button only flashes that tab. The idle-animation URL input (with `<datalist>`), speed/offset inputs, and playback transport remain.
- The previously read-only **Expressions** list is now a **Default Expression** control: one 0..1 `SliderInput` per VRM expression. Weights are stored on `node.properties.defaultExpressions` (only non-zero kept) and persisted via `api.updateNode({ properties: { defaultExpressions } })`, which the backend shallow-merges (same mechanism as `blendTransitionTime`). The read-only **Morph Targets** list is unchanged.

**Material section (implemented)**:
- New **Material** section on VRM avatar nodes plus a reusable `CollapsibleSection` primitive (default collapsed); the **Default Expression** section is collapsible too. One collapsible row per material with a 3-way MToon/PBR/APBR shader toggle (APBR = `MeshPhysicalMaterial` advanced lobes under a nested **Advanced** disclosure), editable shader params (overlap + active-shader-only; PBR+APBR share roughness/metalness/envMapIntensity; normal scale only with a normal map, alpha cutoff only in mask mode, outline only when the material has one), and a per-material Reset. Overrides persist on `node.properties.materialOverrides` (same `node.properties` mechanism as `defaultExpressions`). The apply layer that mutates/swaps live three.js materials lives in `components/editor/materialOverrides.ts` and is invoked from `Viewport.tsx`. See [material-overrides.md](material-overrides.md).

### `AssetManager.tsx` (bottom dock)
The bottom dock. Tabs (`BottomDockTab` in the store, persisted to localStorage
alongside `leftTab` + dock height): **Create, Models, Animations, Images,
Behaviors, Effects, Timeline, Presets** (the "Behaviors" and "Timeline" tabs were
formerly labelled "Components" and "Clips"). File upload sends base64 to
`POST /api/projects/:id/assets`. Collections render as responsive tile grids.

- **Create palette** (`CreatePalette.tsx`) — node kinds (when the left dock is
  on Scene) or compose-layer kinds (when on Compose). The scene / compose-scene
  `+` buttons no longer open their own dropdowns; they switch to this tab and
  pulse it via `flashBottomTab` (a timestamp the dock watches to run a one-shot
  CSS flash on the active tab).
- **Shared kind registry** (`createKinds.ts`) — `NODE_KIND_DEFS` / `LAYER_KIND_DEFS`
  + `createSceneNode` / `createLayer` / `createNodeFromModelAsset` /
  `createBillboardFromImageAsset` / `nextNodeName` / `behaviorCompatibleWith`,
  consumed by the scene tree, compose tree, and Create palette so all three add
  entities the same way. Creation auto-names (deduped), selects the new entity,
  and `requestFocusName()` focuses the Properties name field for inline rename.
- **Drag-create** (`dnd.ts`) — Create tiles and asset cards are draggable onto
  the scene tree (root / node-as-child), the viewport (scene root), and — for
  layer tiles — a compose scene. Custom MIME types (`DND_CREATE_NODE` /
  `DND_CREATE_LAYER` / `DND_ASSET`) so they don't collide with the internal
  reparent drag; `handleSceneNodeDrop` is the shared drop handler.
- **Tab relevance** — tabs relevant to the current selection get an accent
  (non-destructive; nothing hidden/disabled). Behaviors are split into
  compatible vs "Other" via `behaviorCompatibleWith` (same split
  fixes the scene-tree inline add-behavior menu's prior over-filter).
- **Thumbnails** — `AssetThumb.tsx` previews images directly and lazily renders
  cached 3D thumbnails for models via the shared offscreen renderer in
  `modelThumb.ts`. Animation assets render their skeleton (`THREE.SkeletonHelper`,
  meshes hidden) at the clip's mid-frame and play it on hover via a single
  shared overlay canvas — see `animPreview.ts` (FBX + BVH). Model + animation
  thumbnails are persisted to the backend (`thumbCache.ts` → `PUT
  /api/assets/:id/thumbnail`, served from `/uploads/<project>/thumbnails/`), so
  the expensive WebGL render only happens once per asset rather than every
  session.
- **Pickers** — `PropertiesPanel` "Pick…" buttons (animation / texture /
  background) flash the relevant asset tab (flash-only; the tab's existing
  "Apply to <node>" buttons do the assignment).

### `signal/SignalGraphCanvas.tsx`
Visual graph editor. Renders `SignalNodeCard` components connected by bezier edges. Node palette via `NodePalette`. Supports node drag, edge drawing, and live port value display (via `/api/signal/graphs/:id/node-states` polling).

## VRM loading

VRM files are loaded in Viewport using `@pixiv/three-vrm` with a GLTF loader plugin. On load, bone and expression names are extracted and written into the store (`vrmBonesByNode`, `vrmExpressionsByNode`). The `vrm/skeleton.ts` backend module mirrors this extraction server-side for use by `arm_ik_calibration`.
