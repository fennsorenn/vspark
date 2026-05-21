# Component Managers

Managers live in `packages/backend/src/node_components/`. Each manager owns the full lifecycle of a specific component kind: it instantiates signal graphs from descriptors, wires them to their data source (UDP socket, WebSocket message, timer), and persists graph node state back to the DB.

## Pattern shared by all managers

```
DB node_components row
  → syncComponents(rows) called by API after any CRUD
    → diff running vs desired state
    → start/stop/reload graph instances as needed
  → graph runs; nodes call setState(nodeId, state)
    → manager persists state into config._nodeState namespace in DB
  → on restart: syncComponents() restores state via getState callbacks
```

State lives in `config._nodeState[nodeId]` so it survives restarts without a separate DB column.

---

## VmcManager — `vmc_receiver/manager.ts`

Manages VMC/RhyLive motion capture receivers. Each component gets its own UDP socket and `SignalGraph`.

**Input**: UDP OSC packets on a configurable port  
**Output**: `vmc_pose` and `vmc_blendshapes` WebSocket broadcasts

**Packet formats handled** (no external OSC library):
- `/VMC/Ext/Bone/Pos` — Unity HumanBodyBones rotation array
- `/Body` — RhyLive 220+ float array
- `/Face` — ARKit 52-shape weight array

**Graph descriptor**: `makeVmcGraphDescriptor(componentId)` wires:
```
vmc_packet_source → rhylive_bone_mapper → body_calibration → arm_ik_calibration → pose_broadcast
                  → arkit_vrm_mapper (×3) → blendshapes_sum → blendshapes_broadcast
```

**Tracking detection**: Frame-to-frame delta compared to a threshold; sets `vmcTracking` flag broadcast over WS.

**Interceptors**: `OnPoseBroadcast` nodes from other components (breathing) are registered into the VMC graph's interceptor chain. Cleanup callbacks are stored per receiver so they're removed on stop.

**VRM skeleton loading**: On start, parses the node's `.vrm`/`.glb` file to extract the humanoid bone hierarchy (used by `arm_ik_calibration` for forward kinematics). See `vrm/skeleton.ts`.

**Manual triggers**: `fireGraphEvent(componentId, nodeId, port)` — used by calibration buttons in the UI via `POST /api/signal/graphs/:id/fire`.

---

## BreathingManager — `breathing/manager.ts`

Procedural sine-wave breathing applied as a pose interceptor.

**Input**: Intercepts `OnPoseBroadcast` events from the VMC pipeline  
**Output**: Modified pose re-emitted through `PoseInterceptorBroadcast`

**Graph descriptor**: `makeBreathingGraphDescriptor(componentId)` wires:
```
on_pose_broadcast → time → sine_wave (chest, phase 0°)
                         → sine_wave (spine, phase 30°)
                → euler_to_quaternion (×2) → pose_apply_bone (×2) → pose_interceptor_broadcast
```

Config controls `_chest_bone`, `_spine_bone`, and blend `_mode` (multiply/add).

---

## LipsyncManager — `lipsync/manager.ts`

Drives VRM blendshapes from microphone viseme weights sent from the browser. Vowel classification is performed client-side; the manager only fans the resulting weights through the signal graph and broadcasts them.

**Input**: `lipsync_input` WebSocket message (kind + componentId + visemes map, already `Fcl_MTH_*` keyed)
**Output**: `vmc_blendshapes` WebSocket broadcast

**Entry point**: `fireVisemes(componentId, visemes)` — stores weights in `lipsync_source` node state, then fires the trigger event into the graph.

**Graph descriptor**: `makeLipsyncGraphDescriptor(componentId)` wires:
```
lipsync_source → unpack_event → viseme_passthrough → blendshapes_broadcast
```

See [lipsync.md](lipsync.md) for the frontend MFCC classification pipeline, per-component calibration, and config schema.

**Known issue (latent, not yet fixed)**: `viseme_passthrough` reads `config.sensitivity` directly, but `_getNodeConfig` only forwards `cfg.nodeConfig[nodeId]` overrides — not top-level component config. The sensitivity slider in the UI is currently a no-op as a result.

---

## TrackingManager — `mediapipe_tracker/manager.ts`

Processes MediaPipe landmark data streamed from the browser (face, hands, body pose).
See [mediapipe-tracker.md](mediapipe-tracker.md) for full pipeline detail; this section
covers only the manager-level lifecycle pattern.

**Input**: `tracking_input` WebSocket message with `{face?, leftHand?, rightHand?, pose?}` Landmark arrays
**Output**: `vmc_pose`, `vmc_blendshapes`, and `ik_targets` WebSocket broadcasts

**Entry point**: `fireLandmarks(componentId, frame)` — fires separate events per landmark stream
into `mediapipe_source`.

**Graph descriptor**: `makeMediapipeGraphDescriptor(componentId)` in
`node_components/mediapipe_tracker/graph.ts`. See module doc for the full node/edge layout.

**Manual triggers**: `fireGraphEvent(componentId, nodeId, port)` — used by the head/finger/IK
capture+reset buttons in `PropertiesPanel.tsx`, dispatched by `POST /api/signal/graphs/:id/fire`.
`routes/api.ts` routes by graph-id prefix (VMC vs tracking).

**Config**: `useIk` (arm mode toggle), `enableFace`, `enablePose`, `enableHands`, plus head and
IK calibration knobs (see PropertiesPanel `MediapipeTrackerProps`). All knobs are surfaced
through `component_config` nodes wired into converter value ports — no `nodeConfig[nodeId]`
side-channel.

---

## ApiControllerManager — `api_controller/manager.ts`

REST-driven driver for VRM avatars: external clients PUT an animation queue or blendshape weights and the manager broadcasts the change. Unlike the other managers it does **not** instantiate a signal graph — it owns plain in-memory state per component and writes to the broadcast bus directly. See [api-controller.md](api-controller.md) for the full REST surface and message wire format.

**Input**: REST mutations via `routes/api-controller.ts`; `avatar_expressions_report` WS messages from the frontend recording which expressions the loaded VRM exposes.
**Output**: `api_animation` WS broadcast on every queue change (carries `nodeId, componentId, queue, loopMode, startedAt`); blendshape changes flow through `broadcastBus.publishBlendshapes()` → `vmc_blendshapes` like every other source.

**State per component** (in-memory only, not persisted): `{ sceneNodeId, queue, loopMode, startedAt, blendshapes }`. There is no graph and no `_nodeState`. Lifecycle is just `syncComponents()` allocating/freeing entries in a `Map`.

**Public API used by routes**:
- `findByNode(nodeId)` → `{ componentId, state } | null`
- `getState(componentId)` → live state snapshot or null
- `setAnimationQueue(componentId, queueInput, loopMode)` — resolves each `{ animation: idOrName }` against `animation_clips` (id first, then name, both scoped to the avatar's `source_node_id`); throws if not found; sets `startedAt = Date.now()` and broadcasts `api_animation`
- `setBlendshapes(componentId, weights)` / `clearBlendshapes(componentId)` — publish to `broadcastBus`
- `setExpressionsForNode(nodeId, expressions)` / `getExpressionsForNode(nodeId)` — cache populated by `avatar_expressions_report` WS messages on VRM load
- `rebroadcastTo(send)` — called on each new WS connect to re-emit the current `api_animation` state so reconnecting clients catch up
- `snapshotAll()` — diagnostic snapshot of all active components

**Frontend playback sync**: clients consume `startedAt` (server-side `Date.now()`) and `queue[i].duration` to determine the current clip and offset. Animation clip durations are auto-registered on VRM load by Viewport — see [animation.md](animation.md) for the clip table.

**Frontend UI**: `ApiControllerProps` in `PropertiesPanel.tsx` shows the per-component REST base URL with a copy button.

**Limitations**: state is in-memory only and does not survive a backend restart (no `_nodeState` namespace); the queue/blendshapes have to be re-PUT by the client.

---

## Adding a new manager

1. Create `packages/backend/src/node_components/<kind>/manager.ts`
2. Implement `syncComponents(rows: ComponentRow[])` — diff and start/stop instances
3. Create a graph descriptor factory returning a `GraphDescriptor`
4. Instantiate and register the manager in `packages/backend/src/index.ts`
5. Wire the API: add `set<Kind>Manager()` and call `manager.syncComponents()` from the CRUD routes in `routes/api.ts`
6. Add a `@ComponentKind` entry in the shared metadata so the UI knows about it
