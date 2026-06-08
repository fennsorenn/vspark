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
| Behavior | Behavioral driver attached to a node (VMC receiver, breathing, lipsync, tracking, api_controller). Backed by a signal graph; shown in the "Behaviors" tab. Persisted in the `behaviors` table (renamed from `node_components` in migration 022); code identifier `Behavior`. |
| Logic | A user-built standalone signal graph attached to a project / object / layer. Persisted in the `logic` table (renamed from `graphs` via migrations 022 → 025); code type `Logic`, managed by `LogicManager`. A Logic *is* a signal graph; a Behavior is *backed by* one. |
| Signal Graph | The reactive execution substrate (engine + `GraphDescriptor`): push-based events + pull-based values. One graph instance per Behavior or Logic. Stays named "signal graph"/"graph" at the substrate level. |
| PoseFrame | Sparse bone rotation payload broadcast over WebSocket at ~60Hz. Carries a `behaviorId` (the producing behavior's instance id). |

## Module Status

### Backend — `packages/backend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| HTTP + WebSocket server | Implemented | `index.ts` |
| REST API | Implemented | `routes/` — split per resource (projects, scenes, scene-nodes, assets, behaviors, api-controller, expressions, camera-effects, signal, meta) composed via `routes/index.ts`; manager singletons + helpers in `routes/shared.ts`. Behavior routes are `/api/scene-nodes/:id/behaviors`, `/api/behaviors/:id`, `/api/behavior-kinds`. |
| OpenAPI docs | Implemented | Swagger UI at `/api-docs`, raw spec at `/api-docs.json`; `routes/openapi.ts` generates `components.schemas` from Zod via `@asteasolutions/zod-to-openapi`; per-route `@openapi` JSDoc scanned by `swagger-jsdoc` |
| Update routes | Implemented | `routes/update.ts`, `routes/config.ts` — GitHub Releases update check/download/apply (with download progress), config.json channel preference. Apply exits with sentinel code 42; the bundled `start.sh`/`start.bat` supervisor loop unzips the update in place and relaunches in the same console. See [updates.md](modules/updates.md). |
| SQLite persistence | Implemented | `db/` — `node-sqlite3-wasm` (WASM, no native addon); `WasmDb` adapter; `initDb()` async |
| Signal graph engine | Implemented | `signal/engine.ts` — typed ports, value cache, cycle detection |
| Signal node registry | Implemented | `signal/registry.ts` — 57 node kinds (mediapipe converters + IK, runtime mutation primitives `random` / `start_clip` / `spawn_clip` / `set_scene_node_param` / `set_compose_layer_param` / `set_text` / `set_data`, media `media_control`, `log` debug, plus 13 overlive event nodes + `overlive_chat_feed`) |
| Engine value-input auto-fallback to `config.<port>` | Implemented | `signal/engine.ts` — unconnected value-input ports automatically resolve to `defaultConfig.<portName>`; nodes no longer need per-port `cfg?.X` boilerplate |
| VMC receiver manager | Implemented | `behaviors/vmc_receiver/` |
| Shared UDP socket pool (vmc_receiver) | Implemented | `vmc/udp_socket_pool.ts` — refcounted `UdpSocketPool` singleton (`udpSocketPool`) exposing `subscribe(port, listener, onBound?) -> unsubscribe`. First subscriber binds (currently `0.0.0.0`), last unsubscribe closes; listener dispatch snapshots the set so mid-dispatch unsubscribe is safe. `VmcManager.startReceiver` subscribes instead of binding its own `dgram` socket, so multiple `vmc_receiver` behaviors on the same port each receive every packet independently. See [component-managers.md](modules/component-managers.md). |
| Breathing manager | Implemented | `behaviors/breathing/` |
| Lipsync manager | Implemented | `behaviors/lipsync/` |
| MediaPipe tracking manager | Implemented | `behaviors/mediapipe_tracker/` |
| API controller manager | Implemented | `behaviors/api_controller/` — REST-driven animation queue + blendshapes; first behavior with a public REST control surface |
| VRM skeleton parsing | Implemented | `vrm/skeleton.ts` — GLB/VRM 0.x + 1.x |
| WebSocket sync | Implemented | `ws/index.ts` — broadcast bus |
| Unified sync layer | Implemented (Phases 0–2 + 4); Phase 3 API-surface-only | `sync/` + `packages/shared/src/sync.ts` — one `SyncEnvelope` over a single `'sync'` WS kind for all replicated state, with four resource classes (`document`/`field`/`stream`/`event`), dotted-path addressing, a `defineResource` registry + `sync.document/stream/event` producer hub, and HLC stamping with client-side stale-drop. CRUD **create/delete** of `scene_node`/`behavior`/`camera_effect`/`compose_layer`/`track_clip` (+ preset instantiation) now flows through `sync.document.upsert/remove`; updates, the live pose pipeline, and the runtime-override/data-channel buses are still on legacy WS kinds. `field.*` (override/data-channel fold), live-stream migration, and unified layered store are WIP/planned. See [sync.md](modules/sync.md). |
| Broadcast bus lifecycle refactor | Implemented | `broadcast/bus.ts` — final-fallback frame (empty bones + `animationBlendMode: 'additive'`, empty blendshapes) on last-producer removal; vmc_receiver tracking-loss now removes the producer by `behaviorId`; mediapipe `pose_broadcast`/`blendshapes_broadcast` now wired with `behaviorId`. (The bus keys producers by `behaviorId`, the runtime instance id, renamed from `componentId`.) See [component-managers.md](modules/component-managers.md) and [frontend.md](modules/frontend.md). |
| `scene_nodes.properties` JSON column | Implemented | Migration 007; per-node properties bag, first use `blendTransitionTime` on VRM avatar nodes; PUT shallow-merges (mirrors scene `runtime_settings`) |
| Breathing component (6-bone topology) | Implemented | `behaviors/breathing/` — drives chest/upperChest + L/R shoulder lift with counter-rotated upper arms; configurable `chestAmplitude` + `shoulderAmplitude` via `behavior_config` nodes; remaining literals collapsed into per-port `defaultConfig` |
| Track clips (timeline parameter animation) | Implemented | Scene-scoped clips with lanes (`target_kind` + `target_id` + scalar `param_path`) and keyframes (linear/step/bezier easing). `TrackClipPlaybackManager` (`track_clips/playback.ts`) owns the playhead anchor with discriminated entries (`{kind:'playing', startedAt} | {kind:'paused', pausedAtT}`); supports play / pause / resume / stop / seek. Autoplay+loop persists `started_at` so loops resume in-phase after restart; paused state is ephemeral. Migration 009 adds `track_clips`, `track_clip_lanes`, `track_clip_keyframes`. Routes in `routes/track-clips.ts` include `/trigger /stop /pause /resume /seek`; scene bundle includes nested `trackClips`. Signal node kind `track_clip_trigger`. WS: `track_clip_added/updated/removed/lane_added/lane_updated/lane_removed/keyframes_replaced/started/stopped/paused/playback_snapshot` (snapshot sent on every new WS connect; entries carry either `startedAt` or `pausedAtT`). See [track-clips.md](modules/track-clips.md). |
| Logic (project / object / layer scope) | Implemented | The user-built standalone-signal-graph feature ("Logic"). Unified `logic` table (created as `graphs` in migration 014, renamed to `logic` via migrations 022 → 025) with `owner_kind ∈ {project, scene_node, compose_layer}` served by generic `routes/logic.ts` (`/api/projects/:id/logic`, `/api/scene-nodes/:id/logic`, `/api/compose-layers/:id/logic`, `/api/logic/:id`, plus `/scoped-logic`). `LogicManager` runs all three owner kinds: boot via `startAllEnabled()`, `reconcile()` on every create/update, per-logic `node_state` JSON, `fire()` entry for external events. For scoped (object / layer) logic the manager auto-injects a synthetic `scene_entity` context node bound to the owner id at start time. Descriptor validation rejects `behavior_config` / `behavior_id` / explicit `scene_entity`. `SignalGraphCanvas` (the substrate editor) is **writable** for all logic — edits PUT the descriptor and `reconcile()` rehydrates the running instance. Frontend exposes them via `LogicSection` (per object + layer) and a `Global Logic` group in the left-dock "Logic" panel. See [project-graphs.md](modules/project-graphs.md). |
| Overlive integration (Twitch + SE) | Implemented | `OverliveManager` runs one shared `OverliveKit` per loaded project; account row id is the adapter `instanceId`; token-refresh callback persists rotated tokens; adapter state changes persist to `status`/`status_reason`/`status_message` and broadcast as `overlive_account_status` WS payload; on delete, Twitch tokens are revoked via `@overlive/twitch-oauth` before the row drops. Per-project Twitch app credentials (migration 012, plaintext) + OAuth accounts (migration 013) + SE JWT accounts (`app_credential_id` NULL). OAuth in `routes/overlive-auth.ts` (in-memory CSRF state, 10min TTL, popup posts back to `window.opener`; reconnect reuses the row id so graphs keep working). Accounts modal in TopBar. New `Account` port type (`SignalTypeMap.Account`, colour `#9146ff`). 13 event signal nodes (`overlive_redemption`, `overlive_subscription`, `overlive_gift_bomb`, `overlive_raid`, `overlive_follow`, `overlive_chat_message`, `overlive_chat_command`, `overlive_chat_delete`, `overlive_ad_start`, `overlive_ad_end`, `overlive_ban`, `overlive_stream_online`, `overlive_stream_offline`). See [overlive.md](modules/overlive.md). |
| Data channels + template feed layer | Implemented (Phase 3) | `data_channels/manager.ts` — generic graph→frontend publish bus, sibling of the override bus, keyed by `(scope, field)` (`scope`='' = global, else a consumer's layer/node id; merge semantics so producers don't clobber). `set_data` node has **dynamic labeled input ports** (one field each, à la `pack_event` via shared `inferSetData`) + an optional `scope` input (`SceneEntity`, picker-or-wired) targeting one consumer; WS `data_channel_set/clear/snapshot` (snapshot on connect). Chat-specific half: a bounded per-account chat ring-buffer in `OverliveManager` + `overlive_chat_feed` node (`update` event + `messages` list, configurable `maxLength`). Frontend `feed` compose layer (`ComposeLayerStack.FeedLayer`) reads `global ∪ own-id` and renders through a user-authored **JSX-ish (htm) template** with every field exposed by bare name via `with(channels)` (`${chat.map(...)}` → real React elements + keyed reconciliation), plus a scoped `css` field and an `<Emote>` helper (DOMPurified) for raw emote HTML; templates run via `new Function` (local-use trade-off). Data-shape-independent, config-free consumer. Shared by Editor + ViewerPage. An in-scene (3D) `feed` scene-node kind (`Viewport.FeedCanvasNode`) renders the same template to a `CanvasTexture` (off-screen React root → `html2canvas`), consuming the bus by `global ∪ own node id`; the template engine is shared via `lib/feedTemplate.tsx`. See [data-channels.md](modules/data-channels.md). |
| Runtime overrides bus | Implemented (Phase 1) | `runtime_overrides/manager.ts` — scene-scoped in-memory bus keyed by `sceneId → (targetKind, targetId, paramPath)`. Public: `set / clear / clearAllForTarget / registerTarget / sendSnapshotTo`. WS: `runtime_override_set`, `runtime_override_clear`, `runtime_override_snapshot` (on connect). Two modes: ephemeral (default) and persistent (via injected persist hook; currently null in `index.ts` so `persist: true` keeps the in-bus value and logs). Parallel to track-clip overrides; clip wins on conflict for transform/scalar paths. See [runtime-overrides.md](modules/runtime-overrides.md). |
| Spawn manager | Implemented (Phase 1) | `spawn/manager.ts` — ephemeral clip-clone spawning. On `spawn_clip`, deep-clones the owner of a clip with a `__spawn:UUID` id (always unhidden), broadcasts `node_added`/`compose_layer_added`, duplicates the clip with lanes remapped + `track_clip_added`, then calls `playback.triggerEphemeral`. Listens to `playback.onClipFinished` to broadcast removal messages + `clearAllForTarget` on the override bus. Pre-registers the tmp target's scene via `runtimeOverrideManager.registerTarget` so subsequent `set_*_param` calls don't have to look it up in SQLite. Tmp entities are in-memory only, never persisted. See [spawn.md](modules/spawn.md). |
| Text rendering (3D) | Implemented (Phase 1) | New scene-node kinds `text_troika` (SDF via `troika-three-text`, optional billboard quaternion-lock) and `text_canvas` (`THREE.CanvasTexture` on a plane; plain text via 2D ctx + word-wrap, or sanitised HTML via DOMPurify + off-DOM `html2canvas` for emote support). Both flat-mounted via `SceneNodes`. See [scene-graph.md](modules/scene-graph.md). |
| Opacity (compose + 3D) | Implemented (Phase 1) | New `opacity` paramPath on both target kinds. Compose: `ComposeLayerOverride` gains `opacity` (also `width`/`height` for matching clip-side animation); merged into `LayerView` `layerStyle`. 3D: added to `components.transform` (default 1); new `useApplyOpacity(groupRef, opacity)` per-frame mesh walk sets `material.transparent`/`material.opacity` with per-material cache + restores the original `transparent` flag when opacity returns to `≥1`. Wired into Avatar/Model/Billboard/Particle/GodrayCaster nodes (lights/cameras skipped). Animatable via track clips and runtime overrides. |
| New signal nodes (Phase 1) | Implemented | `random`, `start_clip` (canonical generalisation of `track_clip_trigger`; old kind retained for back-compat), `spawn_clip`, `set_scene_node_param`, `set_compose_layer_param`, `set_text`. Demo Flow A graph shipped as a sample JSON at [dev-notes/samples/chat-billboard-demo.json](samples/chat-billboard-demo.json), not as a boot-time auto-seed (the seed proposal was dropped because it would silently no-op without user-created ids). See [signal-graph.md](modules/signal-graph.md). |
| `SpawnRef` named type | Implemented (Phase 1) | New primitive in `SignalTypeMap`: `{ tmpNodeId, tmpClipId, kind: 'scene_node'\|'compose_layer' }` plus colour entry in `SIGNAL_TYPE_COLORS`. `spawn_clip` outputs `Event<SpawnRef>`; `set_*_param` / `set_text` nodes accept an optional `spawnRef` event input that overrides `targetId` (and for `set_text`, `targetKind`) for that fire — detected via `ctx.triggeredPort === 'spawnRef'`. Mismatched kinds are refused with a `console.warn`. Phase 1 special case that avoids needing generic propagation. |
| ParamPath registry (shared) | Implemented (Phase 1) | `packages/shared/src/paramPaths.ts` — registry `(target_kind, paramPath) → {type, defaultValue, animatable, kinds?}` plus `coerceParamValue` helper; exported via the `./paramPaths` subpath of `@vspark/shared`. Consumed by the track-clip evaluator (animatable filter), the new `set_*_param` / `set_text` nodes (fire-time coercion), and the runtime override bus (type routing). See [paramPaths.md](modules/paramPaths.md). |
| Signal node re-architecture (class-instance / decorator model) | Implemented (Phase 2) | All 54 signal nodes are now **live class instances** extending `abstract class Node` (`packages/shared/src/node.ts`); decorated members ARE the ports (the old `static inputPorts/outputPorts` + `static execute` form is gone). Decorators (`packages/shared/src/node_decorators.ts`): `@eventIn` method (reaction body, engine subscribes it to upstream), `@valueIn`/`@listIn` field (engine assigns a pull-thunk), `@eventOut` field (engine assigns an instrumented `Emitter<T>`), `@valueOut` field (node-defined thunk, pulled on demand). Port metadata is harvested at class-definition time via the Stage-3 `ctx.metadata` buffer, so the palette reads ports without instantiating. Base exposes DB-backed `getState`/`setState`; `reconcile()` stays rebuild-from-scratch. The engine (`signal/engine.ts`) is now **wiring + lifecycle**: `fromDescriptor` instantiates+binds nodes, replays edges through an embedded `InferGraph.tryAddEdge` (rejected edges skipped with a warning), routes accepted edges by derived transport. Instrumented emitters/thunks preserve `_edgeStates` monitoring + the `enabled` gate + try/catch. Public surface preserved (`fire`/`deliverExternal`/`getStates`/`get|setNodeState`/`peekInput`). Repo runs TC39 Stage-3 decorators (TS 5.9, no `experimentalDecorators`). See [signal-graph.md](modules/signal-graph.md). |
| Signal graph type inference | Implemented (Phase 2) | Edge-time structural type inference, with transport folded INTO the type (clean break: `PortKind`/`PortDecl.kind`/`portsCompatible` DELETED). `packages/shared/src/signal_types.ts` — `ResolvedType` AST (`primitive \| record \| event \| list \| unknown`; transport derived via `transportOf`: event=push, list=pull-fan-in, else pull) + `isAssignable` (structural width subtyping on records, `unknown` wildcard both directions, plus one documented special case: a `List<E>` target accepts source `E` or `List<E>`). Both `Any` and `BehaviorConfig` type tags map to `unknown`. `packages/shared/src/inference.ts` — `InferGraph` (`tryAddEdge` with forward propagation + transactional rollback, `removeEdge`, `setConfig`, `portsOf`). `INFER_BY_KIND` table (`packages/shared/src/infer_nodes.ts`) imported by BOTH engine and frontend so they never drift. `NodeKindMeta` carries `{name, resolved, typeTag, transport}` per port + a `dynamic` flag. See [signal-graph.md](modules/signal-graph.md). |
| Phase 2 signal nodes (dynamic ports + class-instance migration) | Implemented (Phase 2) | `pack_event` (DYNAMIC user-named input fields via `config.fields` names-only, type inferred from connections, trailing empty slot; outputs `Event<{...}>`), `queue_events` (FIFO via `setState`, `popped` mirrors `enqueue` payload type, `size` value-out), `unpack_event` rewrite (fires a `trigger` event + DYNAMIC per-field PULL value outputs read from the stored payload — record payload → one output per field, non-record → single `value` output; preserves the push→pull bridge). The remaining nodes are migrated to the class-instance form. **Dynamic ports** need no new decorator machinery: decorations are the static skeleton, `inferPorts` declares the actual current ports (may have no decorated member); base-class accessors route by-name — `this.input(name)` (pull dynamic value-in), `this.emitOn(name, v)` (push dynamic event-out), `setDynamicOutputs(resolve)` (dynamic value-out pulls). Flow B (sub/redemption → pack → queue ← clock pop → unpack → consume) verified FIFO-in-order through the real engine; sample at [samples/queued-alerts-demo.json](samples/queued-alerts-demo.json). |
| Typed `behavior_config` | Deferred (Phase 2, out of scope) | `inferPorts`-based typing of `behavior_config` outputs is **deferred** — there is no config-schema registry yet, so writable graphs reject the node and its `BehaviorConfig` wildcard (→ `unknown`) output stays. Stays planned for a later phase. Also deferred: typed `set_*_param` value input, and incremental `reconcile`. |
| Video & audio assets | Implemented | First-class video + audio: a `video` scene-node kind (3D `THREE.VideoTexture` plane, flat-mounted like `billboard`), an `audio` scene-node kind (non-visual, `THREE.Audio` simple / `THREE.PositionalAudio` directional, shared per-camera `AudioListener`, editor-muted unless `editorAudioPreviewEnabled`), the `video` compose-layer finished (config-driven `VideoLayer` + `mode` threading for audibility), a fire-and-forget **media-command bus** (`media_control/manager.ts`, fourth sibling of broadcast/runtime-overrides/data-channels — stateless, no snapshot), the `media_control` signal node, a frontend **media registry** (`MediaHandle` keyed by node/layer id), and a track-clip **event/marker lane** (migration 021 `track_clip_events`, evaluator fires via `crossedMarker`). Scene-node kinds are schema-free (JSON `components` blob) so no migration for `video`/`audio`. Asset support: video/audio subfolders + ext/MIME + `AssetKind` classification + AssetManager tabs. See [media.md](modules/media.md), [scene-graph.md](modules/scene-graph.md), [compose.md](modules/compose.md), [asset-management.md](modules/asset-management.md), [track-clips.md](modules/track-clips.md), [signal-graph.md](modules/signal-graph.md). |
| Compose layers (DB + routes + WS) | Implemented | Backend half of the Compose View feature. Migration 008 adds `compose_layers` table (scene-scoped, nullable `camera_node_id` for per-camera layers, two-axis ordering: `scene_order` signed with 0 = 3D render slot, negative = in front, positive = behind; `camera_order` anchored to a `scene_order` slot; pixel-space `x`/`y` + anchor `top|bottom × left|right`; `rotation` degrees). REST routes in `routes/compose-layers.ts`; scene bundle endpoint includes `composeLayers`. WS broadcasts: `compose_layer_added/updated/removed/reordered`. Deleting a scene-wide layer re-anchors any camera-specific layers anchored at its `scene_order` slot. Layer kinds: image, video, browser-iframe. See [compose.md](modules/compose.md). |

### Frontend — `packages/frontend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| Router + App shell | Implemented | `App.tsx` — 4 routes |
| Zustand store | Implemented | `store/editorStore.ts` — includes update state slice (updateAvailable, updateInfo, pendingReload) |
| 3D Viewport | Implemented | `components/editor/Viewport.tsx` — R3F, pose application, post-processing, particles |
| Viewport pose-gate rewrite | Implemented | Drops `vmcCompRef`/tracking-lost gates; pose applied whenever `pose != null && Object.keys(pose).length > 0 && fresh`; `blendMode` now selects composition strategy (override = replace anim; additive = `animQ * (restRawQ⁻¹ * posedRawQ)`); ramps over per-avatar `blendTransitionTime` (default 0.5s) |
| PropertiesPanel: blend-time relocation + breathing UI | Implemented | `blendTime` removed from vmc_receiver UI; `blendTransitionTime` lives on the VRM avatar node's `properties`; new `BreathingProps` panel (Chest amplitude + Shoulder lift) |
| PropertiesPanel: avatar default expressions | Implemented | Avatar section drops the inline animation-asset grid (now picked via the bottom-dock Animations tab; Pick… just flashes it); read-only Expressions list becomes a **Default Expression** control (0..1 slider per VRM expression). Weights persist on `node.properties.defaultExpressions` (shared `SceneNodeProperties.defaultExpressions`, only non-zero kept; backend shallow-merge). `Viewport.tsx` applies them as a per-frame baseline under live broadcast blendshapes. See [frontend.md](modules/frontend.md) and [animation.md](modules/animation.md). |
| Scene graph panel | Implemented | `components/editor/SceneGraph.tsx` |
| Properties panel | Implemented | `components/editor/PropertiesPanel.tsx` |
| Material editor (per-avatar MToon ⇄ PBR ⇄ APBR) | Implemented | Per-VRM-node Material section: switch each material between MToon (NPR, ignores env/ambient) and PBR — which has a basic tier (`MeshStandardMaterial`) and an advanced **APBR** tier (`MeshPhysicalMaterial`: specular/clearcoat/sheen/transmission/iridescence/anisotropy lobes), both responding to scene lights + per-camera `envIntensity` (× per-material `envMapIntensity`) — edit params, reset to as-authored. Frontend-only; overrides persist on `node.properties.materialOverrides` (no backend/schema change). Apply layer in `components/editor/materialOverrides.ts` (WeakMap slot registry, lazy-cached PBR + APBR material per slot, MToon-outline collapse in PBR/APBR mode); UI + reusable `CollapsibleSection` primitive in `PropertiesPanel.tsx`; invoked from `Viewport.tsx`. See [material-overrides.md](modules/material-overrides.md). |
| Asset manager | Implemented | `components/editor/AssetManager.tsx` |
| TopBar update UI | Implemented | `components/editor/TopBar.tsx` + `components/editor/UpdateDialog.tsx` — update badge, channel selector, live download progress bar (polls `/update-status` every 500ms), download/apply flow. See [updates.md](modules/updates.md). |
| Signal graph editor | Implemented | `components/editor/signal/SignalGraphCanvas.tsx` |
| WebSocket sync | Implemented | `hooks/useWsSync.ts` — includes server_update handler + pendingReload-on-reconnect |
| Lipsync uplink | Implemented | `hooks/useLipsyncUplink.ts` — mic → WS |
| Lipsync MFCC classifier | Implemented | `media/MicCapture.ts` — in-browser MFCC vowel classification + per-behavior calibration |
| Tracking uplink | Implemented | `hooks/useTrackingUplink.ts` — MediaPipe → WS |
| Track Clips timeline (bottom-dock tab) | Implemented | `'clips'` tab in `AssetManager.tsx` mounts `TrackClipTimeline` (clip list + multi-lane editor with draggable keyframes, draggable `ScrubRuler`, and play / ❚❚ pause / resume / ■ stop transport). `useTrackClipEvaluator` runs in both `Editor.tsx` and `ViewerPage.tsx`; evaluates lanes per rAF for both playing and paused entries (paused entries keep their override at the frozen `t` and don't auto-complete) and writes absolute values into store override slots (`nodeTransformOverrides`, `composeLayerOverrides`). Scene-node consumption is per-component via `useTransformWithOverride` in `Viewport.tsx` (no direct Three.js mutation; re-render scope stays per-node). Compose-layer consumption is per-layer in `ComposeLayerStack.LayerView`. Override vs relative is per-clip; relative is pre-folded into the override so consumers always replace. Properties panel gains ◆ set-keyframe buttons per numeric input (and per group) on scene-node transforms and compose-layer x/y/rotation, gated on `useTrackClipRecorder().canRecord` (bottom dock on `'clips'` AND a clip selected). Bottom-dock active tab is lifted from `AssetManager.tsx` local state into the store as `bottomTab` so the Properties panel can gate on it. See [track-clips.md](modules/track-clips.md). |
| Compose View (left-dock tab + viewport) | Implemented | Second tab in the editor's left dock (`leftTab` in store, disabled until at least one camera node exists). `ComposeTree` shows a Scene section plus one per camera with scene-wide layers pinned as interleaved items. `ComposeView` renders the selected camera POV via R3F with behind-/front-layer DOM stacks. `ComposeLayerStack` is shared with `ViewerPage` (`mode: 'editor' | 'viewer'`) so streamed output matches. Drag/resize/rotate gestures in `composeLayerInteractions.ts` patch the store optimistically and persist on pointerup; resize math is anchor-aware so screen-direction drags always grow/shrink visually. Properties panel gains a layer-properties branch. Limitations: no DnD reorder yet (manual ↑/↓ + numeric inputs), no resolution-independent scaling. See [compose.md](modules/compose.md). |
| i18n + help system | Implemented | All user-facing strings translated to EN + DE via `react-i18next`; locale files auto-discovered by Vite glob (no registration step). `LanguageSwitcher` in TopBar + Home; language persisted to `localStorage`. In-app help: `HelpButton` (`?` affordances across the UI), floating `HelpWindow` (draggable, driven by `helpStore`), `DocViewer` (markdown renderer with stable `{#anchor}` ids via custom `rehypeHeadingIds` plugin), `DocsPage` at `/docs/:topic`. Content in `help/content/{en,de}/*.md`. See [i18n-help.md](modules/i18n-help.md). |

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
| GitHub Actions release workflow | Implemented | `.github/workflows/release.yml` — fires on `pull_request: closed && merged == true` to main. `tag` job reads the merged PR's release label, computes the next semver from the last `v*` tag, pushes the annotated tag. Matrix `release` job builds win-x64 + linux-x64 zips with a bundled Node.js 22.16.0 binary + a supervising start script (`start.sh`/`start.bat`) and publishes to a GitHub Release named after the tag. The start script runs the server in a loop and applies the downloaded update on exit code 42 (the separate `updater.sh`/`updater.bat` scripts were removed); the start-script↔server contract is documented in [updates.md](modules/updates.md). The old `tag.yml`/`release.yml` split was folded into a single workflow because tags pushed via `GITHUB_TOKEN` don't trigger downstream workflows. |
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

Per-behavior templates live in `behaviors.config.vowelTemplates` (the table renamed from `node_components` in migration 022); see [modules/lipsync.md](modules/lipsync.md).

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
REST create/delete → SQLite → sync.document.upsert/remove → WS 'sync' envelope
  → Frontend useWsSync → applyRemote → Zustand store → React UI
REST update        → SQLite → legacy WS kind (node_updated, camera_effect_updated, …)
  → Frontend useWsSync → Zustand store → React UI
```

Create/delete of the migrated document types (`scene_node`, `behavior`, `camera_effect`, `compose_layer`, `track_clip`) flows through the unified sync layer; updates and the live pose pipeline are still on legacy kinds. See [sync.md](modules/sync.md).

## Module Docs

- [signal-graph.md](modules/signal-graph.md) — engine (class-instance/decorator model + edge-time type inference), all 57 node kinds, how to add a new node
- [component-managers.md](modules/component-managers.md) — Behavior managers (VMC, breathing, lipsync, tracking, api_controller); lifecycle pattern. (Doc filename `component-managers.md` kept; managers live in the `behaviors/` source dir.)
- [api-controller.md](modules/api-controller.md) — REST-driven animation/blendshape control surface, the first behavior with public REST endpoints
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
- [project-graphs.md](modules/project-graphs.md) — Logic: user-built standalone signal graphs (project / scene-node / compose-layer scopes), writable canvas, unified lifecycle via `LogicManager`, `fire()` entry for external events. (Filename kept.)
- [presets.md](modules/presets.md) — per-project preset library: serialised scene-node / compose-layer subtrees with nested graphs / clips / camera-effects / animation clips, id placeholders for cross-project portability, paste-onto-bone via `boneAttachment`
- [clipboard.md](modules/clipboard.md) — single discriminated `ClipboardPayload` union (7 kinds) mirrored to OS clipboard + Zustand slice; powers Cmd/Ctrl+C/V across scene nodes, compose layers, logic, in-graph node selections, camera effects, behaviors, and track clips
- [overlive.md](modules/overlive.md) — Twitch + StreamElements integration via the `overlive` SDK; accounts, OAuth, `Account` port type, 13 event nodes
- [data-channels.md](modules/data-channels.md) — generic graph→frontend data-channel bus + `set_data` node + template `feed` compose layer; chat ring-buffer + `overlive_chat_feed` as the first use
- [sync.md](modules/sync.md) — unified state-replication layer: the `SyncEnvelope`, four resource classes, dotted-path addressing, backend producer hub + registry, frontend apply dispatcher + bindings, HLC stale-drop, the compositor read-model, what's migrated vs still on legacy WS kinds, and how to add a syncable resource
- [runtime-overrides.md](modules/runtime-overrides.md) — scene-scoped parallel-to-track-clip override bus for graph-driven runtime param mutation
- [spawn.md](modules/spawn.md) — ephemeral clip-clone spawning; tmp scene-node / compose-layer instances driven by `spawn_clip`
- [paramPaths.md](modules/paramPaths.md) — shared paramPath registry used by clips, runtime overrides, and `set_*_param` nodes
- [material-overrides.md](modules/material-overrides.md) — per-avatar Material Editor: switch each VRM material between MToon, PBR, and APBR (advanced `MeshPhysicalMaterial`), the apply/swap layer, and why MToon vs PBR matters for lighting
- [media.md](modules/media.md) — video + audio assets, `video`/`audio` scene-node kinds, the media-command bus (`MediaControlManager` + `media_control` node), the frontend media registry + `MediaHandle`, the audio listener / audibility model, and the track-clip event/marker lane
- [i18n-help.md](modules/i18n-help.md) — internationalisation (EN/DE via react-i18next, Vite-glob locale discovery, namespace conventions) and the in-app help system (`HelpButton`, `HelpWindow`, `DocViewer`, `DocsPage`, stable cross-locale `{#anchor}` convention)

## Future Features / Planned

- **Live P2P mesh.** Today browser clients connect only to their own backend over WebSocket (star) and backends connect peer-to-peer over WebRTC (`ServerMesh`, multiplayer Phase 5). Planned extension: have *all* participants — browser clients **and** backend servers — join a single full WebRTC mesh and broadcast live state (the unified sync layer's `stream` + `field` classes: pose, blendshapes, IK, transform previews, runtime overrides) directly to every other participant, cutting relay hops/latency. Document-class state stays server-mediated (optimistic-document path is a later slice). The `event` class folds into temporal `field` state — a retained "started at timestamp X" anchor that late joiners render in sync against a per-origin shared clock. Client WebRTC signaling rides the existing backend WS + `ServerMesh`; browsers never get rendezvous credentials. Topology is full-mesh for now, behind an edge-selection policy seam for future interest-pruning. See [plans/live-mesh.md](plans/live-mesh.md) (builds on [plans/unified-sync-layer.md](plans/unified-sync-layer.md) and [plans/multiplayer-phase5.md](plans/multiplayer-phase5.md)).
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
