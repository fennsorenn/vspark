# vspark — Architecture

Real-time 3D avatar streaming system. Motion capture data (VMC over UDP, MediaPipe from browser, mic lipsync) flows into server-side reactive signal graphs, which broadcast pose/blendshape updates to a Three.js/VRM viewport in the browser.

## Monorepo Layout

```
packages/
  backend/    Node.js/Express — signal graph engine, SQLite persistence, motion capture managers
  frontend/   React + React Three Fiber — 3D viewport, node graph editor, Zustand state
  shared/     TypeScript types, Zod schemas, signal graph type definitions
```

## Core Abstractions

| Concept | Description |
|---------|-------------|
| Project | Top-level workspace. All entities are strictly project-scoped. |
| Scene | A `scene_nodes` row with `kind = 'scene'` — itself a node. The scene tree's root. (Migration 018 dropped the standalone `scenes` table; scene ids are reused as the kind=scene node ids.) |
| Node | Spatial entity (VRM, camera, light, group, etc.). Unique ID, transform inheritance. Roots back to its scene via `root_scene_node_id`. |
| Compose Scene | A `compose_layers` row with `kind = 'compose_scene'` — root of a per-project compose hierarchy (decoupled from 3D scenes). Layers nest via `parent_id` (migration 016) and root via `root_compose_scene_id`. |
| Component | Behavioral driver attached to a node (VMC receiver, breathing, lipsync, tracking). Backed by a signal graph. |
| Signal Graph | Reactive execution engine: push-based events + pull-based values. One graph per component instance. |
| PoseFrame | Sparse bone rotation payload broadcast over WebSocket at ~60Hz. |

## Module Status

### Backend — `packages/backend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| HTTP + WebSocket server | Implemented | `index.ts` |
| REST API | Implemented | `routes/` — split per resource (projects, scenes, scene-nodes, assets, node-components, api-controller, expressions, camera-effects, signal, meta) composed via `routes/index.ts`; manager singletons + helpers in `routes/shared.ts` |
| OpenAPI docs | Implemented | Swagger UI at `/api-docs`, raw spec at `/api-docs.json`; `routes/openapi.ts` generates `components.schemas` from Zod via `@asteasolutions/zod-to-openapi`; per-route `@openapi` JSDoc scanned by `swagger-jsdoc` |
| Update routes | Implemented | `routes/update.ts`, `routes/config.ts` — GitHub Releases update check/download/apply, config.json channel preference |
| SQLite persistence | Implemented | `db/` — `node-sqlite3-wasm` (WASM, no native addon); `WasmDb` adapter; `initDb()` async |
| Signal graph engine | Implemented | `signal/engine.ts` — typed ports, value cache, cycle detection |
| Signal node registry | Implemented | `signal/registry.ts` — 54 node kinds (mediapipe converters + IK, runtime mutation primitives `random` / `start_clip` / `spawn_clip` / `set_scene_node_param` / `set_compose_layer_param` / `set_text`, `log` debug, plus 13 overlive event nodes) |
| Engine value-input auto-fallback to `config.<port>` | Implemented | `signal/engine.ts` — unconnected value-input ports automatically resolve to `defaultConfig.<portName>`; nodes no longer need per-port `cfg?.X` boilerplate |
| VMC receiver manager | Implemented | `node_components/vmc_receiver/` |
| Shared UDP socket pool (vmc_receiver) | Implemented | `vmc/udp_socket_pool.ts` — refcounted `UdpSocketPool` singleton (`udpSocketPool`) exposing `subscribe(port, listener, onBound?) -> unsubscribe`. First subscriber binds (currently `0.0.0.0`), last unsubscribe closes; listener dispatch snapshots the set so mid-dispatch unsubscribe is safe. `VmcManager.startReceiver` subscribes instead of binding its own `dgram` socket, so multiple `vmc_receiver` components on the same port each receive every packet independently. See [component-managers.md](modules/component-managers.md). |
| Breathing manager | Implemented | `node_components/breathing/` |
| Lipsync manager | Implemented | `node_components/lipsync/` |
| MediaPipe tracking manager | Implemented | `node_components/mediapipe_tracker/` |
| API controller manager | Implemented | `node_components/api_controller/` — REST-driven animation queue + blendshapes; first component with a public REST control surface |
| VRM skeleton parsing | Implemented | `vrm/skeleton.ts` — GLB/VRM 0.x + 1.x |
| WebSocket sync | Implemented | `ws/index.ts` — broadcast bus |
| Broadcast bus lifecycle refactor | Implemented | `broadcast/bus.ts` — final-fallback frame (empty bones + `animationBlendMode: 'additive'`, empty blendshapes) on last-producer removal; vmc_receiver tracking-loss now calls `removeComponent`; mediapipe `pose_broadcast`/`blendshapes_broadcast` now wired with `componentId`. See [component-managers.md](modules/component-managers.md) and [frontend.md](modules/frontend.md). |
| `scene_nodes.properties` JSON column | Implemented | Migration 007; per-node properties bag, first use `blendTransitionTime` on VRM avatar nodes; PUT shallow-merges (mirrors scene `runtime_settings`) |
| Breathing component (6-bone topology) | Implemented | `node_components/breathing/` — drives chest/upperChest + L/R shoulder lift with counter-rotated upper arms; configurable `chestAmplitude` + `shoulderAmplitude` via `component_config` nodes; remaining literals collapsed into per-port `defaultConfig` |
| Track clips (timeline parameter animation) | Implemented | Scene-scoped clips with lanes (`target_kind` + `target_id` + scalar `param_path`) and keyframes (linear/step/bezier easing). `TrackClipPlaybackManager` (`track_clips/playback.ts`) owns the playhead anchor with discriminated entries (`{kind:'playing', startedAt} | {kind:'paused', pausedAtT}`); supports play / pause / resume / stop / seek. Autoplay+loop persists `started_at` so loops resume in-phase after restart; paused state is ephemeral. Migration 009 adds `track_clips`, `track_clip_lanes`, `track_clip_keyframes`. Routes in `routes/track-clips.ts` include `/trigger /stop /pause /resume /seek`; scene bundle includes nested `trackClips`. Signal node kind `track_clip_trigger`. WS: `track_clip_added/updated/removed/lane_added/lane_updated/lane_removed/keyframes_replaced/started/stopped/paused/playback_snapshot` (snapshot sent on every new WS connect; entries carry either `startedAt` or `pausedAtT`). See [track-clips.md](modules/track-clips.md). |
| Standalone graphs (project / scene-node / compose-layer scope) | Implemented | Unified `graphs` table (migration 014) with `owner_kind ∈ {project, scene_node, compose_layer}` served by generic `routes/graphs.ts` (`/api/projects/:id/graphs`, `/api/scene-nodes/:id/graphs`, `/api/compose-layers/:id/graphs`, `/api/graphs/:id`). `ProjectGraphManager` (despite the name) runs all three owner kinds: boot via `startAllEnabled()`, `reconcile()` on every create/update, per-graph `node_state` JSON, `fire()` entry for external events. For scoped (scene_node / compose_layer) graphs the manager auto-injects a synthetic `scene_entity` context node bound to the owner id at start time. Descriptor validation rejects `component_config` / `component_id` / explicit `scene_entity`. `SignalGraphCanvas` is **writable** for all standalone graphs — edits PUT the descriptor and `reconcile()` rehydrates the running instance. Frontend exposes them in the editor via `GraphsSection` (per scene node + compose layer) and a `Standalone graphs` group in the graphs panel. See [project-graphs.md](modules/project-graphs.md). |
| Overlive integration (Twitch + SE) | Implemented | `OverliveManager` runs one shared `OverliveKit` per loaded project; account row id is the adapter `instanceId`; token-refresh callback persists rotated tokens; adapter state changes persist to `status`/`status_reason`/`status_message` and broadcast as `overlive_account_status` WS payload; on delete, Twitch tokens are revoked via `@overlive/twitch-oauth` before the row drops. Per-project Twitch app credentials (migration 012, plaintext) + OAuth accounts (migration 013) + SE JWT accounts (`app_credential_id` NULL). OAuth in `routes/overlive-auth.ts` (in-memory CSRF state, 10min TTL, popup posts back to `window.opener`; reconnect reuses the row id so graphs keep working). Accounts modal in TopBar. New `Account` port type (`SignalTypeMap.Account`, colour `#9146ff`). 13 event signal nodes (`overlive_redemption`, `overlive_subscription`, `overlive_gift_bomb`, `overlive_raid`, `overlive_follow`, `overlive_chat_message`, `overlive_chat_command`, `overlive_chat_delete`, `overlive_ad_start`, `overlive_ad_end`, `overlive_ban`, `overlive_stream_online`, `overlive_stream_offline`). See [overlive.md](modules/overlive.md). |
| Runtime overrides bus | Implemented (Phase 1) | `runtime_overrides/manager.ts` — scene-scoped in-memory bus keyed by `sceneId → (targetKind, targetId, paramPath)`. Public: `set / clear / clearAllForTarget / registerTarget / sendSnapshotTo`. WS: `runtime_override_set`, `runtime_override_clear`, `runtime_override_snapshot` (on connect). Two modes: ephemeral (default) and persistent (via injected persist hook; currently null in `index.ts` so `persist: true` keeps the in-bus value and logs). Parallel to track-clip overrides; clip wins on conflict for transform/scalar paths. See [runtime-overrides.md](modules/runtime-overrides.md). |
| Spawn manager | Implemented (Phase 1) | `spawn/manager.ts` — ephemeral clip-clone spawning. On `spawn_clip`, deep-clones the owner of a clip with a `__spawn:UUID` id (always unhidden), broadcasts `node_added`/`compose_layer_added`, duplicates the clip with lanes remapped + `track_clip_added`, then calls `playback.triggerEphemeral`. Listens to `playback.onClipFinished` to broadcast removal messages + `clearAllForTarget` on the override bus. Pre-registers the tmp target's scene via `runtimeOverrideManager.registerTarget` so subsequent `set_*_param` calls don't have to look it up in SQLite. Tmp entities are in-memory only, never persisted. See [spawn.md](modules/spawn.md). |
| Text rendering (3D) | Implemented (Phase 1) | New scene-node kinds `text_troika` (SDF via `troika-three-text`, optional billboard quaternion-lock) and `text_canvas` (`THREE.CanvasTexture` on a plane; plain text via 2D ctx + word-wrap, or sanitised HTML via DOMPurify + off-DOM `html2canvas` for emote support). Both flat-mounted via `SceneNodes`. See [scene-graph.md](modules/scene-graph.md). |
| Opacity (compose + 3D) | Implemented (Phase 1) | New `opacity` paramPath on both target kinds. Compose: `ComposeLayerOverride` gains `opacity` (also `width`/`height` for matching clip-side animation); merged into `LayerView` `layerStyle`. 3D: added to `components.transform` (default 1); new `useApplyOpacity(groupRef, opacity)` per-frame mesh walk sets `material.transparent`/`material.opacity` with per-material cache + restores the original `transparent` flag when opacity returns to `≥1`. Wired into Avatar/Model/Billboard/Particle/GodrayCaster nodes (lights/cameras skipped). Animatable via track clips and runtime overrides. |
| New signal nodes (Phase 1) | Implemented | `random`, `start_clip` (canonical generalisation of `track_clip_trigger`; old kind retained for back-compat), `spawn_clip`, `set_scene_node_param`, `set_compose_layer_param`, `set_text`. Demo Flow A graph shipped as a sample JSON at [dev-notes/samples/chat-billboard-demo.json](samples/chat-billboard-demo.json), not as a boot-time auto-seed (the seed proposal was dropped because it would silently no-op without user-created ids). See [signal-graph.md](modules/signal-graph.md). |
| `SpawnRef` named type | Implemented (Phase 1) | New primitive in `SignalTypeMap`: `{ tmpNodeId, tmpClipId, kind: 'scene_node'\|'compose_layer' }` plus colour entry in `SIGNAL_TYPE_COLORS`. `spawn_clip` outputs `Event<SpawnRef>`; `set_*_param` / `set_text` nodes accept an optional `spawnRef` event input that overrides `targetId` (and for `set_text`, `targetKind`) for that fire — detected via `ctx.triggeredPort === 'spawnRef'`. Mismatched kinds are refused with a `console.warn`. Phase 1 special case that avoids needing generic propagation. |
| ParamPath registry (shared) | Implemented (Phase 1) | `packages/shared/src/paramPaths.ts` — registry `(target_kind, paramPath) → {type, defaultValue, animatable, kinds?}` plus `coerceParamValue` helper; exported via the `./paramPaths` subpath of `@vspark/shared`. Consumed by the track-clip evaluator (animatable filter), the new `set_*_param` / `set_text` nodes (fire-time coercion), and the runtime override bus (type routing). See [paramPaths.md](modules/paramPaths.md). |
| Signal graph type inference | Planned (Phase 2, blocking) | Edge-time structural type inference. New `packages/shared/src/signal_types.ts` (`ResolvedType` AST, `isAssignable`), `packages/shared/src/inference.ts` (`tryAddEdge`/`removeEdge`). `SignalNodeClass` gains optional `inferPorts` hook; engine node entries gain resolved port state; `fromDescriptor` becomes a replay over `tryAddEdge`. Editor uses the same shared inference for drag-time validation and dynamic port rendering. `'Any'` becomes the surface for `{ kind: 'unknown' }` — backwards compatible. See [signal-graph.md](modules/signal-graph.md). |
| Phase 2 signal nodes (post-inference) | Planned | `pack_event` (record-typed event from N value ports), `queue_events` (FIFO passthrough), generic rewrite of `unpack_event` (one typed output port per record field, with `inferPorts`). |
| Typed `component_config` | Planned (Phase 2) | `component_config` gets `inferPorts`: looks up the chosen `field` against the component-kind's Zod config schema and returns the field's `ResolvedType` as the output port type. Requires the inference architecture. |
| Compose layers (DB + routes + WS) | Implemented | Backend half of the Compose View feature. Migration 008 adds `compose_layers` table (scene-scoped, nullable `camera_node_id` for per-camera layers, two-axis ordering: `scene_order` signed with 0 = 3D render slot, negative = in front, positive = behind; `camera_order` anchored to a `scene_order` slot; pixel-space `x`/`y` + anchor `top|bottom × left|right`; `rotation` degrees). REST routes in `routes/compose-layers.ts`; scene bundle endpoint includes `composeLayers`. WS broadcasts: `compose_layer_added/updated/removed/reordered`. Deleting a scene-wide layer re-anchors any camera-specific layers anchored at its `scene_order` slot. Layer kinds: image, video, browser-iframe. See [compose.md](modules/compose.md). |

### Frontend — `packages/frontend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| Router + App shell | Implemented | `App.tsx` — 4 routes |
| Zustand store | Implemented | `store/editorStore.ts` — includes update state slice (updateAvailable, updateInfo, pendingReload) |
| 3D Viewport | Implemented | `components/editor/Viewport.tsx` — R3F, pose application, post-processing, particles |
| Viewport pose-gate rewrite | Implemented | Drops `vmcCompRef`/tracking-lost gates; pose applied whenever `pose != null && Object.keys(pose).length > 0 && fresh`; `blendMode` now selects composition strategy (override = replace anim; additive = `animQ * (restRawQ⁻¹ * posedRawQ)`); ramps over per-avatar `blendTransitionTime` (default 0.5s) |
| PropertiesPanel: blend-time relocation + breathing UI | Implemented | `blendTime` removed from vmc_receiver UI; `blendTransitionTime` lives on the VRM avatar node's `properties`; new `BreathingProps` panel (Chest amplitude + Shoulder lift) |
| Scene graph panel | Implemented | `components/editor/SceneGraph.tsx` |
| Properties panel | Implemented | `components/editor/PropertiesPanel.tsx` |
| Asset manager | Implemented | `components/editor/AssetManager.tsx` |
| TopBar update UI | Implemented | `components/editor/TopBar.tsx` + `components/editor/UpdateDialog.tsx` — update badge, channel selector, download/apply flow |
| Signal graph editor | Implemented | `components/editor/signal/SignalGraphCanvas.tsx` |
| WebSocket sync | Implemented | `hooks/useWsSync.ts` — includes server_update handler + pendingReload-on-reconnect |
| Lipsync uplink | Implemented | `hooks/useLipsyncUplink.ts` — mic → WS |
| Lipsync MFCC classifier | Implemented | `media/MicCapture.ts` — in-browser MFCC vowel classification + per-component calibration |
| Tracking uplink | Implemented | `hooks/useTrackingUplink.ts` — MediaPipe → WS |
| Track Clips timeline (bottom-dock tab) | Implemented | `'clips'` tab in `AssetManager.tsx` mounts `TrackClipTimeline` (clip list + multi-lane editor with draggable keyframes, draggable `ScrubRuler`, and play / ❚❚ pause / resume / ■ stop transport). `useTrackClipEvaluator` runs in both `Editor.tsx` and `ViewerPage.tsx`; evaluates lanes per rAF for both playing and paused entries (paused entries keep their override at the frozen `t` and don't auto-complete) and writes absolute values into store override slots (`nodeTransformOverrides`, `composeLayerOverrides`). Scene-node consumption is per-component via `useTransformWithOverride` in `Viewport.tsx` (no direct Three.js mutation; re-render scope stays per-node). Compose-layer consumption is per-layer in `ComposeLayerStack.LayerView`. Override vs relative is per-clip; relative is pre-folded into the override so consumers always replace. Properties panel gains ◆ set-keyframe buttons per numeric input (and per group) on scene-node transforms and compose-layer x/y/rotation, gated on `useTrackClipRecorder().canRecord` (bottom dock on `'clips'` AND a clip selected). Bottom-dock active tab is lifted from `AssetManager.tsx` local state into the store as `bottomTab` so the Properties panel can gate on it. See [track-clips.md](modules/track-clips.md). |
| Compose View (left-dock tab + viewport) | Implemented | Second tab in the editor's left dock (`leftTab` in store, disabled until at least one camera node exists). `ComposeTree` shows a Scene section plus one per camera with scene-wide layers pinned as interleaved items. `ComposeView` renders the selected camera POV via R3F with behind-/front-layer DOM stacks. `ComposeLayerStack` is shared with `ViewerPage` (`mode: 'editor' | 'viewer'`) so streamed output matches. Drag/resize/rotate gestures in `composeLayerInteractions.ts` patch the store optimistically and persist on pointerup; resize math is anchor-aware so screen-direction drags always grow/shrink visually. Properties panel gains a layer-properties branch. Limitations: no DnD reorder yet (manual ↑/↓ + numeric inputs), no resolution-independent scaling. See [compose.md](modules/compose.md). |

### Shared — `packages/shared/src/`

| Module | Status |
|--------|--------|
| Domain types | Implemented — `types.ts` — includes UpdateChannel, UpdateStatus, AppConfig, server_update WSMessageKind |
| Zod request schemas | Implemented — `schema.ts`; on Zod v4; each schema tagged with `.openapi('Name')` and consumed by the backend to generate OpenAPI `components.schemas` |
| Signal graph types | Implemented — `signal.ts` (Quaternion, NormalizedPose, VRM_BONE_NAMES, SignalNodeClass, GraphDescriptor) |

### Release & Deployment

| Module | Status | Notes |
|--------|--------|-------|
| GitHub Actions CI | Implemented | `.github/workflows/ci.yml` — PR-targeted; two required checks: `build` (mirrors release prep: lint + build + backend bundle) and `release-label` (rejects PRs without exactly one `release:patch` / `release:minor` / `release:major` label). |
| GitHub Actions release workflow | Implemented | `.github/workflows/release.yml` — fires on `pull_request: closed && merged == true` to main. `tag` job reads the merged PR's release label, computes the next semver from the last `v*` tag, pushes the annotated tag. Matrix `release` job builds win-x64 + linux-x64 zips with a bundled Node.js 22.16.0 binary + start/updater scripts and publishes to a GitHub Release named after the tag. The old `tag.yml`/`release.yml` split was folded into a single workflow because tags pushed via `GITHUB_TOKEN` don't trigger downstream workflows. |
| Branch protection on `main` | Planned (manual setup) | Configure GitHub branch protection to require the `build` and `release-label` CI checks before merge. Not in any workflow file — has to be set in repo settings. |

## Data Flows

### VMC motion capture

```
UDP port (configurable)
  → VmcManager: parse OSC packets (VMC/RhyLive/ARKit formats)
  → SignalGraph.fire() → vmc_packet_source
  → rhylive_bone_mapper → body_calibration → arm_ik_calibration
  → pose_broadcast → WS vmc_pose
  → [pose interceptors: breathing, etc.]
  → Frontend useWsSync → Zustand → Viewport.useFrame() → VRM bones
```

### Lipsync

```
Browser mic → MicCapture (MFCC → centred+L2 vs per-vowel templates → softmax → EMA)
  → Fcl_MTH_* weights + jawOpen (RMS)
  → useLipsyncUplink (30fps) → WS lipsync_input
  → LipsyncManager.fireVisemes() → lipsync_source
  → unpack_event → viseme_passthrough → blendshapes_broadcast
  → WS vmc_blendshapes → Frontend → VRM expressions
```

Per-component templates live in `node_components.config.vowelTemplates`; see [modules/lipsync.md](modules/lipsync.md).

### MediaPipe tracking

Browser-side camera capture runs in a Web Worker (`public/mediapipeWorker.js`, built from
`src/media/mediapipeWorker.ts` via `scripts/build-mediapipe-worker.mjs`) at 320×240, 10 FPS.
Landmarks are sent over WS and processed in a backend signal graph:

```
Browser camera (worker) → MediaPipe Holistic → useTrackingUplink
  → WS tracking_input
  → TrackingManager.fireLandmarks() → mediapipe_source
     ├── face   → face_landmarks_to_blendshapes ─┐
     ├── pose   → pose_torso_head_to_bones ──────┤
     ├── pose   → pose_arms_to_bones (quat arms) ┤
     ├── hands  → hand_landmarks_to_bones (L/R) ─┤
     │                                           ├── pose_merge
     │                                           │     → head_calib (body_calibration: HEAD_CALIB_BONES)
     │                                           │     → finger_calib (body_calibration: FINGER_CALIB_BONES, mirrorPairs)
     │                                           │     → pose_broadcast → WS vmc_pose
     │                                           └── blendshapes_broadcast → WS vmc_blendshapes
     └── pose   → pose_ik_targets → ik_broadcast → WS ik_targets   (IK-arms branch)

Arm mode toggle: useIk config → not_bool fan-out enables either pose_arms_to_bones
                  or pose_ik_targets/ik_broadcast branch.
Capture/reset:   component_trigger nodes wired via POST /api/signal/graphs/:id/fire
                  (api.ts dispatches by graph-id prefix to VMC or TrackingManager).
```

Frontend `Viewport.tsx` Step 2.5 runs an analytical two-bone IK solve
(`_solveTwoBoneIk`) in parent space using rest-pose bone offsets, with
source-to-avatar shoulder scaling and chest-relative target frame.

### Scene state mutations

```
REST write → SQLite → WS broadcast (node_added/updated/removed, camera_effect_*)
  → Frontend useWsSync → Zustand store → React UI
```

## Module Docs

- [signal-graph.md](modules/signal-graph.md) — engine, all 26 node kinds, how to add a new node
- [component-managers.md](modules/component-managers.md) — VMC, breathing, lipsync, tracking, api_controller managers; lifecycle pattern
- [api-controller.md](modules/api-controller.md) — REST-driven animation/blendshape control surface, the first node component with public REST endpoints
- [backend-api.md](modules/backend-api.md) — REST routes, WebSocket, DB migrations
- [frontend.md](modules/frontend.md) — Zustand store, Viewport, editor panels, hooks
- [shared-types.md](modules/shared-types.md) — domain types, Quaternion/NormalizedPose/Blendshapes, port system
- [scene-graph.md](modules/scene-graph.md) — node hierarchy, DB model, Viewport rendering, bone attachment, reparenting
- [asset-management.md](modules/asset-management.md) — file upload, storage layout, discovery, scene placement
- [camera-effects.md](modules/camera-effects.md) — post-processing pipeline, all 18 effect kinds, config schemas
- [animation.md](modules/animation.md) — FBX/BVH retargeting, VMC pose application, blendshape mapping, clip playback, all coordinate corrections
- [nodes/particle.md](modules/nodes/particle.md) — GPU-instanced particle system, billboard node, shader, physics simulation, camera alignment
- [mediapipe-tracker.md](modules/mediapipe-tracker.md) — MediaPipe tracking pipeline: worker, signal graph, IK arms, head/finger calibration, open work
- [lipsync.md](modules/lipsync.md) — MFCC vowel classification, per-component calibration, default templates
- [compose.md](modules/compose.md) — Compose View: 2D layer composition over the 3D scene, ordering model, shared editor/viewer renderer, anchor-aware drag math
- [track-clips.md](modules/track-clips.md) — Timeline-based parameter animation: scene-scoped clips, scalar lanes targeting scene nodes / compose layers, backend-authoritative playhead, frontend per-frame evaluator with per-component override subscriptions
- [project-graphs.md](modules/project-graphs.md) — standalone signal graphs (project / scene-node / compose-layer scopes), writable canvas, unified lifecycle via `ProjectGraphManager`, `fire()` entry for external events
- [presets.md](modules/presets.md) — per-project preset library: serialised scene-node / compose-layer subtrees with nested graphs / clips / camera-effects / animation clips, id placeholders for cross-project portability, paste-onto-bone via `boneAttachment`
- [clipboard.md](modules/clipboard.md) — single discriminated `ClipboardPayload` union (7 kinds) mirrored to OS clipboard + Zustand slice; powers Cmd/Ctrl+C/V across scene nodes, compose layers, graphs, in-graph node selections, camera effects, node components, and track clips
- [overlive.md](modules/overlive.md) — Twitch + StreamElements integration via the `overlive` SDK; accounts, OAuth, `Account` port type, 13 event nodes
- [runtime-overrides.md](modules/runtime-overrides.md) — scene-scoped parallel-to-track-clip override bus for graph-driven runtime param mutation
- [spawn.md](modules/spawn.md) — ephemeral clip-clone spawning; tmp scene-node / compose-layer instances driven by `spawn_clip`
- [paramPaths.md](modules/paramPaths.md) — shared paramPath registry used by clips, runtime overrides, and `set_*_param` nodes

## Future Features / Planned

- **Multi-user usage.** vspark currently assumes a single trusted local user, which is what makes plaintext credential storage acceptable today (Twitch `client_secret` in `app_credentials`, OAuth refresh tokens in `overlive_accounts`, StreamElements JWTs). The moment multi-user support is on the table, **all credential storage MUST be encrypted at rest**. Auth, per-user project scoping, and a key-management story will all need to land together.

## Key Files

- [packages/backend/src/index.ts](../packages/backend/src/index.ts) — server entry, manager init, WS message dispatch, Swagger UI mount
- [packages/backend/src/routes/index.ts](../packages/backend/src/routes/index.ts) — per-resource sub-router composition (manager setters re-exported from `shared.ts`)
- [packages/backend/src/routes/openapi.ts](../packages/backend/src/routes/openapi.ts) — OpenAPI base doc + Zod→OpenAPI components
- [packages/backend/src/signal/engine.ts](../packages/backend/src/signal/engine.ts) — graph runtime
- [packages/backend/src/signal/registry.ts](../packages/backend/src/signal/registry.ts) — node kind registry
- [packages/frontend/src/store/editorStore.ts](../packages/frontend/src/store/editorStore.ts) — Zustand store
- [packages/frontend/src/components/editor/Viewport.tsx](../packages/frontend/src/components/editor/Viewport.tsx) — Three.js canvas + pose application
- [packages/frontend/src/hooks/useWsSync.ts](../packages/frontend/src/hooks/useWsSync.ts) — WebSocket client
- [packages/shared/src/signal.ts](../packages/shared/src/signal.ts) — signal graph type system
