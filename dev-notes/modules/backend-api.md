# Backend API

Entry point: `packages/backend/src/index.ts`  
Routes: `packages/backend/src/routes/api.ts` (mounted at `/api`)  
WebSocket: `packages/backend/src/ws/index.ts`

## Server startup sequence (`index.ts`)

1. Run DB migrations
2. Instantiate managers (VmcManager, BreathingManager, LipsyncManager, TrackingManager)
3. Inject managers into route module via setters
4. Load all persisted `node_components` rows from DB and call `syncComponents()` on each manager
5. Bind WebSocket upgrade handler
6. Start HTTP server on port 3001

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

## Database — `db/`

better-sqlite3, WAL mode, foreign keys ON. All queries are synchronous.

**Migrations** run in order on startup from `db/migrations/`:

| File | What it adds |
|------|--------------|
| `001_initial.sql` | Core tables: projects, scenes, scene_nodes, asset_files, animation_clips, and several legacy tables |
| `002_node_components.sql` | `node_components` table (replaces inline JSON components on nodes) |
| `003_camera_effects.sql` | `camera_effects` table |
| `004_bone_attachment.sql` | `scene_nodes.bone_attachment` column (VRM bone name) |
| `005_node_hidden.sql` | `scene_nodes.hidden` column |

All tables carry `project_id` FK for strict workspace isolation. The `node_components.config` column stores component config JSON including the `_nodeState` sub-key for graph persistence.
