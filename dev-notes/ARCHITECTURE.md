# vspark — Architecture

Real-time 3D avatar streaming system. VMC motion capture data flows into a server-side reactive signal graph, which broadcasts pose updates to a Three.js/VRM viewport in the browser.

## Monorepo Layout

```
packages/
  backend/    Node.js/Express — signal graph engine, SQLite persistence, VMC UDP listener
  frontend/   React + React Three Fiber — 3D viewport, node graph editor, Zustand state
  shared/     TypeScript types, Zod schemas, signal graph type definitions
```

## Core Abstractions

| Concept | Description |
|---------|-------------|
| Project | Top-level workspace. All entities are strictly project-scoped. |
| Scene | Spatial container. Hierarchical via mount nodes. |
| Node | Spatial entity (VRM, camera, light, group). Unique ID, transform inheritance. |
| Component | Behavioral driver attached to a node (e.g. VMC receiver). Backed by a signal graph. |
| Signal Graph | Reactive execution engine: push-based events + pull-based values. |
| PoseFrame | Sparse bone rotation payload broadcast over WebSocket at high frequency. |

## Module Status

### Backend — `packages/backend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| HTTP + WebSocket server | Implemented | `index.ts` — Express + ws |
| REST API | Implemented | `routes/api.ts` — full CRUD for projects/scenes/nodes/components/assets |
| SQLite persistence | Implemented | `db/` — better-sqlite3, 5 migrations |
| Signal graph engine | Implemented | `signal/engine.ts` — typed ports, value cache, cycle detection |
| Signal node registry | Implemented | `signal/registry.ts` — 26 node kinds registered |
| Node component lifecycle | Implemented | `node_components/` — instantiates/destroys graphs on CRUD |
| VRM asset handling | Implemented | `vrm/` — skeleton extraction on upload |
| WebSocket sync | Implemented | `ws/` — scene patches, pose broadcast |

Signal node kinds (all implemented):
- Sources: `vmc_packet_source`, `mediapipe_source`, `lipsync_source`, `manual_trigger`, `clock`, `time`, `sine_wave`
- Mappers: `rhylive_bone_mapper`, `arkit_vrm_mapper`, `pose_landmarks_to_bones`, `hand_landmarks_to_bones`, `face_landmarks_to_blendshapes`
- Processing: `body_calibration`, `arm_ik_calibration`, `blendshapes_sum`, `euler_to_quaternion`, `unpack_event`, `pose_apply_bone`
- Effects: `pose_broadcast`, `blendshapes_broadcast`, `pose_interceptor_broadcast`, `on_pose_broadcast`
- Config/utility: `component_config`, `component_id`, `scene_entity`, `viseme_passthrough`

VMC pipeline graph shape is hardcoded in `signal/` — wires source → mapper → calibration → broadcast.

### Frontend — `packages/frontend/src/`

| Module | Status | Notes |
|--------|--------|-------|
| Router + App shell | Implemented | `App.tsx` — Home `/` + Editor `/:projectId` |
| Zustand store | Implemented | `store/editorStore.ts` — scene graph, VRM skeletons, VMC state |
| Viewport | Implemented | `components/editor/Viewport.tsx` — R3F canvas, post-processing |
| Avatar | Implemented | `components/editor/Avatar.tsx` — VRM loader + pose application |
| Scene graph panel | Implemented | `components/editor/SceneGraph.tsx` |
| Properties panel | Implemented | `components/editor/PropertiesPanel.tsx` |
| Asset manager | Implemented | `components/editor/AssetManager.tsx` |
| Signal graph editor | Implemented | `components/editor/signal/SignalGraphCanvas.tsx` |
| WebSocket sync | Implemented | `hooks/useWsSync.ts` — auto-reconnect |
| Lipsync uplink | Implemented | `hooks/useLipsyncUplink.ts` |
| Tracking uplink | Implemented | `hooks/useTrackingUplink.ts` — MediaPipe face/pose/hand |

### Shared — `packages/shared/src/`

| Module | Status |
|--------|--------|
| Core types | Implemented — `types.ts` |
| Zod schemas | Implemented — `schema.ts` |
| Signal graph types | Implemented — `signal.ts` (VRM_BONE_NAMES, SignalNodeClass, GraphDescriptor) |

## Data Flow

### VMC Pose

1. UDP OSC packets → `vmc_packet_source` node
2. Graph executes: mapper → calibration → `pose_broadcast`
3. `pose_broadcast` emits `vmc_pose` / `vmc_blendshapes` over WebSocket
4. Frontend `useWsSync` writes into Zustand store
5. `Avatar.tsx` reads pose from store and applies to VRM bones each frame

### Scene State

1. REST mutations → SQLite write → scene clock increment → WebSocket fan-out (JSON Patch)
2. `Editor.tsx` loads initial state from REST, then applies patches from WebSocket

## Database

better-sqlite3 (synchronous). Migrations in `packages/backend/src/db/migrations/`.

Key tables: `projects`, `scenes`, `scene_nodes`, `node_components`, `asset_files`, `animation_clips`  
All tables carry `project_id` FK for strict workspace isolation.

## Key Files

- [packages/backend/src/index.ts](../packages/backend/src/index.ts) — entry point
- [packages/backend/src/routes/api.ts](../packages/backend/src/routes/api.ts) — all REST routes
- [packages/backend/src/signal/engine.ts](../packages/backend/src/signal/engine.ts) — graph runtime
- [packages/backend/src/signal/registry.ts](../packages/backend/src/signal/registry.ts) — node registry
- [packages/frontend/src/store/editorStore.ts](../packages/frontend/src/store/editorStore.ts) — Zustand store
- [packages/frontend/src/components/editor/Viewport.tsx](../packages/frontend/src/components/editor/Viewport.tsx) — Three.js canvas
- [packages/frontend/src/components/editor/Avatar.tsx](../packages/frontend/src/components/editor/Avatar.tsx) — VRM loader + pose
- [packages/frontend/src/hooks/useWsSync.ts](../packages/frontend/src/hooks/useWsSync.ts) — WebSocket sync
- [packages/shared/src/signal.ts](../packages/shared/src/signal.ts) — signal graph type system
