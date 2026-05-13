# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run from repo root)
pnpm dev              # All packages in parallel
pnpm dev:backend      # Backend only (tsx watch, port 3001)
pnpm dev:frontend     # Frontend only (Vite, port 5173)

# Build
pnpm build            # All packages
pnpm build:backend    # TypeScript compile
pnpm build:frontend   # TypeScript + Vite

# Quality
pnpm lint             # TypeScript type-check all packages
pnpm format           # Prettier format all packages
```

No test runner is configured — type-checking via `pnpm lint` is the primary correctness check.

## Architecture

**vspark** is a 3D avatar/scene streaming system: it receives motion capture data (VMC protocol over UDP), processes it through a reactive signal graph, and streams pose updates to a Three.js viewport where VRM avatars are rendered in real time.

### Monorepo Layout

```
packages/
  backend/    Node.js/Express server — signal graph engine, SQLite persistence, VMC UDP listener
  frontend/   React + React Three Fiber — 3D viewport, node graph editor UI, Zustand state
  shared/     TypeScript types, Zod schemas, signal graph type definitions
```

### Core Abstractions

- **Project** → **Scene** → **Node** (VRM avatar, camera, light, group) — persistent hierarchy in SQLite
- **Component** — behavioral driver attached to a node (e.g. `vmc_receiver`), stored in `node_components`
- **Signal Graph** — reactive execution engine instantiated per component; hybrid push (events) / pull (values) model
- **PoseFrame** — sparse bone rotation payload produced by the graph and broadcast over WebSocket

### Backend Data Flow

1. `node_components` CRUD (via `/api/node-components`) triggers `VmcManager` to instantiate/destroy signal graphs
2. `VmcManager` opens a UDP socket; incoming OSC packets fire into the graph's `vmc_packet_source` node
3. Graph executes through bone mappers → calibration nodes → `pose_broadcast` node
4. `pose_broadcast` emits `vmc_pose` / `vmc_blendshapes` messages over the shared WebSocket

Key backend files:
- [packages/backend/src/index.ts](packages/backend/src/index.ts) — entry point, HTTP + WebSocket setup
- [packages/backend/src/routes/api.ts](packages/backend/src/routes/api.ts) — all REST routes
- [packages/backend/src/signal/engine.ts](packages/backend/src/signal/engine.ts) — graph runtime (typed ports, value cache, cycle detection)
- [packages/backend/src/signal/registry.ts](packages/backend/src/signal/registry.ts) — registered signal node kinds
- [packages/backend/src/vmc/manager.ts](packages/backend/src/vmc/manager.ts) — VMC component lifecycle

### Frontend Data Flow

1. `Editor.tsx` loads project/scene/nodes from REST API → populates Zustand store (`editorStore.ts`)
2. `useWsSync()` maintains WebSocket connection and writes incoming `vmc_pose` / `vmc_blendshapes` into the store
3. `Viewport.tsx` renders a React Three Fiber canvas; `Avatar.tsx` reads pose from the store and applies it to the loaded VRM

Key frontend files:
- [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx) — router (Home `/` + Editor `/:projectId`)
- [packages/frontend/src/store/editorStore.ts](packages/frontend/src/store/editorStore.ts) — Zustand store (scene graph, VRM skeletons, VMC state)
- [packages/frontend/src/components/editor/Viewport.tsx](packages/frontend/src/components/editor/Viewport.tsx) — Three.js canvas
- [packages/frontend/src/components/editor/Avatar.tsx](packages/frontend/src/components/editor/Avatar.tsx) — VRM loader + pose application
- [packages/frontend/src/hooks/useWsSync.ts](packages/frontend/src/hooks/useWsSync.ts) — WebSocket sync with auto-reconnect

### Signal Graph

Defined entirely in [packages/shared/src/signal.ts](packages/shared/src/signal.ts). Node classes are registered in the backend registry and serialized as `GraphDescriptor` objects. The 13 built-in node kinds live under [packages/backend/src/signal/nodes/](packages/backend/src/signal/nodes/).

The VMC pipeline graph shape is hardcoded in [packages/backend/src/vmc/vmc_graph.ts](packages/backend/src/vmc/vmc_graph.ts) — it wires source → mapper → calibration → broadcast nodes.

### Database

better-sqlite3 (synchronous). Migrations in [packages/backend/src/db/migrations/](packages/backend/src/db/migrations/). All tables are project-scoped with strict foreign key constraints. Key tables: `projects`, `scenes`, `scene_nodes`, `node_components`, `asset_files`, `animation_clips`.

### Shared Types

- [packages/shared/src/types.ts](packages/shared/src/types.ts) — `Node`, `Scene`, `Project`, `Component`, `AnimationState`
- [packages/shared/src/schema.ts](packages/shared/src/schema.ts) — Zod request validation schemas
- [packages/shared/src/signal.ts](packages/shared/src/signal.ts) — `Quaternion`, `BoneRotations`, `VRM_BONE_NAMES`, `SignalNodeClass`, graph type system
