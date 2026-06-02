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

`NODE_REGISTRY` maps kind string → `SignalNodeClass`. All built-in node kinds are registered here (33 from prior phases plus 6 added in Phase 1: `random`, `start_clip`, `spawn_clip`, `set_scene_node_param`, `set_compose_layer_param`, `set_text`). `getAllNodeKindMeta()` returns port declarations and display metadata for each kind — this drives the UI node palette.

## Node Kinds — `signal/nodes/`

Organized by role:

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
| `log` | Debug node: on the `trigger` event path, prints the event payload plus every value wired into its `inputs` **list** port (Any) to the backend console, in connection order. Optional `label` value port / `config.label` prefixes log lines. **Breaking change:** its value-input port was renamed from `input` (single Any) to `inputs` (Any list) — saved graphs wired into the old `input` port need re-wiring. |

### Output/broadcast
| Kind | Description |
|------|-------------|
| `pose_broadcast` | NormalizedPose → WebSocket `vmc_pose` broadcast; respects interceptor chain |
| `blendshapes_broadcast` | Blendshapes → WebSocket `vmc_blendshapes` broadcast |
| `ik_broadcast` | IkTargetFrame → WebSocket `ik_targets` broadcast (consumed by frontend `ikTargetStore` + Viewport Step 2.5 solver) |
| `set_scene_node_param` | Writes a scalar/coerced paramPath into the runtime override bus for a scene node. Optional `spawnRef` event input retargets the fire to a tmp id. See [runtime-overrides.md](runtime-overrides.md). |
| `set_compose_layer_param` | Same shape, compose-layer target. |
| `set_text` | Convenience over the set-param nodes for the `text.content` paramPath; `spawnRef.kind` overrides `targetKind` when triggered via that port. |

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

## In-Flight & Planned Work

### Implemented — Phase 1

Phase 1 of the signal-graph expansion (stream-overlay flows: chat billboards, etc.) is shipped on `dev`. Phase 2 (planned, see below) is the architecture change that unlocks generic typed nodes (`pack_event`, `queue_events`, generic `unpack_event`).

**New node kinds shipped** (`signal/nodes/`, registered in `registry.ts`):

| Kind | Purpose |
|------|---------|
| `set_scene_node_param` | Inputs: `fire` (Trigger), `targetId` (EntityId), `paramPath` (String), `value` (Any — coerced via the paramPath registry), `persist` (Bool), optional `spawnRef` (Event<SpawnRef>) that overrides `targetId` for the fire (detected via `ctx.triggeredPort === 'spawnRef'`). On fire: looks up the registry entry, coerces `value` via `coerceParamValue`, calls `runtimeOverrideManager.set(...)`. `persist: true` is best-effort (see [runtime-overrides.md](runtime-overrides.md)). |
| `set_compose_layer_param` | Same shape, compose-layer target. |
| `set_text` | Convenience over `set_*_param` for the `text.content` paramPath. Accepts `spawnRef`, and when triggered through that port the ref's `kind` overrides `targetKind`. Mismatched ref kinds are refused with a `console.warn`. |
| `start_clip` | Canonical generalisation of `track_clip_trigger`. Calls `playbackManager.trigger(clipId)`. The original `track_clip_trigger` kind is retained for back-compat. |
| `spawn_clip` | Inputs: `fire`, `clipId`. Resolves the clip's owner, calls `spawnManager.spawn(clipId)`. Output: `spawned: Event<SpawnRef>`. See [spawn.md](spawn.md). |
| `random` | Inputs: `fire`, `min`, `max`, `mode: 'float'\|'int'`. Outputs: `fire` event, `value` (Float). Recomputes on fire; cached for pulls. |

**New named type** in `SignalTypeMap`: `SpawnRef = { tmpNodeId: string; tmpClipId: string; kind: 'scene_node' | 'compose_layer' }`, plus a colour entry in `SIGNAL_TYPE_COLORS`. Phase 1 ships this as a concrete primitive so `spawn_clip → set_*_param` works without generic propagation; Phase 2 leaves the type alone but adds pack/unpack for arbitrary payloads.

**Value-port typing note (Phase 1):** `set_*_param`'s `value` input is `Any` and the runtime coerces per the paramPath registry's declared type for the chosen path. Phase 2's inference will replace this with a properly typed port driven from the registry.

**Demo graph (Phase 1):** Flow A — chat → flying billboard: `overlive_chat_message → random (x) → spawn_clip (chat-billboard clip on a hidden text_canvas template) → set_scene_node_param (uses spawned tmpNodeId + random x) → clip animates → auto-despawn`. Shipped as a sample JSON descriptor at [`dev-notes/samples/chat-billboard-demo.json`](../samples/chat-billboard-demo.json) with step-by-step setup instructions inside the file. The plan considered a boot-time auto-seed behind `VSPARK_SEED_DEMO_GRAPH=1`; this was deliberately not implemented because the demo needs ids (overlive account, clip, template node) that only exist after the user has set them up, and a half-bound auto-seed would silently no-op. Flow B (sub/redemption → queued alert) is deferred to Phase 2 because proper queueing needs `queue_events`.

### WIP — Phase 2: node re-architecture + edge-time type inference

> **Status: in progress** on branch `feature/signal-graph-nodes-v2`. Two coupled architecture changes (A + B below) plus three new/rewritten nodes and a ~51-node migration. Nothing here is implemented yet — this section records the intended shape; the class-instance/decorator model and structural inference are **incoming**. Treat the "Adding a new node kind" section above (static `execute` form) as describing the *outgoing* model.

#### A. Node re-architecture — class-instance / decorator model

Signal nodes move from static pure classes (`static inputPorts/outputPorts: PortDecl[]` + `static execute(inputs, config, ctx)`) to **live class instances** whose decorated members ARE their ports:

- `@eventIn('name', TypeTag)` on a **method** — the method body is the reaction; the engine subscribes it to the upstream emitter (push).
- `@valueIn('name', TypeTag)` / `@listIn('name', TypeTag)` on a **field** holding a pull-thunk `() => T` / `() => T[]`.
- `@eventOut('name', TypeTag)` field holding an engine-provided instrumented `Emitter<T>` (node calls `this.x.emit(v)`).
- `@valueOut('name', TypeTag)` field holding a thunk the node defines; the engine calls it on downstream pull.
- Base `abstract class Node` exposes `getState` / `setState` (DB-backed via engine injection). Nodes are mostly stateless; calibration + `queue_events` use these. `reconcile()` stays rebuild-from-scratch.

The **engine** (`signal/engine.ts`) shrinks from a central dispatcher to **wiring + lifecycle** over Node instances. Instrumented Emitter/thunk wrappers preserve the existing `_edgeStates` flash/monitoring, the `enabled` check, and per-node try/catch error isolation.

Toolchain: repo is on TC39 Stage-3 decorators (TS 5.9, **no** `experimentalDecorators`), verified working under `tsc --strict` + tsx + Vite/esbuild.

#### B. Edge-time structural type inference

Transport is folded **into** the type — clean break: `PortKind` / `PortDecl.kind` are **DELETED**. When an edge is created, the downstream node's port shape is recomputed from its currently-resolved inputs and propagated forward; incompatible connections are rejected.

- New `packages/shared/src/signal_types.ts`: `ResolvedType` discriminated union (`primitive | record | event | list | unknown`; `unknown` is the former `'Any'`) + `isAssignable` — structural width subtyping on records, `unknown` wildcard, plus one documented special case: a `List<E>` target accepts source `E` or `List<E>`.
- New `packages/shared/src/inference.ts`: `InferGraph` with `tryAddEdge` (forward propagation + transactional rollback on downstream invalidation), `removeEdge`, `portsOf`.
- `SignalNodeClass` gains optional `inferPorts`. `fromDescriptor` becomes a replay over `tryAddEdge`, eliminating cycle handling as a special case.
- Frontend recomputes the **same** shared inference (shared `INFER_BY_KIND` table) for dynamic typed ports + drag-time validation (e.g. `unpack_event` visibly grows N typed outputs the moment a `pack_event` is wired into it).
- Backwards compat: `'Any'` is repurposed as the surface for `{ kind: 'unknown' }`.

#### Dynamic ports (no new decorator machinery)

Decorations are the static skeleton; `inferPorts` declares the **actual current ports** (a port may have no decorated member). Three additive base-class accessors route by-name through a per-node dynamic port table:

- `this.input(name)` — pull a dynamic value-in.
- `this.emitOn(name, v)` — push a dynamic event-out.
- `this.output(name, fn)` — register a dynamic value-out thunk.

#### New / rewritten nodes (prototype-gated, built first)

| Kind | Purpose |
|------|---------|
| `pack_event` | DYNAMIC user-named input fields — `config.fields` is names-only, each field's type inferred from its connection, with a trailing empty slot to add more. Output `event: Event<{...}>` with field types resolved from connected inputs. |
| `queue_events` | FIFO via `setState`. Inputs `enqueue` + `pop`; `popped` mirrors `enqueue`'s payload type, `size` is a value-out. |
| `unpack_event` (rewrite) | DYNAMIC outputs — one typed port per record field of the resolved event payload; falls back to a single `value: unknown` output when the input is unconnected / non-record (preserves current behaviour). |

Then the remaining ~51 nodes migrate to the new class-instance form.

#### Deferred / out of scope (this branch)

- **Typed `component_config`** — `inferPorts`-based typing is deferred: there is no config-schema registry, so writable graphs simply **reject** the node. Stays planned for a later phase.
- Typed `set_*_param` value input (would replace the `Any` + runtime-coerce approach with a port typed from the paramPath registry).
- Incremental `reconcile` (stays rebuild-from-scratch).

Once landed, this also unblocks Flow B (sub/redemption → queued alert) end-to-end: `overlive_subscription/redemption → pack_event → queue_events ← pop:clock → unpack_event → spawn_clip + set_compose_layer_param`.

## Adding a new node kind

1. Create `packages/backend/src/signal/nodes/my_node.ts` implementing `SignalNodeClass`
2. Decorate with `@SignalNode({ label, description, tags, color })`
3. Register in `packages/backend/src/signal/registry.ts`
4. Add to the appropriate manager's graph descriptor if needed

The node's `execute(inputs)` function receives typed ports (matching static port declarations) and returns typed outputs. Nodes should be pure functions — no side effects except via explicit output ports or `setState`.
