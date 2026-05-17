# Backend API

Entry point: `packages/backend/src/index.ts`  
Routes: `packages/backend/src/routes/api.ts` (mounted at `/api`)  
WebSocket: `packages/backend/src/ws/index.ts`

## Server startup sequence (`index.ts`)

1. `await initDb()` — load WASM module, open DB, run migrations
2. `initUpdateChecker(installDir, wsSync)` — async GitHub Releases check on boot
3. Instantiate managers (VmcManager, BreathingManager, LipsyncManager, TrackingManager)
4. Inject managers into route module via setters
5. Load all persisted `node_components` rows from DB and call `syncComponents()` on each manager
6. Bind WebSocket upgrade handler
7. Start HTTP server on port 3001

**WebSocket message handlers** (registered on connect):
- `lipsync_input` → `LipsyncManager.fireVisemes(componentId, visemes)`
- `tracking_input` → `TrackingManager.fireLandmarks(componentId, frame)`

## REST routes (`routes/api.ts`)

Response shape: `{ ok: true, data: ... }` or `{ ok: false, error: string }`.

### Projects
```
GET    /projects
POST   /projects            body: { name, description }
PUT    /projects/:id        body: { name?, description? }
DELETE /projects/:id
```

### Scenes & Nodes
```
GET    /projects/:projectId/scenes
POST   /projects/:projectId/scenes          body: { name }
DELETE /scenes/:sceneId

GET    /scenes/:sceneId/nodes
POST   /scenes/:sceneId/nodes               body: SceneNode shape
PUT    /scene-nodes/:nodeId                 body: partial SceneNode
DELETE /scene-nodes/:nodeId
```
`POST /scenes/:sceneId/nodes` broadcasts `node_added` to all WS clients.

### Assets
```
GET    /projects/:projectId/assets          (also runs discoverAssets() on each call)
POST   /projects/:projectId/assets          body: { name, data (base64), mimeType }
DELETE /assets/:assetId
```
Files are stored under `uploads/{projectId}/{subdir}/`. Subdir is inferred from extension (avatars, animations, images, other). Filenames are sanitized and deduplicated with `allocateFilename()`.

### Animation Clips
```
GET    /scene-nodes/:nodeId/clips
POST   /scene-nodes/:nodeId/clips           body: AnimationClip shape
PUT    /clips/:clipId
DELETE /clips/:clipId
```

### Node Components
```
GET    /scene-nodes/:nodeId/components
POST   /scene-nodes/:nodeId/components      body: { kind, config }
PUT    /components/:id                      body: { config?, enabled? }
DELETE /components/:id
```
Every mutation calls all four managers' `syncComponents()` to hot-reload the runtime. Config is stored as a JSON string; `_nodeState` sub-key is managed by the graph.

### Camera Effects
```
GET    /scene-nodes/:nodeId/effects
POST   /scene-nodes/:nodeId/effects         body: { kind, config }
PUT    /effects/:id                         body: { config?, enabled? }
DELETE /effects/:id
```
Mutations broadcast `camera_effect_added/updated/removed` over WebSocket.

### Signal Graph inspection
```
GET    /signal/graphs                       list active graph descriptors
GET    /signal/graphs/:graphId/node-states  live port values snapshot
POST   /signal/graphs/:graphId/fire         body: { nodeId, port } — manual trigger
```
`graphId` format: `<prefix>:<componentId>` (e.g., `vmc-pipeline:abc123`). The API strips the prefix to find the right manager.

### Metadata
```
GET    /signal/node-kinds                   all registered node kinds with port/display info
GET    /component-kinds                     all registered component kinds
GET    /system/local-ips                    local IPv4 addresses for client discovery
```

## WebSocket — `ws/index.ts`

`WSSync` is a thin broadcast bus. No routing — all connected clients receive all broadcasts.

```ts
wsSync.broadcast(kind, payload, excludeWs?)  // multicast
wsSync.sendTo(ws, kind, payload)             // unicast
```

Message wire format: `{ kind, payload, timestamp }`.

Client connection: HTTP upgrade on any path → `wsSync.upgrade(req, socket, head)` → `onClientConnected` fires → server sends initial snapshot.

## Update routes — `routes/update.ts` + `routes/config.ts`

### `routes/update.ts`

Mounted alongside `api.ts`. Startup calls `initUpdateChecker(installDir, wsSync)` once on boot to check GitHub Releases.

```
GET  /api/update-status         returns { version, latestVersion, releaseNotes, channel, downloadReady }
POST /api/update/download        streams GitHub Release asset zip to a temp dir in the background
POST /api/update/apply           broadcasts server_update WS message, spawns updater script (PID + zip path + install dir), then exits
```

**Channel filtering** (against GitHub Releases API):
- `stable` — non-prerelease tags matching `v*.*.*`
- `recent` (beta) — `-beta.*` tags; falls back to stable if none found
- `experimental` — any release

Uses built-in `https` with redirect following for download. Inline semver compare; no external dependency.

### `routes/config.ts`

```
GET /api/config       reads config.json next to the executable (or process.cwd() in dev)
PUT /api/config       writes config.json; channel change triggers checkForUpdates()
```

`config.json` shape matches `AppConfig` from `packages/shared/src/types.ts`.

## Database — `db/`

**Driver**: `node-sqlite3-wasm` — WASM build, no native addon, platform-independent. Replaced `better-sqlite3`.

**`WasmDb` adapter** (`db/index.ts`): wraps the `node-sqlite3-wasm` `Database`/`Statement` API to expose the same `prepare().get/all/run(...)` spread-param surface as `better-sqlite3`. Zero call-site changes were needed across the rest of the backend.

**`initDb()` is async** — the WASM module must load before the first query. Server startup `await`s it before running migrations or instantiating managers.

**Differences from previous better-sqlite3 setup**:
- WAL pragma is omitted (VFS limitation with journal sidecar files in the WASM build).
- Foreign keys are enabled by default in `node-sqlite3-wasm`; no explicit PRAGMA needed.

**Migrations** run in order on startup from `db/migrations/`:

| File | What it adds |
|------|--------------|
| `001_initial.sql` | Core tables: projects, scenes, scene_nodes, asset_files, animation_clips, and several legacy tables |
| `002_node_components.sql` | `node_components` table (replaces inline JSON components on nodes) |
| `003_camera_effects.sql` | `camera_effects` table |
| `004_bone_attachment.sql` | `scene_nodes.bone_attachment` column (VRM bone name) |
| `005_node_hidden.sql` | `scene_nodes.hidden` column |

All tables carry `project_id` FK for strict workspace isolation. The `node_components.config` column stores component config JSON including the `_nodeState` sub-key for graph persistence.

## Release packaging — `.github/workflows/release.yml`

Matrix build: `windows-latest` (win-x64) and `ubuntu-latest` (linux-x64). Each job:

1. Build frontend + backend (`pnpm build`)
2. Download Node.js 20 LTS binary
3. Write platform-specific launch scripts: `start.bat`/`start.sh` and `updater.bat`/`updater.sh`
4. Zip everything into `vspark-{platform}.zip`
5. Publish to GitHub Release via `softprops/action-gh-release@v2`

Pre-release flag is set automatically for tags containing `-` (e.g. `-beta.1`). Release notes are auto-generated by GitHub.

**Release zip structure** (`vspark/`):
```
bundle.cjs
node-sqlite3-wasm.wasm
public/
node.exe          (Windows) or node (Linux)
start.bat         (Windows) or start.sh (Linux)
updater.bat       (Windows) or updater.sh (Linux)
version.json
```

The updater script receives the server PID, zip path, and install dir as arguments; it waits for the server to exit, unpacks the zip over the install dir, and relaunches.
