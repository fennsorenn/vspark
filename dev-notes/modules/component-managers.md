# Behavior Managers

> This module drives **Behaviors** (formerly "node components"). The persisted table is now `behaviors`, the runtime instance id is `behaviorId`, the manager methods (`syncBehaviors`, `removeBehavior`, `_mapBehaviorRow`) follow the new spelling, and the source directory is now `packages/backend/src/behaviors/`. (Only the historical migration filenames `002_node_components.sql` / `011_project_graphs.sql` keep the old spelling — applied migrations are immutable.)

Managers live in `packages/backend/src/behaviors/`. Each manager owns the full lifecycle of a specific behavior kind: it instantiates signal graphs from descriptors, wires them to their data source (UDP socket, WebSocket message, timer), and persists graph node state back to the DB.

## Pattern shared by all managers

```
DB behaviors row
  → syncBehaviors(rows) called by API after any CRUD  
    → diff running vs desired state
    → start/stop/reload graph instances as needed
  → graph runs; nodes call setState(nodeId, state)
    → manager persists state into config._nodeState namespace in DB
  → on restart: syncBehaviors() restores state via getState callbacks
```

State lives in `config._nodeState[nodeId]` so it survives restarts without a separate DB column.

---

## VmcManager — `vmc_receiver/manager.ts`

Manages VMC/RhyLive motion capture receivers. Each behavior owns a `SignalGraph` and shares the process-wide UDP socket pool for transport.

**Input**: UDP OSC packets on a configurable port  
**Output**: `vmc_pose` and `vmc_blendshapes` WebSocket broadcasts

**Shared UDP socket pool** (implemented): transport lives in `vmc/udp_socket_pool.ts` — a process-wide singleton (`udpSocketPool`) exporting `subscribe(port, listener, onBound?) -> unsubscribe`. Refcounted per port: the first subscriber binds, the last unsubscribe closes. Listener dispatch snapshots the subscriber set, so a listener can unsubscribe mid-dispatch safely. The pool currently binds `0.0.0.0` (the per-behavior `host` config is not yet honored — matches pre-refactor behavior). The `Receiver` struct no longer holds a `socket: Socket`; it holds an `unsubscribe: () => void` instead. `startReceiver` subscribes to the pool; `stopReceiver` calls the unsubscribe. Port changes go through the existing `stopReceiver` → `startReceiver` sequence. Multiple `vmc_receiver` behaviors on the same port now each receive every packet independently — per-behavior tracking detection, calibration and bus slot publication are unaffected. Verified with two avatars on the same port both animating from one source.

**Packet formats handled** (no external OSC library):
- `/VMC/Ext/Bone/Pos` — Unity HumanBodyBones rotation array
- `/Body` — RhyLive 220+ float array
- `/Face` — ARKit 52-shape weight array

**Graph descriptor**: `makeVmcGraphDescriptor(behaviorId)` wires:
```
vmc_packet_source → rhylive_bone_mapper → body_calibration → arm_ik_calibration → pose_broadcast
                  → arkit_vrm_mapper (×3) → blendshapes_sum → blendshapes_broadcast
```

**Tracking detection**: Frame-to-frame delta compared to a threshold; sets `vmcTracking` flag broadcast over WS.

**Tracking-loss → bus removal** (implemented): on the `nowTracking === false` transition the manager calls `broadcastBus.removeBehavior(behaviorId)`, which (if it leaves the nodeMap empty) emits a final fallback frame so the frontend ramps back to pure animation. Resume is automatic — the next `publishBones` re-creates the per-behavior slot in the bus's nodeMap.

**Review-later**: `poseTimeout` on vmc_receiver is largely redundant now that tracking-loss drives an immediate bus-side additive transition. Kept on the frontend (`Viewport.tsx`) as a client-side safety net for missed WS transition messages; revisit once the new flow proves robust in practice.

**Interceptors**: `OnPoseBroadcast` nodes from other behaviors (breathing, manual_calibration) are registered into the VMC graph's interceptor chain. Cleanup callbacks are stored per receiver so they're removed on stop.

**VRM skeleton loading**: On start, parses the node's `.vrm`/`.glb` file to extract the humanoid bone hierarchy (used by `arm_ik_calibration` for forward kinematics). See `vrm/skeleton.ts`.

**Manual triggers**: `fireGraphEvent(behaviorId, nodeId, port)` — used by calibration buttons in the UI via `POST /api/signal/graphs/:id/fire` (substrate monitoring route, unchanged).

---

## BreathingManager — `breathing/manager.ts`

Procedural sine-wave breathing published as an additive pose source through the broadcast bus.

**Input**: Internal `time` / `sine_wave` ticks (no external event source)  
**Output**: `vmc_pose` (additive blend mode) via `pose_broadcast` through `broadcastBus`

**6-bone topology**:
- `chest` (+pitch) and `upperChest` (−pitch) — additive breathing tilt; head intentionally stays put.
- `leftShoulder` / `rightShoulder` lift on inhale.
- `leftUpperArm` / `rightUpperArm` counter-rotate by the negated shoulder amplitude so the arm visually stays in place while the shoulder lifts.

**Configurable amplitudes** (`behavior_config` nodes): `chestAmplitude`, `shoulderAmplitude`. Both flow through a single `multiply(-1)` node to produce the counter-rotated value used by the upperChest and upper-arm branches.

**Graph descriptor** (`breathing/graph.ts`): the older "fake `behavior_config` literal helpers" for bone names / mode / priority / blend mode have been dropped — those now live as per-port `defaultConfig` on the consuming nodes (see the engine auto-fallback note below). Only the two amplitude `behavior_config` nodes remain, because they need to track live user edits.

**Live config plumbing**: the manager injects `_behaviorConfig` into the graph runtime so the `behavior_config` nodes can resolve their dotted field paths against the current row.

---

## LipsyncManager — `lipsync/manager.ts`

Drives VRM blendshapes from microphone viseme weights sent from the browser. Vowel classification is performed client-side; the manager only fans the resulting weights through the signal graph and broadcasts them.

**Input**: `lipsync_input` WebSocket message (kind + behaviorId + visemes map, already `Fcl_MTH_*` keyed)
**Output**: `vmc_blendshapes` WebSocket broadcast

**Entry point**: `fireVisemes(behaviorId, visemes)` — stores weights in `lipsync_source` node state, then fires the trigger event into the graph.

**Graph descriptor**: `makeLipsyncGraphDescriptor(behaviorId)` wires:
```
lipsync_source → unpack_event → viseme_passthrough → blendshapes_broadcast
```

See [lipsync.md](lipsync.md) for the frontend MFCC classification pipeline, per-behavior calibration, and config schema.

**Known issue (latent, not yet fixed)**: `viseme_passthrough` reads `config.sensitivity` directly, but `_getNodeConfig` only forwards `cfg.nodeConfig[nodeId]` overrides — not top-level behavior config. The sensitivity slider in the UI is currently a no-op as a result.

---

## TrackingManager — `mediapipe_tracker/manager.ts`

Processes MediaPipe landmark data streamed from the browser (face, hands, body pose).
See [mediapipe-tracker.md](mediapipe-tracker.md) for full pipeline detail; this section
covers only the manager-level lifecycle pattern.

**Input**: `tracking_input` WebSocket message with `{face?, leftHand?, rightHand?, pose?}` Landmark arrays
**Output**: `vmc_pose`, `vmc_blendshapes`, and `ik_targets` WebSocket broadcasts

**Entry point**: `fireLandmarks(behaviorId, frame)` — fires separate events per landmark stream
into `mediapipe_source`.

**Graph descriptor**: `makeMediapipeGraphDescriptor(behaviorId)` in
`behaviors/mediapipe_tracker/graph.ts`. See module doc for the full node/edge layout.

**Manual triggers**: `fireGraphEvent(behaviorId, nodeId, port)` — used by the head/finger/IK
capture+reset buttons in `PropertiesPanel.tsx`, dispatched by `POST /api/signal/graphs/:id/fire`.
`routes/signal.ts` routes by graph-id prefix (VMC vs tracking).

**Config**: `useIk` (arm mode toggle), `enableFace`, `enablePose`, `enableHands`, plus head and
IK calibration knobs (see PropertiesPanel `MediapipeTrackerProps`). All knobs are surfaced
through `behavior_config` nodes wired into converter value ports — no `nodeConfig[nodeId]`
side-channel.

---

## ApiControllerManager — `api_controller/manager.ts`

REST-driven driver for VRM avatars: external clients PUT an animation queue or blendshape weights and the manager broadcasts the change. Unlike the other managers it does **not** instantiate a signal graph — it owns plain in-memory state per behavior and writes to the broadcast bus directly. See [api-controller.md](api-controller.md) for the full REST surface and message wire format.

**Input**: REST mutations via `routes/api-controller.ts`; `avatar_expressions_report` WS messages from the frontend recording which expressions the loaded VRM exposes.
**Output**: `api_animation` WS broadcast on every queue change (carries `nodeId, behaviorId, queue, loopMode, startedAt`); blendshape changes flow through `broadcastBus.publishBlendshapes()` → `vmc_blendshapes` like every other source.

**State per behavior** (in-memory only, not persisted): `{ sceneNodeId, queue, loopMode, startedAt, blendshapes }` (type still `BehaviorState`). There is no graph and no `_nodeState`. Lifecycle is just `syncBehaviors()` allocating/freeing entries in a `Map`.

**Public API used by routes**:
- `findByNode(nodeId)` → `{ behaviorId, state } | null`
- `getState(behaviorId)` → live state snapshot or null
- `setAnimationQueue(behaviorId, queueInput, loopMode)` — resolves each `{ animation: idOrName }` against `animation_clips` (id first, then name, both scoped to the avatar's `source_node_id`); throws if not found; sets `startedAt = Date.now()` and broadcasts `api_animation`
- `setBlendshapes(behaviorId, weights)` / `clearBlendshapes(behaviorId)` — publish to `broadcastBus`
- `setExpressionsForNode(nodeId, expressions)` / `getExpressionsForNode(nodeId)` — cache populated by `avatar_expressions_report` WS messages on VRM load
- `rebroadcastTo(send)` — called on each new WS connect to re-emit the current `api_animation` state so reconnecting clients catch up
- `snapshotAll()` — diagnostic snapshot of all active behaviors

**Frontend playback sync**: clients consume `startedAt` (server-side `Date.now()`) and `queue[i].duration` to determine the current clip and offset. Animation clip durations are auto-registered on VRM load by Viewport — see [animation.md](animation.md) for the clip table.

**Frontend UI**: `ApiControllerProps` in `PropertiesPanel.tsx` shows the per-behavior REST base URL with a copy button.

**Limitations**: state is in-memory only and does not survive a backend restart (no `_nodeState` namespace); the queue/blendshapes have to be re-PUT by the client.

---

## ManualCalibrationManager — `manual_calibration/manager.ts`

Pose interceptor for manually fine-tuning an avatar's pose with a per-bone, per-axis euler **multiplier + offset**. It is the **second interceptor-registering manager** alongside `VmcManager` — instead of attaching clocks/sources, it registers its graph's `on_pose_broadcast` node into the interceptor chain, so it only acts when *some other* producer (VMC, tracking, etc.) broadcasts a pose for that avatar's scene node.

**Input**: an upstream pose via the interceptor chain (no external source of its own)
**Output**: the modified pose re-broadcast through the chain (`pose_interceptor_broadcast`)

**Lifecycle**: mirrors `BreathingManager` — per-behavior `SignalGraph`, persisted node state (`config._nodeState[nodeId]`), hot-applied config. The difference is registration: at start it registers the graph's `on_pose_broadcast` node via `OnPoseBroadcast.register` (exactly like `VmcManager`'s interceptor wiring) rather than attaching a clock.

**Graph descriptor** (`manual_calibration/graph.ts`): a minimal interceptor pipeline:
```
on_pose_broadcast (priority 5) → pose_manual_calibration → pose_interceptor_broadcast
```

**Live config plumbing**: the `calib` node's config is fed live from the behavior config's `calibrations` map via the manager's `_getNodeConfig` (same nodeConfig side-channel as the other graph-backed managers). Config shape: `{ calibrations: Record<boneName, { multiplier?: [x,y,z]; offset?: [x,y,z] }> }`.

**Per-bone math** (`pose_manual_calibration` node): for each configured bone, decompose the quaternion to ZYX euler and apply per axis `angle' = angle * multiplier + offset` (offset stored in **degrees**, converted to radians in the node; multiplier unitless). Bones with no config entry, or at identity (mult `[1,1,1]` / offset `[0,0,0]`), pass through untouched. See the node entry in [signal-graph.md](signal-graph.md) and the euler conventions in [animation.md](animation.md).

**Caveat**: per-axis multiply/offset is an euler-space operation, so it's ZYX-order-dependent and degrades near the yaw=±90° gimbal singularity — expected for a manual fine-tuning knob.

**BehaviorKind**: `@BehaviorKind({ kind: 'manual_calibration', label: 'Manual Calibration', icon: '🎚️', applicableTo: ['avatar'] })`. Frontend UI is `ManualCalibrationProps` in `PropertiesPanel.tsx` (see [frontend.md](frontend.md)).

---

## BroadcastBus — `broadcast/bus.ts`

Shared sink that merges per-behavior pose/blendshape outputs into the single `vmc_pose` / `vmc_blendshapes` WS streams. Each sceneNode owns a `nodeMap` of `behaviorId → latest contribution`; the bus combines entries and rebroadcasts.

**Fallback frame on last-producer removal** (`removeBehavior`):
- Removes the behavior's entry from its sceneNode's `nodeMap`.
- If the `nodeMap` is now empty, emits one final fallback frame before dropping the empty entry:
  - `vmc_pose` with empty `bones` and `animationBlendMode: 'additive'`
  - `vmc_blendshapes` with empty `{}` record
- The frontend Viewport sees the empty-bones frame, trips off pose application, and ramps back to pure animation. While *any* producer is still active (e.g. breathing) the fallback does not fire and other producers continue uninterrupted.

**Producer requirement**: any source publishing into the bus (via `pose_broadcast` / `blendshapes_broadcast`) must supply a `behaviorId` so its contribution can be slotted and later cleared — wired through the broadcast nodes' `behaviorId` input port. The mediapipe tracker graph was previously missing this wiring (silent no-op); fixed by adding a `comp_id` node (the `behavior_id` node kind) feeding both broadcast nodes in `mediapipe_tracker/graph.ts`.

## Adding a new manager

1. Create `packages/backend/src/behaviors/<kind>/manager.ts`
2. Implement `syncBehaviors(rows)` — diff and start/stop behavior instances
3. Create a graph descriptor factory returning a `GraphDescriptor`
4. Instantiate and register the manager in `packages/backend/src/index.ts`
5. Wire the API: add `set<Kind>Manager()` and call `manager.syncBehaviors()` from the behavior CRUD routes in `routes/behaviors.ts`
6. Add a `@BehaviorKind` entry (decorator renamed from `@ComponentKind`; surfaced via `getAllBehaviorKindMeta`) in the shared metadata so the UI knows about it
