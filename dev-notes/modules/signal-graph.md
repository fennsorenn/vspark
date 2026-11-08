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

**State**: `this.getState<T>()` / `this.setState(v)` on the base (injected by the engine). Most nodes are stateless; `body_calibration` / `arm_ik_calibration` / `queue_events` / `unpack_event` / `viseme_passthrough` / `on_pose_broadcast` keep state there. `reconcile()` stays rebuild-from-scratch, so anything that must survive a reconcile lives in state, not instance fields.

**Scratch vs durable state** — a node class opts in to durable state with `static readonly persistState = true`:

| | where it lives | survives a restart |
|---|---|---|
| default (no `persistState`) | scratch map inside the `SignalGraph` | no |
| `static persistState = true` | owner's store (`config._nodeState[nodeId]` / `logic.node_state`), i.e. SQLite | yes |

Only `body_calibration` and `arm_ik_calibration` are durable today — user-produced calibration, stored as plain numbers/arrays so the JSON round-trip is lossless. **Everything else must stay scratch.** Per-frame state (`unpack_event` payloads, scaled visemes, interceptor frames) persisted at frame rate cost a DB write per frame, and the round-trip strips class identity: a `Blendshapes` / `NormalizedPose` comes back from SQLite as a plain object and throws in the first consumer that calls a method on it. Stale `_nodeState` written before the split is simply ignored — scratch nodes never read the owner's store.

**Lifecycle hooks**: the constructor runs **before** ports are wired; the `protected onBind()` hook runs **after** bind, so dynamic-port setup goes in `onBind()`, not the constructor. `protected onUnbind()` runs when the graph is disposed (stop / rebuild): release external resources and pending timers there (`set_data`, `set_expression`, the combo nodes).

**Dynamic ports** (no new decorator machinery — decorations are the static skeleton, `inferPorts` declares the actual current ports, which may have no decorated member):
- `this.input(name)` — pull a dynamic value-in by name.
- `this.emitOn(name, v)` — push a dynamic event-out by name.
- `setDynamicOutputs(resolve)` — register a resolver for dynamic value-out pulls (`(portName) => value`).

Toolchain: repo runs TC39 Stage-3 decorators (TS 5.9, **no** `experimentalDecorators`), verified under tsc / tsx / Vite.

## Runtime — `signal/engine.ts`

`SignalGraph` (the reactive substrate; name kept) is instantiated per Behavior (one per VMC receiver, one per breathing behavior, etc.). A signal graph can also back a **Logic** (project / scene-node / compose-layer scoped) rather than a Behavior — see [project-graphs.md](project-graphs.md) for user-authored logic owned by a `logic` row (table renamed from `graphs` via migrations 022 → 025). The behavior-context kind `behavior_id` is rejected in all logic at descriptor-validation time by `LogicManager`; the shared `settings` node (formerly `behavior_config`) is rejected everywhere except in Action-owned logic (`owner_kind = 'action'`, see [actions.md](actions.md)) and Behavior-owned logic (`owner_kind = 'behavior'` — a behavior's stored graph, validated by `validateBehaviorGraph` and run by its manager, see [component-managers.md](component-managers.md#stored-editable-graphs)). `scene_entity` is allowed in scene-node- and compose-layer-scoped logic (rejected only in project scope); the logic's owner kind is threaded into inference via `fromDescriptor(..., ownerKind)` so `scene_entity`'s output type follows the scope (`SceneNode` / `ComposeLayer`).

After the Phase 2 re-architecture the engine is **wiring + lifecycle** over Node instances, not a central dispatcher:

- `fromDescriptor` **instantiates + binds** each node, then replays the descriptor's edges through an embedded `InferGraph.tryAddEdge` (see below). Edges the inference rejects are **skipped with a console warning** rather than aborting the load. Accepted edges are routed by their **derived transport** (event → push subscription, value/list → pull thunk).
- Instrumented `Emitter`/thunk wrappers preserve the existing `_edgeStates` flash/monitoring, the per-node `enabled` gate (skip when config disables a node), and per-node `try/catch` error isolation.
- Public surface is preserved: `fire` / `deliverExternal` / `getStates` / `getNodeState` / `setNodeState` / `peekInput`.

**Execution model**: hybrid push/pull, with transport now **derived from the resolved type** (`transportOf`: `event` → push, `list` → pull fan-in, everything else → pull).
- Event edges: push. An `@eventOut` `.emit(payload)` runs every subscribed downstream `@eventIn` method.
- Value edges: pull. The downstream `@valueIn` thunk synchronously calls the upstream `@valueOut` thunk.
- List edges: pull fan-in. The downstream `@listIn` thunk gathers from every connected source.

A graph executes when `fire(nodeId, portName, value)` is called from outside (by a manager). The event propagates forward through event subscriptions; each reached node pulls its value inputs on demand.

**Source nodes** (`vmc_packet_source` / `ifacialmocap_packet_source` / `mediapipe_source` / `lipsync_source`) declare `@eventOut` ports that are fired externally by their managers via `deliverExternal`. `clock` keeps a static `attach()`; `on_pose_broadcast` keeps a static `register()`.

**Value-input auto-fallback to `config.<port>`**: when a value-input port is unconnected, the engine resolves its pull-thunk to `defaultConfig.<portName>` from the descriptor. Nodes just read `this.port()` and get the config fallback for free. This is the preferred pattern; reserve `settings` nodes for values that must track live user edits at runtime. The breathing graph is the reference example (bone names / mode / priority / blend mode in per-port `defaultConfig`; only the two live-editable amplitudes remain `settings` nodes).

**Node config resolves live**: `_makeBindContext` exposes `config` as a **getter** (not a value snapshotted at graph-build time), so `this.config` — and therefore a `settings` node reading `_settings` — re-reads the owner's current settings (a Behavior's config or an Action's settings) on every access. This is what makes `settings`-fed values (breathing amplitudes, manual-calibration map) hot-apply without a graph rebuild; before, they only took effect on behavior restart.

**Hydration**: `SignalGraph.fromDescriptor(descriptor, registry, getConfig, getState, onSetState)` — builds a graph from a `GraphDescriptor` template. Config is injected from outside (DB-backed). State only reaches `getState`/`onSetState` for nodes declaring `static persistState`; every other node's state stays in the graph's scratch map (see **Scratch vs durable state** above).

**Inspection**: `getStates()` returns a snapshot of node last-inputs / last-outputs / last-executed timestamps and edge fire history — used by `/api/signal/graphs/:id/node-states`.

## Edge-time type inference — `inference.ts` + `signal_types.ts` + `infer_nodes.ts`

Transport is folded **into** the type. The old `PortKind` / `PortDecl.kind` / `portsCompatible` machinery is **deleted**.

- `packages/shared/src/signal_types.ts` — the `ResolvedType` AST: `primitive | record | event | list | unknown`. Transport is derived from a type via `transportOf`. `isAssignable` is structural width subtyping on records, an `unknown` wildcard in **both** directions, and one documented special case: a `List<E>` target accepts a source of `E` or `List<E>`. Both the `Any` and `BehaviorConfig` type tags map to `unknown` (`BehaviorConfig` is the wildcard escape-hatch output of the `settings` node).
- `packages/shared/src/inference.ts` — `InferGraph`: `tryAddEdge` (forward propagation + transactional rollback if a downstream port is invalidated), `removeEdge`, `setConfig`, `portsOf`.
- `packages/shared/src/infer_nodes.ts` — the `INFER_BY_KIND` table mapping kind → `inferPorts`. Imported by **both** the backend engine and the frontend canvas so the two never drift. Dynamic nodes (`pack_event`, `queue_events`, `unpack_event`, `cycle`, `regex`, `text_format`, and the pass-through gates `if_else` / `cooldown`) live here.
- `NodeKindMeta` now carries `{ name, resolved, typeTag, transport }` per port plus a `dynamic` flag.

## Node Registry — `signal/registry.ts`

`NODE_REGISTRY` maps kind string → node class. All 124 built-in node kinds are registered here. `getAllNodeKindMeta()` returns per-port `{name, resolved, typeTag, transport}` + `dynamic` flag and display metadata for each kind — this drives the UI node palette.

To register a node: import the class and add it to the registry (and, if it has dynamic or non-trivial ports, add its `inferPorts` entry to `INFER_BY_KIND` in `infer_nodes.ts`).

## Node Kinds — `signal/nodes/`

Organized by role:

### Input sources (fired externally by managers)
| Kind | Description |
|------|-------------|
| `vmc_packet_source` | Entry for VMC/RhyLive UDP data; outputs `bones` (BoneRotations) and `arkit` events |
| `ifacialmocap_packet_source` | Entry for iFacialMocap UDP data; same `bones` / `arkit` event outputs, plus `deviceHost` + per-axis invert value inputs |
| `mediapipe_source` | Entry for MediaPipe landmarks; outputs `face`, `leftHand`, `rightHand`, `pose`, and `arkit` (ARKit blendshape weights) events. The `arkit` weights are computed browser-side — by default a landmark-derived heuristic (`media/arkitHeuristic.ts`), or a trained `FaceLandmarker` when "HQ face" is enabled — both feeding the same `arkit_vrm_mapper` trio |
| `lipsync_source` | Entry for viseme weights from mic analysis; outputs `visemes` event |
| `manual_trigger` (kind string `component_trigger`, label "Behavior Trigger") | UI-facing trigger button; fires an event on demand |
| `clock` | Outputs elapsed time since graph start |
| `time` | Outputs current time in seconds (pull) |
| `sine_wave` | Time → sine wave (configurable freq/amplitude/phase) |
| `track_clip_trigger` | Event input `fire`, value input `clipId` (scene-scoped). Calls `TrackClipPlaybackManager.trigger(clipId)` on the backend so any graph (VMC events, API controller, etc.) can drive a track clip. Retained for back-compat; new graphs should use `start_clip` (same shape). See [track-clips.md](track-clips.md). |
| `start_clip` | Canonical generalisation of `track_clip_trigger`. Same surface: `fire` event + `clipId` value, calls `playbackManager.trigger(clipId)`. |
| `spawn_clip` | Inputs `fire` + `clipId`; output `spawned: Event<SpawnRef>`. Clones the clip's owner + duplicates the clip with lanes remapped, plays it once ephemerally, despawns on completion. See [spawn.md](spawn.md). |
| `random` | Inputs `fire`, `min`, `max`, `mode: 'float'\|'int'`. Outputs `fire` event + `value` (Float, pull-cached). Recomputes on fire. |
| `system_hotkey` (label "System Hotkey") | Fires when a system-wide keyboard shortcut is pressed on the machine running the server (even when vspark is unfocused). Combo config `key` (String) + `ctrl`/`shift`/`alt`/`meta` (Bool); outputs `event` (Trigger) + `key` (String). Driven externally by `HotkeyManager` — a global OS keyboard hook that walks running graphs and fires matching nodes (overlive-event pattern). Optional dep `node-global-key-listener`, lazily loaded + graceful-degrade. See [hotkeys.md](hotkeys.md). |

### Bone/blendshape mappers
| Kind | Description |
|------|-------------|
| `rhylive_bone_mapper` | BoneRotations (VMC/RhyLive format) → NormalizedPose (VRM bone names); applies coordinate flipping |
| `arkit_vrm_mapper` | ARKit 52-shape weights → VRM expressions; supports `fcl`, `expressions`, and `passthrough` modes |
| `face_landmarks_to_blendshapes` | 478 MediaPipe face points → mixed `Fcl`/ARKit shapes (vowels A/E/I/O/U, eye blink, brow raise). **Unwired in the default MediaPipe graph** — superseded by the frontend ARKit heuristic (`media/arkitHeuristic.ts`) feeding the `arkit_vrm_mapper` trio (still registered; kept as a manual option / for saved-graph back-compat). |
| `hand_landmarks_to_bones` | 21 MediaPipe hand points → finger joint quaternions (residual rest-pose offsets are an open issue — see mediapipe-tracker.md) |
| `pose_torso_head_to_bones` | 33 MediaPipe body points → torso + head + eye bone quaternions |
| `pose_arms_to_bones` | 33 MediaPipe body points → shoulder/upper-arm/lower-arm quaternions (quat-arm mode) |
| `pose_ik_targets` | 33 MediaPipe body points → chest-relative IK end-effector targets for arms (IK-arm mode) |

### Calibration
| Kind | Description |
|------|-------------|
| `body_calibration` | Captures neutral pose; subtracts offset via quaternion inversion. Supports optional `mirrorPairs` config + `mirrorSource` input port for one-hand symmetric calibration (used by finger_calib in MediaPipe tracker), and `preserveChildren` (`{ bone, parents }[]`) to keep a child's orientation through its parents' correction (used by head_calib for the upper arms). |
| `arm_ik_calibration` | Two-bone arm IK; captures arm reach (finger-to-eye-corner); applies corrected IK at runtime |
| `eye_range_map` (label "Eye Range Map") | `pose` + `nodeId` (SceneNode) + `enabled` (Bool) + `inputMaxDeg` (Float) in → `pose` out. Scales `leftEye`/`rightEye` pitch/yaw so `inputMaxDeg` of tracked rotation reaches the model's VRM look-at range (read via `vrm/lookAt.ts`), clamped beyond; roll dropped, other bones and expression-type look-at models pass through. Inserted into receiver pipelines by `behaviors/eyeRange.ts`. See [ifacialmocap.md](ifacialmocap.md#gaze--eye-range). |
| `pose_manual_calibration` (label "Manual Calibration") | Static `pose` in → `pose` out. For each configured bone, decomposes the quaternion to ZYX euler and applies per axis `angle' = angle * multiplier + offset` (offset in DEGREES, converted to radians; multiplier unitless). Bones with no entry, or at identity (mult `[1,1,1]` / offset `[0,0,0]`), pass through. The per-bone map arrives via a wired `calibrations` value-input (fed by a `settings` node, `field: 'calibrations'`), not a hidden config read; shape `Record<boneName, { multiplier?: [x,y,z]; offset?: [x,y,z] }>`. Ordinary static node (NOT in `INFER_BY_KIND`; ports via decorators / `defaultInfer`, like `body_calibration` / `pose_apply_bone`). Drives the `manual_calibration` behavior interceptor — see [component-managers.md](component-managers.md). Euler-space, so ZYX-order-dependent + degrades at the yaw=±90° gimbal singularity. |
| `pose_style_drivers` (label "Style Drivers") | `pose` + `response` + `preset` in → `drivers` (`StyleDrivers`) out. (`preset` is needed here too because a preset may carry a response baseline — `expressive` tightens the ranges.) Collapses a full pose into nine normalized scalars: head orientation relative to the torso (`neck·head` composed), torso orientation (`hips·spine·chest·upperChest` composed), per-arm elevation, and a motion-`energy` summary. Each is conditioned `÷ range → clamp ±1 → deadzone → rate limit → EMA smooth`; the rate limit is the glitch gate that turns an impossible tracker jump into a human slew, and the frame-rate-compensated EMA keeps the feel constant across tracker rates. Previous-driver state lives on the node INSTANCE (not `setState`) because persisting it would put a SQLite write in the 60Hz pose path; the output memoizes on the input pose object so it integrates exactly once per frame. Ordinary static node (not in `INFER_BY_KIND`). Drives the `pose_stylizer` behavior — see [stylized-tracking.md](stylized-tracking.md). |
| `pose_stylize` (label "Stylize Pose") | `pose` + `drivers` + `amount` + `lag` + `preset` + `rig` + `restUnmapped` in → `pose` out. Rebuilds the pose from the drivers through a `StyleRig` (`bone → {mode, lag, drivers: driverName → [pitch,yaw,roll] degrees at driver 1}`), merged over the rig named by `preset` (`follow` / `counter` / `headOnly` / `headOnlyCounter` / `expressive`; unknown/absent → `follow`). `preset` also supplies the base `lag` when the `lag` input is null. `rigMode` + `simpleRig` add the simplified 6×6 section-total surface on top (identity when empty, so the two editors are interchangeable); `strength` multiplies every rig contribution before the lag integrator. `replace` bones are synthesized outright (bounded by construction → glitch-proof; emitted even if the tracker never sent them, so a face-only source drives a whole body); `add` bones premultiply the offset onto the tracked rotation and are skipped when untracked. A per-bone first-order lag (base `lag` × the rig's per-bone multiplier) staggers the chain for follow-through; `amount` slerps the result against the untouched pose. Per-bone lag state on the instance + memoized on the input pose, same reasoning as above. Ordinary static node. See [stylized-tracking.md](stylized-tracking.md). |
| `blendshape_limits` (label "Expression Limits") | Static `blendshapes` in → `blendshapes` out. Applies the expression-limit rule set: exclusive groups (only the strongest member of a set of competing expressions survives, losers scaled by `1 − strength × winnerWeight`) then clamp rules (targets capped into `[min, max]` while a driver expression is active, ramped by the driver's weight). The rule set arrives via a wired `limits` value-input (fed by a `settings` node, `field: 'limits'`), not a hidden config read. The engine itself is the pure `applyBlendshapeLimits` in [`packages/shared/src/blendshapeLimits.ts`](../../packages/shared/src/blendshapeLimits.ts); the node is only the graph wrapper and runs the config through `normalizeBlendshapeLimits` so a malformed hand-edited document degrades to fewer rules instead of a crashed graph. Ordinary static node (NOT in `INFER_BY_KIND`). Drives the `blendshape_limiter` behavior interceptor — see [component-managers.md](component-managers.md). |

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
| `cycle` | Routes one incoming `Event<T>` to one of N outgoing `Event<T>` ports, advancing the active output each fire (round-robin). `N = 2` is a toggle. Output COUNT from `config.count` (>= 2); active index in `getState/setState` (survives reconcile). Outputs are DYNAMIC (`out0..outN-1`, no decorated members, emitted via `this.emitOn`) and mirror the resolved `in` payload type (see `inferCycle` in `infer_nodes.ts`). First node to use dynamic event-outs. |

### Output/broadcast
| Kind | Description |
|------|-------------|
| `pose_broadcast` (label "Send Pose") | NormalizedPose → WebSocket `vmc_pose` broadcast; respects interceptor chain. Its `behaviorId` value-in port supplies the producing behavior's instance id. |
| `blendshapes_broadcast` (label "Send Blendshapes") | Blendshapes → WebSocket `vmc_blendshapes` broadcast. Same `behaviorId`-port note as `pose_broadcast`. |
| `set_expression` (label "Set Expression") | Sets a single VRM expression weight (0..1) on an avatar at runtime. Inputs `fire` (Trigger), `nodeId` (SceneNode target), `expression` (String), `weight` (Float, default 1). On fire, publishes a one-entry `Blendshapes` to the broadcast bus (same path as `blendshapes_broadcast` / `api_controller`) — a **sticky** producer slot that holds until re-fired or the graph stops. Producer id derived from the node's own `selfId` so it works in standalone Logic (no behavior) and is cleaned up in `onUnbind`. Pairs with `cycle` for toggle/clear (weight 0). |
| `ik_broadcast` (label "Send IK Targets") | IkTargetFrame → WebSocket `ik_targets` broadcast (consumed by frontend `ikTargetStore` + Viewport Step 2.5 solver) |
| `set_scene_node_param` (label "Set Object Property") | Writes a scalar/coerced paramPath into the runtime override bus for a scene node. Optional `spawnRef` event input retargets the fire to a tmp id. See [runtime-overrides.md](runtime-overrides.md). |
| `set_compose_layer_param` (label "Set Layer Property") | Same shape, compose-layer target. |
| `set_text` | Convenience over the set-param nodes for the `text.content` paramPath; `spawnRef.kind` overrides `targetKind` when triggered via that port. |
| `set_data` | Generic sibling of `set_text`: on `fire`, publishes the wired `data` (Any) payload to the named `channel` (String) on the data-channel bus → frontend `feed` layer. See [data-channels.md](data-channels.md). |
| `media_control` | Fire-and-forget media command (play/pause/stop/restart/seek/setVolume/mute/unmute) onto the media-command bus. Config `action`/`targetKind`/`targetId`; inputs `target` (SceneEntity, picker-or-wired), `t` (Float, for seek), `volume` (Float, for setVolume), `action` (String, falls back to config), `assetId` (String, falls back to config; forwarded only on play/restart — plays that collection video on the target temporarily); a `spawnRef` event retargets to a spawned instance for that fire. tags `['media','output']`. See [media.md](media.md). |
| `play_sound` | Plays a collection sound once in every audible tab of the project, without an audio entity (`MediaControlManager.playSound` → `sound_cue` mesh model). Event in `fire`; value inputs `assetId` (String), `volume` (Float 0..1); both fall back to config. Uses the injected `_projectId`. tags `['output']`. See [media.md](media.md#media-one-shots). |

### Interceptor chains
Interceptor chains let behaviors modify a frame in-flight, after the broadcast bus
has composed every producer's contribution but before it goes out over the
WebSocket. There are two independent chains — one for bones, one for expression
weights — with identical shapes and separate registries
(`signal/pose_interceptor_registry.ts`, `signal/blendshape_interceptor_registry.ts`).
Both are entered from `BroadcastBus._composeAndEmit`: if `start()` reports that a
chain exists, the bus does NOT emit and the chain's terminal node does, via
`emitMergedPose` / `emitMergedBlendshapes`. Priority orders the chain (higher runs
first); ties break by registration order. Interceptors receive the frame after Tracking Mix weighting has been applied by the bus (see [component-managers.md](component-managers.md#broadcastbus--broadcastbusts)).

| Kind | Description |
|------|-------------|
| `on_pose_broadcast` (label "Intercept Pose") | Entry for a pose interceptor graph; receives an `InterceptorFrame` from the registry |
| `pose_interceptor_broadcast` (label "Send Intercepted Pose") | Exit for a pose interceptor graph; advances the chain or performs the final broadcast |
| `on_blendshapes_broadcast` (label "Intercept Blendshapes") | Entry for a blendshape interceptor graph; receives a `BlendshapeInterceptorFrame`. The frame type is deliberately distinct from `InterceptorFrame` so a pose frame can't be wired into a blendshape terminal. |
| `blendshapes_interceptor_broadcast` (label "Send Intercepted Blendshapes") | Exit for a blendshape interceptor graph; advances the chain or performs the final broadcast |

### Logic helpers — conditions, text, variables, triggers, combos

General-purpose nodes added for the Actions plan (phase 1,
[plans/actions.md](../plans/actions.md)); each is usable in any Logic graph. Plan
decisions they implement — **Decided** (user, 2026-11-06): regex is a pure node and
gating is a separate `if_else`; variables and triggers are project-wide; variables
take an optional `scope`; a cooldown takes an optional shared `group`; combos are two
separate kinds, threshold and timeout.

Pull outputs are recomputed on demand; event outputs that "pass through" mirror the
resolved type of their `in` input (`inferIfElse` / `inferCooldown`, like `cycle`).

| Kind (label) | Inputs → Outputs | Behaviour |
|---|---|---|
| `regex` ("Regex Match") | `text`, `pattern`, `flags` → `matched` (Bool), one String per capture group, `groups` (record) | Pure; memoised on its inputs. Group outputs are dynamic (`inferRegex`) and exist only while `pattern` (and `flags`) are inline literals: a named group is exposed under its name, an unnamed one as `group<n>` where *n* is the capture index (`$n` numbering, so `(?<a>x)(y)` gives `a`, `group2`). A group never shadows `matched`/`groups` (it falls back to `group<n>`). `groups` holds the **named** groups only. First match only — `g`/`y` are stripped. Empty pattern → no match. Invalid pattern → `matched` false, groups '', warned once per node+pattern. The group scan lives in `regexGroups` (`shared/infer_nodes.ts`), cross-checked against the engine's group count. |
| `if_else` ("If / Else") | `in` (event), `condition` (Bool) → `then`, `else` | Only boolean `true` takes `then`. |
| `equals` | `a`, `b` → `equal` (Bool) | Strict for primitives (`1` ≠ `'1'`, case-sensitive), structural for arrays/plain objects; two unset inputs are equal. |
| `chat_rank` ("Chat Rank") | `isSub`, `isMod`, `isBroadcaster`, `minRank` → `allowed` (Bool) | Ranks `everyone` < `sub` < `mod` < `broadcaster`; empty `minRank` = everyone, an unknown rank never allows. No VIP rank — the chat triggers expose no VIP flag. |
| `text_format` ("Format Text") | `template`, labeled field ports (`config.fields`, like `overlive_send_chat`), `values` (record) → `text` | Pure. `${name}` resolves to the declared field port when it yields a value, else to `values[name]`, else ''. Renderer shared with `overlive_send_chat`: `backend/src/signal/textTemplate.ts` (`renderTemplate`). The canvas card has no field-name editor for it yet (`SignalNodeCard`'s `hasFieldsEditor` lists only `pack_event` / `set_data` — `overlive_send_chat` is in the same position). |
| `logic_id` ("This Logic") | → `id` (String) | The running graph's id, from `config._logicId` (injected by `LogicManager`); '' elsewhere. Use as a variable `scope` for graph-local variables. |
| `variable` ("Get Variable") | `name`, `scope` → `value` | Pure read; unset → nothing. See [variables.md](variables.md). |
| `set_variable` | `fire`, `name`, `scope`, `value`, `persistent` (Bool) → `done`, `value` | Stores `value`, then fires `done`; the `value` output reads the variable (so it is the stored value on `done`). |
| `increment_variable` | `fire`, `name`, `scope`, `by` (Float, default 1), `persistent` → `done`, `value` (Float) | Unset/non-numeric counts as 0. A non-numeric `by` is refused (warned). |
| `cooldown` | `in` (event), `seconds`, `group` → `out`, `blocked` | Passes at most once per `seconds` (blocked events don't restart it); `seconds` ≤ 0/unset passes everything. Empty `group` → private scratch state; a group name → the "last passed" time is the short-lived variable `__cooldown/<group>` of the project, shared by every cooldown with that group (across graphs). Wall-clock compare, no timers; a clock that moved backwards counts as elapsed. |
| `combo_threshold` ("Combo Threshold") | `in` (event), `threshold`, `window` (s), `key` → `reached`, `count` (Float) | Each counted event restarts the window; `reached` fires once per combo when `count` hits `ceil(threshold)` (min 1); the combo resets to 0 when the window runs out. A non-empty `key` already counted in this combo neither counts nor extends it (feed a username for unique chatters); empty/unwired counts every event. No positive `window` → inert. |
| `combo_timeout` ("Combo Timeout") | `in` (event), `timeout` (s), `key` → `ended`, `count` (Float) | Each counted event restarts the timeout; `ended` fires on every expiry (also a combo of 1 — gate with `if_else`). `count` is the running count, and after `ended` the final count, held until the next counted event starts a new combo. Same `key` rule. |
| `send_trigger` ("Send Trigger") | `fire`, `name`, `payload` (Any) | Sends a named trigger to every running Logic graph of the same project (`_projectId`); empty name / no project → nothing. |
| `on_trigger` ("On Trigger") | `name` → `event`, `payload` | Fires when a trigger with exactly this name (trimmed) is sent in its project; empty name never fires. Receives externally on an `event` input, like the overlive / hotkey sources. |

**Trigger routing** — `backend/src/triggers/router.ts` walks
`logicManager.iterateNodes()` (the hotkey/overlive pattern), filters to `on_trigger`
nodes of the sending project and fires each; the node checks the name against its own
(possibly wired) `name` input. Delivery is synchronous, inside the sender's `fire`.
Re-entrancy guard (phase-1 implementation choice, not a user decision): a send whose
(project, name) is already being delivered further up the stack is dropped as a loop,
and so is any send nested deeper than `MAX_TRIGGER_DEPTH` (16); each is warned once
per (project, name, reason). So a trigger cannot synchronously re-send itself, even
through other triggers. Behavior graphs are not in `iterateNodes()` and receive no
triggers.

**Timers and teardown** — the combo nodes keep their pending `setTimeout` on the
instance and clear it in `onUnbind`, which `SignalGraph.dispose()` calls when
`LogicManager` stops or rebuilds a graph, so a stopped graph never fires late. Behavior
managers do not call `dispose()` today, so a combo node in a behavior graph would keep
its timer until it expires (no behavior template uses one).

**Context injected by `LogicManager`** — besides `_projectId`, every node's config
carries `_logicId` (the graph's id); `logic_id` reads it.

### Config/context
| Kind | Description |
|------|-------------|
| `settings` (label "Settings"; kind id was `behavior_config` until the Actions work) | Dot-notation extractor on the graph owner's settings JSON (e.g., `field: "myNode.param"`), injected as `_settings` by whoever runs the graph — a behavior manager (the behavior's config) or `LogicManager` for Action-owned logic (the action's settings). |
| `behavior_id` (label "This Behavior") | Injects the owning behavior's instance id as a string value. |
| `scene_entity` (label "This Entity") | Outputs the id of the entity the logic/behavior is scoped to; output type follows scope (`SceneNode` / `ComposeLayer`) |
| `viseme_passthrough` (label "Visemes → Blendshapes") | Scales viseme weights by its `sensitivity` value input (falls back to `config.sensitivity`; the Lipsync template feeds it from the behavior's `sensitivity` setting), clamped to [0, 1] |

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

**Two shapes, one meaning.** The above is the RUNTIME shape — what the engine instantiates from and what the canvas renders, both of which want lists. A *persisted* graph (the `logic` table, see [project-graphs.md](project-graphs.md)) is stored and synced as a `GraphDescriptorDoc`, with `nodes` and `edges` keyed by id: a list is one mesh path, so two people editing one graph would overwrite each other's whole program. `toGraphDescriptor` / `toDescriptorDoc` convert at the boundary, and `toGraphDescriptor` also accepts the list form, so a descriptor written before the keying still loads. An edge's key is DERIVED from its endpoints (`edgeKey`), because edges carry no id — which also means two peers drawing the same connection converge instead of duplicating it. Behavior graphs are built in code and never persisted, so they only ever exist in the runtime shape.

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

- **Typed `settings`** — `inferPorts`-based typing is deferred: there is no config-schema registry, so writable Logic graphs other than Action and Behavior graphs simply **reject** the node and its `BehaviorConfig` wildcard (→ `unknown`) output stays. Stays planned for a later phase.
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
4. For state that must survive `reconcile()`, use `this.getState<T>()` / `this.setState(v)` — do not keep it in plain instance fields. That state is scratch (graph-lifetime) by default. Add `static readonly persistState = true` only if the user would expect it back after a restart, and only if it is plain JSON — never a `Blendshapes` / `NormalizedPose` / `Quaternion` / `Map`, which do not survive the round-trip.
5. Register the class in `packages/backend/src/signal/registry.ts`.
6. If the node has dynamic ports or non-trivial type relationships, add an `inferPorts` entry to `INFER_BY_KIND` in `packages/shared/src/infer_nodes.ts` (shared by engine + frontend). Dynamic-port nodes read/write by name via `this.input(name)`, `this.emitOn(name, v)`, and `setDynamicOutputs(resolve)` — set these up in the `protected onBind()` hook (the constructor runs before ports are wired).
7. Add the node to the appropriate manager's graph descriptor if it belongs to a built-in pipeline.

Reference examples in `packages/backend/src/signal/nodes/`: `multiply.ts` (pure `@valueIn`/`@valueOut`), `queue_events.ts` (`@eventIn` reactions + `getState/setState` + `@valueOut`), `pack_event.ts` (dynamic value-in via `this.input`), `unpack_event.ts` (`onBind` + `setDynamicOutputs` for dynamic value-outs).
