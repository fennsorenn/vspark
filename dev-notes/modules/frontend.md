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

**Scene state**
- `projectId`, `projectName`
- `scenes: SceneItem[]`, `activeSceneId`
- `nodes: NodeRecord[]`, `selectedNodeId`

**Component state**
- `nodeComponents: NodeComponent[]`, `selectedComponentId`
- `vmcStatus: Record<componentId, boolean>` — receiver connected
- `vmcTracking: Record<componentId, boolean>` — motion detected

**VRM skeleton**
- `vrmBonesByNode: Record<nodeId, string[]>`
- `vrmExpressionsByNode: Record<nodeId, string[]>`
- `vrmMorphTargetsByNode: Record<nodeId, string[]>`

**Signal graph**
- `activeGraphId`, `selectedSignalNodeId`
- `componentKinds`

**Camera effects**
- `cameraEffects: CameraEffect[]`, `selectedEffect`
- 16 effect kinds: ToneMapping, Bloom, Vignette, DOF, ChromaticAberration, SSAO, Outline, Noise, Scanline, Pixelation, ASCII, DotScreen, Glitch, SMAA, TiltShift, Water

Actions are standard Zustand setters; all CRUD actions also call the relevant REST endpoint.

## WebSocket sync — `hooks/useWsSync.ts`

Maintains a persistent WS connection to `/ws` (auto-selects `wss` on HTTPS). Auto-reconnects every 3 seconds.

Incoming message handlers:
| Kind | Effect |
|------|--------|
| `vmc_status` | `setVmcStatus(componentId, connected)` |
| `vmc_tracking_state` | `setVmcTracking(componentId, tracking)` |
| `vmc_pose` | Writes pose data into store for Viewport to consume |
| `vmc_blendshapes` | Writes blendshape weights into store |
| `node_updated` | Patches node in store |
| `node_added` | Adds node to store (dedup check) |
| `node_removed` | Removes node from store |
| `camera_effect_added/updated/removed` | Updates effects slice |

## Browser uplinks

### `hooks/useLipsyncUplink.ts`
Polls mic analysis at ~30fps (33ms throttle). Reads `mic.getVisemes()` and sends `{ kind: 'lipsync_input', componentId, visemes }` over WS.

### `hooks/useTrackingUplink.ts`
Wires MediaPipe camera result callback. On each frame, sends `{ kind: 'tracking_input', componentId, ...result }` over WS. Rate is set by MediaPipe's native output (~30fps).

## 3D Viewport — `components/editor/Viewport.tsx`

React Three Fiber canvas. Responsible for the entire 3D scene.

**Registries** (module-level Maps, not React state — for performance):
- `nodeGroupRegistry: Map<nodeId, THREE.Group>` — scene node → 3D object
- `vrmRegistry: Map<nodeId, VRM>` — avatar nodes → loaded VRM instance
- `godrayCasterRegistry: Map<nodeId, THREE.Mesh>`

**Per-frame work** (`useFrame`):
1. Read `vmc_pose` from store → apply quaternions to VRM bones
2. Read `vmc_blendshapes` → apply weights to VRM morph targets
3. Advance timeline animations
4. Simulate particles

**Animation retargeting**: FBX/BVH bone names → VRM bone names. Supports Mixamo and UE4 rig conventions. World-space delta retargeting (not local-space — see memory `feedback_fbx_retargeting.md`).

**Calibration**: `VmcCalibration` data (body offsets, arm IK params) is applied as post-processing on incoming poses before setting VRM bones.

**Post-processing effects**: Applied per camera node's `cameraEffects` list. Each effect kind maps to a `@react-three/postprocessing` effect.

**Particle system**: Emission and simulation handled entirely within Viewport via a custom particle buffer.

## Editor panels

### `SceneGraph.tsx`
Node hierarchy tree. Context menu: Add Child, Move Into, Unparent, Delete. Expandable bone list per avatar node with VRM expression/bone visualization. Hidden node toggle.

### `PropertiesPanel.tsx`
Inspector for the selected node. Sections:
- **Transform**: position, rotation, scale with drag-to-adjust (ns-resize NumInput)
- **Light**: type, color, intensity
- **Camera**: fov, near, far
- **Components**: per-kind config editors for VMC receiver, breathing, lipsync, tracking; calibration wizard (head neutral, arm reach captures)
- **Animation clips**: clip selection and playback
- **Camera effects**: add/configure post-processing per camera
- **Particle emitter**: emitter config
- **FBX debug**: toggle debug model visibility

### `AssetManager.tsx`
File upload and asset library. Sends base64-encoded files to `POST /api/projects/:id/assets`.

### `signal/SignalGraphCanvas.tsx`
Visual graph editor. Renders `SignalNodeCard` components connected by bezier edges. Node palette via `NodePalette`. Supports node drag, edge drawing, and live port value display (via `/api/signal/graphs/:id/node-states` polling).

## VRM loading

VRM files are loaded in Viewport using `@pixiv/three-vrm` with a GLTF loader plugin. On load, bone and expression names are extracted and written into the store (`vrmBonesByNode`, `vrmExpressionsByNode`). The `vrm/skeleton.ts` backend module mirrors this extraction server-side for use by `arm_ik_calibration`.
