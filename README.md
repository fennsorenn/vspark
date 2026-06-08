# vspark

**English** | [Deutsch](README.de.md)

Real-time 3D avatar streaming system. Motion capture data (VMC over UDP, MediaPipe from the browser, microphone-driven lipsync) flows into server-side reactive signal graphs and is broadcast to a Three.js/VRM viewport at ~60 Hz.

## Features

### Motion capture inputs
- **VMC protocol** — UDP OSC receiver compatible with VMC, RhyLive, and ARKit blendshape streams.
- **MediaPipe Holistic** — browser-side camera capture in a Web Worker (320×240, 10 FPS) for face, pose, and hand landmarks.
- **Microphone lipsync** — in-browser MFCC vowel classification with per-behavior calibration, driving `Fcl_MTH_*` viseme weights and jaw-open from RMS.

### Avatar & scene
- **VRM avatars** — loads VRM 0.x and 1.x. Sparse bone rotation streaming, blendshape expressions, bone-attachment slots.
- **Scene graph** — project → scene → node hierarchy (VRM, camera, light, group) with transform inheritance, persisted in SQLite.
- **Behaviors** — behavioral drivers attached to nodes: VMC receiver, breathing, manual calibration, lipsync, MediaPipe tracker, API controller. Most are backed by their own signal graph instance.
- **Animation retargeting** — FBX/BVH clip playback retargeted onto VRM rigs (world-space delta retargeting; A-pose support).

### Signal graph
- **Reactive engine** — hybrid push (events) + pull (values) execution with typed ports, value caching, and cycle detection.
- **60 built-in node kinds** including OSC source, bone mappers, body/arm/manual calibration, IK targets, MediaPipe converters, blendshape mux, pose interceptors, runtime-mutation primitives, Overlive (Twitch/StreamElements) event nodes, and broadcast sinks.
- **Visual graph editor** in the frontend for inspecting and wiring behavior and logic graphs.

### Viewport
- React Three Fiber canvas with post-processing pipeline (18 camera effect kinds).
- GPU-instanced particle system and billboard nodes.
- Analytical two-bone IK solver for arms in MediaPipe mode.

### Tooling
- **Asset manager** — upload and organize VRMs, FBX/BVH clips, and other assets per project.
- **Auto-update** — GitHub Releases channel check, download, and apply flow (stable / pre-release).
- **Cross-platform releases** — bundled Node.js 22 runtime, win-x64 and linux-x64 zips built by CI.

## Architecture overview

```
packages/
  backend/    Node.js/Express — signal graph engine, SQLite persistence, motion capture managers
  frontend/   React + React Three Fiber — 3D viewport, node graph editor, Zustand state
  shared/     TypeScript types, Zod schemas, signal graph type definitions
```

See [dev-notes/ARCHITECTURE.md](dev-notes/ARCHITECTURE.md) for module status, data flows, and links to per-module docs.

## Install

### Prebuilt release (recommended)

Prebuilt zips for Windows and Linux are published on the [GitHub Releases](../../releases) page. Each bundle ships with a Node.js 22 runtime, the backend bundle, the frontend assets, and a supervising start script (`start.sh` / `start.bat`) — no Node or pnpm install required.

1. Download `vspark-win-x64.zip` or `vspark-linux-x64.zip` from the latest release.
2. Extract it anywhere; you'll get a `vspark/` folder.
3. Run the start script:
   - Windows: double-click `start.bat`
   - Linux: `./start.sh`
4. Open the editor URL printed in the console (defaults to `http://localhost:3001`).

In-app updates: the editor TopBar checks GitHub Releases on the selected channel (stable / pre-release); the supervising start script applies a downloaded update in place when the server exits with the update sentinel code, then relaunches.

### From source

Use this if you want to develop against vspark or run an unreleased branch.

#### Prerequisites
- **Node.js** 22 LTS or newer (CI builds and the bundled runtime use 22)
- **pnpm** 9+ (`npm install -g pnpm`)
- A modern browser with WebGL2 + getUserMedia (for the editor and lipsync/MediaPipe inputs)

The SQLite layer uses `node-sqlite3-wasm` — no native build tools or Python required.

#### Clone

```bash
git clone https://github.com/<your-org>/vspark.git
cd vspark
pnpm install
```

### Development

Run both packages in parallel:

```bash
pnpm dev
```

Or run them individually:

```bash
pnpm dev:backend   # Express + WS on http://localhost:3001
pnpm dev:frontend  # Vite dev server on http://localhost:5173
```

Open the frontend in a browser. The backend opens its UDP OSC socket on the port configured per VMC behavior.

### Production build

```bash
pnpm build         # type-check + compile backend, build frontend bundle
pnpm bundle        # produce a standalone backend bundle (esbuild)
```

The packaged release (with bundled Node runtime and supervising start scripts) is produced by the GitHub Actions workflow in `.github/workflows/release.yml`.

### Quality checks

```bash
pnpm lint     # TypeScript type-check across all packages
pnpm format   # Prettier write
```

No runtime test suite is configured; `pnpm lint` is the primary correctness check.

## Configuration

- **Database** — SQLite file created on first run; migrations live in [packages/backend/src/db/migrations/](packages/backend/src/db/migrations/).
- **Uploads** — assets are stored under `uploads/` in the working directory.
- **Update channel** — selectable in the editor TopBar; persisted in `config.json`.

## Repository layout

| Path | Purpose |
|------|---------|
| `packages/backend/` | HTTP + WebSocket server, signal graph runtime, motion capture managers, DB |
| `packages/frontend/` | Editor UI, 3D viewport, signal graph canvas |
| `packages/shared/` | Domain types, Zod schemas, signal graph type system |
| `dev-notes/` | Architecture and per-module developer documentation |
| `uploads/` | Asset storage (created at runtime) |
