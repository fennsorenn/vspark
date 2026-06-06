# Signal Graph

The reactive execution engine at the core of vspark. Defined in `packages/backend/src/signal/`.

> **Implemented — `media_control` node.** A single node (`action`/`targetKind`/`targetId`
> config + `SceneEntity` `target` input + optional `t`/`volume` inputs + a `spawnRef`
> retarget) dispatches fire-and-forget play/pause/stop/restart/seek/setVolume/mute/unmute
> onto the media-command bus. See [media.md](media.md) and the Output table below.

## Node model — class-instance / decorator (Phase 2)

Signal nodes are **live class instances** that extend the abstract `Node` base class (`packages/shared/src/node.ts`). A node's **decorated members ARE its ports**. There is no `static execute` and no `static inputPorts/outputPorts` — that model is gone.

Decorators live in `packages/shared/src/node_decorators.ts`:

| Decorator | Target | Engine binds | Node uses it as |
|-----------|--------|--------------|-----------------|
| `@eventIn(name, typeTag)` | **method** | subscribes the method to the upstream emitter | the method body is the reaction (push input) |
| `@valueIn(name, typeTag)` | **field** | assigns a pull-thunk `() => T` | calls `this.field()` to pull current upstream value |
| `@listIn(name, typeTag)` | **field** | assigns a fan-in pull-thunk `() => T[]` | calls `this.field()` to gather all connected sources |
| `@eventOut(name, typeTag)` | **field** | assigns an instrumented `Emitter<T>` | calls `this.field.emit(payload)` with the RAW payload (engine wraps in `Event<T>`) |
| `@valueOut(name, typeTag)` | **field** | (node owns it) | node defines a thunk `() => T`, pulled on demand downstream |

`typeTag` is the leaf data-type (a `SignalTypeName`); transport is implied by the decorator. Use `'Any'` (→ `unknown`) for ports whose real type is supplied by `inferPorts`.

**Port metadata harvest**: `@SignalNode` reads ports from the Stage-3 `ctx.metadata` buffer that the port decorators populate at class-definition time, so the palette / `NodeKindMeta` can introspect ports **without instantiating** the node. Field-decorator factories return a generic identity initializer (required by `tsc --strict`, TS1270); the engine overwrites the field with the real emitter/thunk in `Node.bind()`.

**State**: `this.getState<T>()` / `this.setState(v)` on the base (DB-backed via engine injection). Most nodes are stateless; `body_calibration` / `arm_ik_calibration` / `queue_events` / `unpack_event` keep state there. `reconcile()` stays rebuild-from-scratch, so anything that must survive a reconcile lives in state, not instance fields.

**Lifecycle hooks**: the constructor runs **before** ports are wired; the `protected onBind()` hook runs **after** bind, so dynamic-port setup goes in `onBind()`, not the constructor.

**Dynamic ports** (no new decorator machinery — decorations are the static skeleton, `inferPorts` declares the actual current ports, which may have no decorated member):
- `this.input(name)` — pull a dynamic value-in by name.
- `this.emitOn(name, v)` — push a dynamic event-out by name.
- `setDynamicOutputs(resolve)` — register a resolver for dynamic value-out pulls (`(portName) => value`).

Toolchain: repo runs TC39 Stage-3 decorators (TS 5.9, **no** `experimentalDecorators`), verified under tsc / tsx / Vite.

## Runtime — `signal/engine.ts`

`SignalGraph` (the reactive substrate; name kept) is instantiated per Behavior (one per VMC receiver, one per breathing behavior, etc.). A signal graph can also back a **Logic** (project / scene-node / compose-layer scoped) rather than a Behavior — see [project-graphs.md](project-graphs.md) for user-authored logic owned by a `logic` row (table renamed from `graphs` via migrations 022 → 025). The behavior-context kinds `behavior_config` / `behavior_id` are rejected in all logic at descriptor-validation time by `LogicManager`. `scene_entity` is allowed in scene-node- and compose-layer-scoped logic (rejected only in project scope); the logic's owner kind is threaded into inference via `fromDescriptor(..., ownerKind)` so `scene_entity`'s output type follows the scope (`SceneNode` / `ComposeLayer`).

After the Phase 2 re-architecture the engine is **wiring + lifecycle** over Node instances, not a central dispatcher:

- `fromDescriptor` **instantiates + binds** each node, then replays the descriptor's edges through an embedded `InferGraph.tryAddEdge` (see below). Edges the inference rejects are **skipped with a console warning** rather than aborting the load. Accepted edges are routed by their **derived transport** (event → push subscription, value/list → pull thunk).
- Instrumented `Emitter`/thunk wrappers preserve the existing `_edgeStates` flash/monitoring, the per-node `enabled` gate (skip when config disables a node), and per-node `try/catch` error isolation.
- Public surface is preserved: `fire` / `deliverExternal` / `getStates` / `getNodeState` / `setNodeState` / `peekInput`.

**Execution model**: hybrid push/pull, with transport now **derived from the resolved type** (`transportOf`: `event` → push, `list` → pull fan-in, everything else → pull).
- Event edges: push. An `@eventOut` `.emit(payload)` runs every subscribed downstream `@eventIn` method.
- Value edges: pull. The downstream `@valueIn` thunk synchronously calls the upstream `@valueOut` thunk.
- List edges: pull fan-in. The downstream `@listIn` thunk gathers from every connected source.

A graph executes when `fire(nodeId, portName, value)` is called from outside (by a manager). The event propagates forward through event subscriptions; each reached node pulls its value inputs on demand.

**Source nodes** (`vmc_packet_source` / `mediapipe_source` / `lipsync_source`) declare `@eventOut` ports that are fired externally by their managers via `deliverExternal`. `clock` keeps a static `attach()`; `on_pose_broadcast` keeps a static `register()`.

**Value-input auto-fallback to `config.<port>`**: when a value-input port is unconnected, the engine resolves its pull-thunk to `defaultConfig.<portName>` from the descriptor. Nodes just read `this.port()` and get the config fallback for free. This is the preferred pattern; reserve `behavior_config` nodes for values that must track live user edits at runtime. The breathing graph is the reference example (bone names / mode / priority / blend mode in per-port `defaultConfig`; only the two live-editable amplitudes remain `behavior_config` nodes).

**Hydration**: `SignalGraph.fromDescriptor(descriptor, registry, getConfig, getState, onSetState)` — builds a graph from a `GraphDescriptor` template. Config and state are injected from outside (DB-backed), so the graph itself is stateless across restarts.

**Inspection**: `getStates()` returns a snapshot of node last-inputs / last-outputs / last-executed timestamps and edge fire history — used by `/api/signal/graphs/:id/node-states`.

## Edge-time type inference — `inference.ts` + `signal_types.ts` + `infer_nodes.ts`

Transport is folded **into** the type. The old `PortKind` / `PortDecl.kind` / `portsCompatible` machinery is **deleted**.

- `packages/shared/src/signal_types.ts` — the `ResolvedType` AST: `primitive | record | event | list | unknown`. Transport is derived from a type via `transportOf`. `isAssignable` is structural width subtyping on records, an `unknown` wildcard in **both** directions, and one documented special case: a `List<E>` target accepts a source of `E` or `List<E>`. Both the `Any` and `BehaviorConfig` type tags map to `unknown` (`BehaviorConfig` is the wildcard escape-hatch output of `behavior_config`).
- `packages/shared/src/inference.ts` — `InferGraph`: `tryAddEdge` (forward propagation + transactional rollback if a downstream port is invalidated), `removeEdge`, `setConfig`, `portsOf`.
- `packages/shared/src/infer_nodes.ts` — the `INFER_BY_KIND` table mapping kind → `inferPorts`. Imported by **both** the backend engine and the frontend canvas so the two never drift. Dynamic nodes (`pack_event`, `queue_events`, `unpack_event`) live here.
- `NodeKindMeta` now carries `{ name, resolved, typeTag, transport }` per port plus a `dynamic` flag.

## Node Registry — `signal/registry.ts`

`NODE_REGISTRY` maps kind string → node class. All 60 built-in node kinds are registered here. `getAllNodeKindMeta()` returns per-port `{name, resolved, typeTag, transport}` + `dynamic` flag and display metadata for each kind — this drives the UI node palette.

To register a node: import the class and add it to the registry (and, if it has dynamic or non-trivial ports, add its `inferPorts` entry to `INFER_BY_KIND` in `infer_nodes.ts`).

## Node Kinds — `signal/nodes/`

Organized by role:

### Input sources (fired externally by managers)
| Kind | Description |
|------|-------------|
| `vmc_packet_source` | Entry for VMC/RhyLive UDP data; outputs `bones` (BoneRotations) and `arkit` events |
| `mediapipe_source` | Entry for MediaPipe landmarks; outputs `face`, `leftHand`, `rightHand`, `pose` events |
| `lipsync_source` | Entry for viseme weights from mic analysis; outputs `visemes` event |
| `manual_trigger` (kind string `component_trigger`, label "Behavior Trigger") | UI-facing trigger button; fires an event on demand |
| `clock` | Outputs elapsed time since graph start |
| `time` | Outputs current time in seconds (pull) |
| `sine_wave` | Time → sine wave (configurable freq/amplitude/phase) |
| `track_clip_trigger` | Event input `fire`, value input `clipId` (scene-scoped). Calls `TrackClipPlaybackManager.trigger(clipId)` on the backend so any graph (VMC events, API controller, etc.) can drive a track clip. Retained for back-compat; new graphs should use `start_clip` (same shape). See [track-clips.md](track-clips.md). |
| `start_clip` | Canonical generalisation of `track_clip_trigger`. Same surface: `fire` event + `clipId` value, calls `playbackManager.trigger(clipId)`. |
| `spawn_clip` | Inputs `fire` + `clipId`; output `spawned: Event<SpawnRef>`. Clones the clip's owner + duplicates the clip with lanes remapped, plays it once ephemerally, despawns on completion. See [spawn.md](spawn.md). |
| `random` | Inputs `fire`, `min`, `max`, `mode: 'float'\|'int'`. Outputs `fire` event + `value` (Float, pull-cached). Recomputes on fire. |

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
| `pose_manual_calibration` (label "Manual Calibration") | Static `pose` in → `pose` out. For each configured bone, decomposes the quaternion to ZYX euler and applies per axis `angle' = angle * multiplier + offset` (offset in DEGREES, converted to radians; multiplier unitless). Bones with no entry, or at identity (mult `[1,1,1]` / offset `[0,0,0]`), pass through. Config: `{ calibrations: Record<boneName, { multiplier?: [x,y,z]; offset?: [x,y,z] }> }`. Ordinary static node (NOT in `INFER_BY_KIND`; ports via decorators / `defaultInfer`, like `body_calibration` / `pose_apply_bone`). Drives the `manual_calibration` behavior interceptor — see [component-managers.md](component-managers.md). Euler-space, so ZYX-order-dependent + degrades at the yaw=±90° gimbal singularity. |

### Processing / utility
| Kind | Description |
|------|-------------|
| `blendshapes_sum` (label "Combine Blendshapes") | List port → clamped sum across multiple Blendshapes inputs |
| `euler_to_quaternion` | Euler angles → quaternion |
| `pack_event` | DYNAMIC user-named input fields (`config.fields` is names-only, types inferred from connections, trailing empty slot to add more). On `fire`, packs the wired field values into a single record and emits `event: Event<{...}>`. Named-field inputs have no decorated member — read via `this.input(name)`. |
| `queue_events` | FIFO buffer. `enqueue` appends a payload, `pop` shifts + emits the oldest on `popped` (whose type mirrors the resolved `enqueue` payload), `size` is a value-out. FIFO array lives behind `getState/setState` so it survives `reconcile()`. |
| `unpack_event` | Splits an event into a `trigger` event port plus DYNAMIC per-field PULL value outputs read from the stored payload. Record payload → one pull output per field; non-record / unconnected → a single `value` output carrying the whole payload. Preserves the push→pull bridge the VMC/lipsync/mediapipe pipelines rely on (broadcast fires on `trigger`, then pulls the field chain). |
| `pose_apply_bone` | Overrides a single bone in a NormalizedPose |
| `pose_merge` | Merges multiple NormalizedPose inputs into a single pose (later inputs win per bone) |
| `not_bool` | Inverts a boolean value (used to gate arm vs IK branches from `useIk`) |
| `hand_height_compare` | Compares left/right hand Y positions; outputs which hand is higher (mirror calibration helper) |
| `multiply` | Scalar `a × b`. Used by breathing to derive the counter-rotated amplitude (`amp × -1`). |
| `log` | Debug node: on the `trigger` event path, prints the event payload plus every value wired into its `inputs` **list** port (Any) to the backend console, in connection order. Optional `label` value port / `config.label` prefixes log lines. **Breaking change:** its value-input port was renamed from `input` (single Any) to `inputs` (Any list) — saved graphs wired into the old `input` port need re-wiring. |

### Output/broadcast
| Kind | Description |
|------|-------------|
| `pose_broadcast` (label "Send Pose") | NormalizedPose → WebSocket `vmc_pose` broadcast; respects interceptor chain. Its `behaviorId` value-in port supplies the producing behavior's instance id. |
| `blendshapes_broadcast` (label "Send Blendshapes") | Blendshapes → WebSocket `vmc_blendshapes` broadcast. Same `behaviorId`-port note as `pose_broadcast`. |
| `ik_broadcast` (label "Send IK Targets") | IkTargetFrame → WebSocket `ik_targets` broadcast (consumed by frontend `ikTargetStore` + Viewport Step 2.5 solver) |
| `set_scene_node_param` (label "Set Object Property") | Writes a scalar/coerced paramPath into the runtime override bus for a scene node. Optional `spawnRef` event input retargets the fire to a tmp id. See [runtime-overrides.md](runtime-overrides.md). |
| `set_compose_layer_param` (label "Set Layer Property") | Same shape, compose-layer target. |
| `set_text` | Convenience over the set-param nodes for the `text.content` paramPath; `spawnRef.kind` overrides `targetKind` when triggered via that port. |
| `set_data` | Generic sibling of `set_text`: on `fire`, publishes the wired `data` (Any) payload to the named `channel` (String) on the data-channel bus → frontend `feed` layer. See [data-channels.md](data-channels.md). |
| `media_control` | Fire-and-forget media command (play/pause/stop/restart/seek/setVolume/mute/unmute) onto the media-command bus. Config `action`/`targetKind`/`targetId`; inputs `target` (SceneEntity, picker-or-wired), `t` (Float, for seek), `volume` (Float, for setVolume); a `spawnRef` event retargets to a spawned instance for that fire. tags `['media','output']`. See [media.md](media.md). |

### Pose interceptor chain
The interceptor chain lets behaviors (e.g., breathing) modify poses in-flight before broadcast.

| Kind | Description |
|------|-------------|
| `on_pose_broadcast` (label "Intercept Pose") | Entry for interceptor graph; receives InterceptorFrame from the registry |
| `pose_interceptor_broadcast` (label "Send Intercepted Pose") | Exit for interceptor graph; re-broadcasts modified pose back through chain |

### Config/context
| Kind | Description |
|------|-------------|
| `behavior_config` (label "Behavior Settings") | Dot-notation extractor on behavior config JSON (e.g., `field: "myNode.param"`). |
| `behavior_id` (label "This Behavior") | Injects the owning behavior's instance id as a string value. |
| `scene_entity` (label "This Entity") | Outputs the id of the entity the logic/behavior is scoped to; output type follows scope (`SceneNode` / `ComposeLayer`) |
| `viseme_passthrough` (label "Visemes → Blendshapes") | Scales viseme weights by a sensitivity config value |

## Graph Descriptor

A `GraphDescriptor` (defined in `packages/shared/src/signal.ts`) is a static template:
```ts
{
  label: string
  readonly?: boolean
  nodes: Array<{ id, kind, position, defaultConfig }>
  edges: Array<{ fromNodeId, fromPort, toNodeId, toPort }>
}
```

Edges no longer carry a `kind` — transport is derived from the resolved port types at load time (the old `PortKind` is deleted). Each manager creates its own descriptor factory (e.g., `makeVmcGraphDescriptor(behaviorId)`). The descriptor is passed to `SignalGraph.fromDescriptor()` along with live config/state callbacks; `fromDescriptor` replays the edges through `InferGraph.tryAddEdge` and silently skips any the inference rejects.

## In-Flight & Planned Work

### Implemented — Phase 1

Phase 1 of the signal-graph expansion (stream-overlay flows: chat billboards, etc.) is shipped on `dev`. Phase 2 (see below) is the architecture change that unlocked generic typed nodes (`pack_event`, `queue_events`, generic `unpack_event`); it is now implemented on `feature/signal-graph-nodes-v2`.

**New node kinds shipped** (`signal/nodes/`, registered in `registry.ts`):

| Kind | Purpose |
|------|---------|
| `set_scene_node_param` | Inputs: `fire` (Trigger), `targetId` (SceneNode), `paramPath` (String), `value` (Any — coerced via the paramPath registry), `persist` (Bool), optional `spawnRef` (Event<SpawnRef>) that overrides `targetId` for the fire (detected via `ctx.triggeredPort === 'spawnRef'`). On fire: looks up the registry entry, coerces `value` via `coerceParamValue`, calls `runtimeOverrideManager.set(...)`. `persist: true` is best-effort (see [runtime-overrides.md](runtime-overrides.md)). |
| `set_compose_layer_param` | Same shape, compose-layer target. |
| `set_text` | Convenience over `set_*_param` for the `text.content` paramPath. Accepts `spawnRef`, and when triggered through that port the ref's `kind` overrides `targetKind`. Mismatched ref kinds are refused with a `console.warn`. |
| `start_clip` | Canonical generalisation of `track_clip_trigger`. Calls `playbackManager.trigger(clipId)`. The original `track_clip_trigger` kind is retained for back-compat. |
| `spawn_clip` | Inputs: `fire`, `clipId`. Resolves the clip's owner, calls `spawnManager.spawn(clipId)`. Output: `spawned: Event<SpawnRef>`. See [spawn.md](spawn.md). |
| `random` | Inputs: `fire`, `min`, `max`, `mode: 'float'\|'int'`. Outputs: `fire` event, `value` (Float). Recomputes on fire; cached for pulls. |

**New named type** in `SignalTypeMap`: `SpawnRef = { tmpNodeId: string; tmpClipId: string; kind: 'scene_node' | 'compose_layer' }`, plus a colour entry in `SIGNAL_TYPE_COLORS`. Phase 1 ships this as a concrete primitive so `spawn_clip → set_*_param` works without generic propagation; Phase 2 leaves the type alone but adds pack/unpack for arbitrary payloads.

**Value-port typing note (Phase 1):** `set_*_param`'s `value` input is `Any` and the runtime coerces per the paramPath registry's declared type for the chosen path. Phase 2's inference will replace this with a properly typed port driven from the registry.

**Demo graph (Phase 1):** Flow A — chat → flying billboard: `overlive_chat_message → random (x) → spawn_clip (chat-billboard clip on a hidden text_canvas template) → set_scene_node_param (uses spawned tmpNodeId + random x) → clip animates → auto-despawn`. Shipped as a sample JSON descriptor at [`dev-notes/samples/chat-billboard-demo.json`](../samples/chat-billboard-demo.json) with step-by-step setup instructions inside the file. The plan considered a boot-time auto-seed behind `VSPARK_SEED_DEMO_GRAPH=1`; this was deliberately not implemented because the demo needs ids (overlive account, clip, template node) that only exist after the user has set them up, and a half-bound auto-seed would silently no-op. Flow B (sub/redemption → queued alert) is deferred to Phase 2 because proper queueing needs `queue_events`.

### Implemented — Phase 2: node re-architecture + edge-time type inference

Phase 2 (branch `feature/signal-graph-nodes-v2`) landed both architecture changes big-bang: the class-instance/decorator node model and edge-time structural inference. The mechanics are documented above under [Node model](#node-model--class-instance--decorator-phase-2), [Runtime](#runtime--signalenginets), and [Edge-time type inference](#edge-time-type-inference--inferencets--signal_typests--infer_nodests). Verification: the whole monorepo type-checks clean; the engine canary loads all four pipeline graphs (VMC / breathing / mediapipe / lipsync) with **0 dropped edges**.

**Frontend** (`SignalGraphCanvas`): builds an `InferGraph` **mirror** from the descriptor using the same shared inference, so it renders RESOLVED/dynamic ports (`pack_event` grows named-field slots, `unpack_event` grows per-field outputs live), validates drags via `mirror.tryAddEdge` (rejections surface in a transient banner), and derives edge transport from the resolved types. `NodePortMeta` consumers moved from `type`/`portKind` to `typeTag`/`transport`. `pack_event` has an on-card named-field editor (add/remove). `SignalNodeCard` / `NodePalette` updated.

**New / rewritten nodes** (see the node-kind tables above): `pack_event`, `queue_events`, and the `unpack_event` rewrite.

**Flow B** (sub/redemption → queued alert) is now unblocked end-to-end: `overlive_subscription/redemption → pack_event → queue_events ← pop:clock → unpack_event → consume`. Verified FIFO-in-order through the real engine and shipped as a sample at [`dev-notes/samples/queued-alerts-demo.json`](../samples/queued-alerts-demo.json). (Flow A — chat → flying billboard — is unchanged; see the Phase 1 sample above.)

#### Deferred / out of scope

- **Typed `behavior_config`** — `inferPorts`-based typing is deferred: there is no config-schema registry, so writable graphs simply **reject** the node and its `BehaviorConfig` wildcard (→ `unknown`) output stays. Stays planned for a later phase.
- Typed `set_*_param` value input (would replace the `Any` + runtime-coerce approach with a port typed from the paramPath registry).
- Incremental `reconcile` (stays rebuild-from-scratch).

## Adding a new node kind

1. Create `packages/backend/src/signal/nodes/my_node.ts` exporting a class that `extends Node` (`@vspark/shared/node`), with a `static readonly kind = 'my_node'`.
2. Decorate the class with `@SignalNode({ label, description, tags, color })`.
3. Declare ports as **decorated members** (import from `@vspark/shared/node_decorators`):
   - `@eventIn('name', TypeTag)` on a **method** — the method body is the reaction; do side effects / emits here.
   - `@valueIn('name', TypeTag)` / `@listIn('name', TypeTag)` on a **field** typed as a thunk (`() => T` / `() => T[]`); the engine assigns the puller. Read upstream with `this.field()`.
   - `@eventOut('name', TypeTag)` on a **field** typed `Emitter<T>`; emit the RAW payload with `this.field.emit(payload)` (the engine wraps it in `Event<T>`).
   - `@valueOut('name', TypeTag)` on a **field** you define as a thunk `() => T` (it may read other `@valueIn` thunks).
4. For state that must survive `reconcile()`, use `this.getState<T>()` / `this.setState(v)` — do not keep it in plain instance fields.
5. Register the class in `packages/backend/src/signal/registry.ts`.
6. If the node has dynamic ports or non-trivial type relationships, add an `inferPorts` entry to `INFER_BY_KIND` in `packages/shared/src/infer_nodes.ts` (shared by engine + frontend). Dynamic-port nodes read/write by name via `this.input(name)`, `this.emitOn(name, v)`, and `setDynamicOutputs(resolve)` — set these up in the `protected onBind()` hook (the constructor runs before ports are wired).
7. Add the node to the appropriate manager's graph descriptor if it belongs to a built-in pipeline.

Reference examples in `packages/backend/src/signal/nodes/`: `multiply.ts` (pure `@valueIn`/`@valueOut`), `queue_events.ts` (`@eventIn` reactions + `getState/setState` + `@valueOut`), `pack_event.ts` (dynamic value-in via `this.input`), `unpack_event.ts` (`onBind` + `setDynamicOutputs` for dynamic value-outs).
