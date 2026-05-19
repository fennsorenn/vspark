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

Drives VRM blendshapes from microphone viseme weights sent from the browser.

**Input**: `lipsync_input` WebSocket message (kind + componentId + visemes map)  
**Output**: `vmc_blendshapes` WebSocket broadcast

**Entry point**: `fireVisemes(componentId, visemes)` — stores weights in `lipsync_source` node state, then fires the trigger event into the graph.

**Graph descriptor**: `makeLipsyncGraphDescriptor(componentId)` wires:
```
lipsync_source → unpack_event → viseme_passthrough → blendshapes_broadcast
```

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

## Adding a new manager

1. Create `packages/backend/src/node_components/<kind>/manager.ts`
2. Implement `syncComponents(rows: ComponentRow[])` — diff and start/stop instances
3. Create a graph descriptor factory returning a `GraphDescriptor`
4. Instantiate and register the manager in `packages/backend/src/index.ts`
5. Wire the API: add `set<Kind>Manager()` and call `manager.syncComponents()` from the CRUD routes in `routes/api.ts`
6. Add a `@ComponentKind` entry in the shared metadata so the UI knows about it
