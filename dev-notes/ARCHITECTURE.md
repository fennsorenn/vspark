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
| Scene | Spatial container. Hierarchical via mount nodes. |
| Node | Spatial entity (VRM, camera, light, group, etc.). Unique ID, transform inheritance. |
| Component | Behavioral driver attached to a node (VMC receiver, breathing, lipsync, tracking). Backed by a signal graph. |
| Signal Graph | Reactive execution engine: push-based events + pull-based values. One graph per component instance. |
| PoseFrame | Sparse bone rotation payload broadcast over WebSocket at ~60Hz. |

## Module Status

### Backend — `packages/backend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| HTTP + WebSocket server | Implemented | `index.ts` |
| REST API | Implemented | `routes/api.ts` — projects, scenes, nodes, components, assets, effects, signal |
| SQLite persistence | Implemented | `db/` — better-sqlite3, 5 migrations |
| Signal graph engine | Implemented | `signal/engine.ts` — typed ports, value cache, cycle detection |
| Signal node registry | Implemented | `signal/registry.ts` — 26 node kinds |
| VMC receiver manager | Implemented | `node_components/vmc_receiver/` |
| Breathing manager | Implemented | `node_components/breathing/` |
| Lipsync manager | Implemented | `node_components/lipsync/` |
| MediaPipe tracking manager | Implemented | `node_components/mediapipe_tracker/` |
| VRM skeleton parsing | Implemented | `vrm/skeleton.ts` — GLB/VRM 0.x + 1.x |
| WebSocket sync | Implemented | `ws/index.ts` — broadcast bus |

### Frontend — `packages/frontend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| Router + App shell | Implemented | `App.tsx` — 4 routes |
| Zustand store | Implemented | `store/editorStore.ts` |
| 3D Viewport | Implemented | `components/editor/Viewport.tsx` — R3F, pose application, post-processing, particles |
| Scene graph panel | Implemented | `components/editor/SceneGraph.tsx` |
| Properties panel | Implemented | `components/editor/PropertiesPanel.tsx` |
| Asset manager | Implemented | `components/editor/AssetManager.tsx` |
| Signal graph editor | Implemented | `components/editor/signal/SignalGraphCanvas.tsx` |
| WebSocket sync | Implemented | `hooks/useWsSync.ts` — auto-reconnect |
| Lipsync uplink | Implemented | `hooks/useLipsyncUplink.ts` — mic → WS |
| Tracking uplink | Implemented | `hooks/useTrackingUplink.ts` — MediaPipe → WS |

### Shared — `packages/shared/src/`

| Module | Status |
|--------|--------|
| Domain types | Implemented — `types.ts` |
| Zod request schemas | Implemented — `schema.ts` |
| Signal graph types | Implemented — `signal.ts` (Quaternion, NormalizedPose, VRM_BONE_NAMES, SignalNodeClass, GraphDescriptor) |

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
Browser mic → FFT analysis → useLipsyncUplink (30fps)
  → WS lipsync_input
  → LipsyncManager.fireVisemes() → lipsync_source
  → unpack_event → viseme_passthrough → blendshapes_broadcast
  → WS vmc_blendshapes → Frontend → VRM expressions
```

### MediaPipe tracking

```
Browser camera → MediaPipe Holistic → useTrackingUplink
  → WS tracking_input
  → TrackingManager.fireLandmarks() → mediapipe_source
  → face_landmarks_to_blendshapes → blendshapes_broadcast
  → pose/hand_landmarks_to_bones → pose_broadcast
  → WS vmc_pose / vmc_blendshapes → Frontend → VRM
```

### Scene state mutations

```
REST write → SQLite → WS broadcast (node_added/updated/removed, camera_effect_*)
  → Frontend useWsSync → Zustand store → React UI
```

## Module Docs

- [signal-graph.md](modules/signal-graph.md) — engine, all 26 node kinds, how to add a new node
- [component-managers.md](modules/component-managers.md) — VMC, breathing, lipsync, tracking managers; lifecycle pattern
- [backend-api.md](modules/backend-api.md) — REST routes, WebSocket, DB migrations
- [frontend.md](modules/frontend.md) — Zustand store, Viewport, editor panels, hooks
- [shared-types.md](modules/shared-types.md) — domain types, Quaternion/NormalizedPose/Blendshapes, port system
- [scene-graph.md](modules/scene-graph.md) — node hierarchy, DB model, Viewport rendering, bone attachment, reparenting
- [asset-management.md](modules/asset-management.md) — file upload, storage layout, discovery, scene placement
- [camera-effects.md](modules/camera-effects.md) — post-processing pipeline, all 18 effect kinds, config schemas
- [animation.md](modules/animation.md) — FBX/BVH retargeting, VMC pose application, blendshape mapping, clip playback, all coordinate corrections
- [nodes/particle.md](modules/nodes/particle.md) — GPU-instanced particle system, billboard node, shader, physics simulation, camera alignment

## Key Files

- [packages/backend/src/index.ts](../packages/backend/src/index.ts) — server entry, manager init, WS message dispatch
- [packages/backend/src/routes/api.ts](../packages/backend/src/routes/api.ts) — all REST routes
- [packages/backend/src/signal/engine.ts](../packages/backend/src/signal/engine.ts) — graph runtime
- [packages/backend/src/signal/registry.ts](../packages/backend/src/signal/registry.ts) — node kind registry
- [packages/frontend/src/store/editorStore.ts](../packages/frontend/src/store/editorStore.ts) — Zustand store
- [packages/frontend/src/components/editor/Viewport.tsx](../packages/frontend/src/components/editor/Viewport.tsx) — Three.js canvas + pose application
- [packages/frontend/src/hooks/useWsSync.ts](../packages/frontend/src/hooks/useWsSync.ts) — WebSocket client
- [packages/shared/src/signal.ts](../packages/shared/src/signal.ts) — signal graph type system
