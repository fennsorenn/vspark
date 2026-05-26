# Signal Graph

The reactive execution engine at the core of vspark. Defined in `packages/backend/src/signal/`.

## Runtime — `signal/engine.ts`

`SignalGraph` is instantiated per component (one per VMC receiver, one per breathing component, etc.). Graphs can also be **project-scoped** rather than component-scoped — see [project-graphs.md](project-graphs.md) for standalone user-authored graphs owned by a `project_graphs` row. Project graphs have no component context: the `component_config`, `component_id`, and `scene_entity` node kinds are rejected at descriptor-validation time by `ProjectGraphManager` and would throw inside the engine even if smuggled in.

**Execution model**: hybrid push/pull.
- `event` edges: push-based. Source fires, payload travels forward to target node.
- `value` edges: pull-based. Target requests current value from source synchronously during execution.
- `list` edges: pull-based, multi-source. Target gathers values from all connected sources.

A graph executes when `fire(nodeId, portName, value)` is called from outside (by a manager). That event propagates forward through event edges; each reached node then pulls its value inputs on demand.

**Node execution** (`_deliver`):
1. Check enabled flag (from config); skip if false
2. Pull all value/list inputs
3. Call `node.execute(inputs)` → outputs
4. Fire each output event downstream
5. Catch and log errors without halting the graph

**Value-input auto-fallback to `config.<port>`** (convention since the broadcast-bus-additive-fallback work): when a node has an unconnected value-input port, the engine automatically resolves it to `defaultConfig.<portName>` from the descriptor. Node `execute()` functions no longer need to write `inputs.X ?? cfg?.X` — they just read `inputs.X`. This is the preferred pattern for all new signal nodes; reserve `component_config` nodes for values that need to track live user edits at runtime. The breathing graph is the reference example (bone names / mode / priority / blend mode collapsed into per-port `defaultConfig`; only the two live-editable amplitudes remain as `component_config` nodes).

**Hydration**: `SignalGraph.fromDescriptor(descriptor, registry, getConfig, getState, onSetState)` — builds a graph from a `GraphDescriptor` template. Config and state are injected from outside (DB-backed), so the graph itself is stateless across restarts.

**Inspection**: `getStates()` returns a snapshot of all node last-inputs, last-outputs, last-executed timestamps, and edge fire history — used by `/api/signal/graphs/:id/node-states`.

**Key internal detail**: event edge keys are stored as `fromId\x00fromPort` (null-byte separator).

## Node Registry — `signal/registry.ts`

`NODE_REGISTRY` maps kind string → `SignalNodeClass`. All 33 built-in node kinds are registered here. `getAllNodeKindMeta()` returns port declarations and display metadata for each kind — this drives the UI node palette.

## Node Kinds — `signal/nodes/`

26 implementations. Organized by role:

### Input sources (fired externally by managers)
| Kind | Description |
|------|-------------|
| `vmc_packet_source` | Entry for VMC/RhyLive UDP data; outputs `bones` (BoneRotations) and `arkit` events |
| `mediapipe_source` | Entry for MediaPipe landmarks; outputs `face`, `leftHand`, `rightHand`, `pose` events |
| `lipsync_source` | Entry for viseme weights from mic analysis; outputs `visemes` event |
| `manual_trigger` | UI-facing trigger button; fires an event on demand |
| `clock` | Outputs elapsed time since graph start |
| `time` | Outputs current time in seconds (pull) |
| `sine_wave` | Time → sine wave (configurable freq/amplitude/phase) |
| `track_clip_trigger` | Event input `fire`, value input `clipId` (scene-scoped). Calls `TrackClipPlaybackManager.trigger(clipId)` on the backend so any graph (VMC events, API controller, etc.) can drive a track clip. See [track-clips.md](track-clips.md). |

### Bone/blendshape mappers
| Kind | Description |
|------|-------------|
| `rhylive_bone_mapper` | BoneRotations (VMC/RhyLive format) → NormalizedPose (VRM bone names); applies coordinate flipping |
| `arkit_vrm_mapper` | ARKit 52-shape weights → VRM expressions; supports `fcl`, `expressions`, and `passthrough` modes |
| `face_landmarks_to_blendshapes` | 478 MediaPipe face points → vowel shapes (A/E/I/O/U), eye blink, brow raise |
| `hand_landmarks_to_bones` | 21 MediaPipe hand points → finger joint quaternions (residual rest-pose offsets are an open issue — see mediapipe-tracker.md) |
| `pose_torso_head_to_bones` | 33 MediaPipe body points → torso + head + eye bone quaternions |
| `pose_arms_to_bones` | 33 MediaPipe body points → shoulder/upper-arm/lower-arm quaternions (quat-arm mode) |
| `pose_ik_targets` | 33 MediaPipe body points → chest-relative IK end-effector targets for arms (IK-arm mode) |

### Calibration
| Kind | Description |
|------|-------------|
| `body_calibration` | Captures neutral pose; subtracts offset via quaternion inversion. Supports optional `mirrorPairs` config + `mirrorSource` input port for one-hand symmetric calibration (used by finger_calib in MediaPipe tracker). |
| `arm_ik_calibration` | Two-bone arm IK; captures arm reach (finger-to-eye-corner); applies corrected IK at runtime |

### Processing / utility
| Kind | Description |
|------|-------------|
| `blendshapes_sum` | List port → clamped sum across multiple Blendshapes inputs |
| `euler_to_quaternion` | Euler angles → quaternion |
| `unpack_event` | Event<T> → separate `trigger` event port + `value` pull port |
| `pose_apply_bone` | Overrides a single bone in a NormalizedPose |
| `pose_merge` | Merges multiple NormalizedPose inputs into a single pose (later inputs win per bone) |
| `not_bool` | Inverts a boolean value (used to gate arm vs IK branches from `useIk`) |
| `hand_height_compare` | Compares left/right hand Y positions; outputs which hand is higher (mirror calibration helper) |
| `multiply` | Scalar `a × b`. Used by breathing to derive the counter-rotated amplitude (`amp × -1`). |

### Output/broadcast
| Kind | Description |
|------|-------------|
| `pose_broadcast` | NormalizedPose → WebSocket `vmc_pose` broadcast; respects interceptor chain |
| `blendshapes_broadcast` | Blendshapes → WebSocket `vmc_blendshapes` broadcast |
| `ik_broadcast` | IkTargetFrame → WebSocket `ik_targets` broadcast (consumed by frontend `ikTargetStore` + Viewport Step 2.5 solver) |

### Pose interceptor chain
The interceptor chain lets components (e.g., breathing) modify poses in-flight before broadcast.

| Kind | Description |
|------|-------------|
| `on_pose_broadcast` | Entry for interceptor graph; receives InterceptorFrame from the registry |
| `pose_interceptor_broadcast` | Exit for interceptor graph; re-broadcasts modified pose back through chain |

### Config/context
| Kind | Description |
|------|-------------|
| `component_config` | Dot-notation extractor on component config JSON (e.g., `field: "myNode.param"`) |
| `component_id` | Injects the owning componentId as a string value |
| `scene_entity` | Injects the scene node ID for addressed broadcasts |
| `viseme_passthrough` | Scales viseme weights by a sensitivity config value |

## Graph Descriptor

A `GraphDescriptor` (defined in `packages/shared/src/signal.ts`) is a static template:
```ts
{
  label: string
  readonly?: boolean
  nodes: Array<{ id, kind, position, defaultConfig }>
  edges: Array<{ fromNodeId, fromPort, toNodeId, toPort, kind? }>
}
```

Each manager creates its own descriptor factory (e.g., `makeVmcGraphDescriptor(componentId)`). The descriptor is passed to `SignalGraph.fromDescriptor()` along with live config/state callbacks.

## Adding a new node kind

1. Create `packages/backend/src/signal/nodes/my_node.ts` implementing `SignalNodeClass`
2. Decorate with `@SignalNode({ label, description, tags, color })`
3. Register in `packages/backend/src/signal/registry.ts`
4. Add to the appropriate manager's graph descriptor if needed

The node's `execute(inputs)` function receives typed ports (matching static port declarations) and returns typed outputs. Nodes should be pure functions — no side effects except via explicit output ports or `setState`.
