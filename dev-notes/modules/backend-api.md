# Backend API

Entry point: `packages/backend/src/index.ts`
Routes: `packages/backend/src/routes/` — per-resource sub-routers composed via [routes/index.ts](../../packages/backend/src/routes/index.ts), mounted at `/api`
OpenAPI: Swagger UI at `/api-docs`, raw spec at `/api-docs.json` (see [OpenAPI docs](#openapi-docs--routesopenapits))
WebSocket: `packages/backend/src/ws/index.ts`

## Server startup sequence (`index.ts`)

1. `await initDb()` — load WASM module, open DB, run migrations
2. `initUpdateChecker(installDir, wsSync)` — async GitHub Releases check on boot
3. Instantiate managers (VmcManager, BreathingManager, LipsyncManager, TrackingManager, ApiControllerManager)
4. Inject managers into route module via setters (re-exported from `routes/index.ts`, defined in `routes/shared.ts`)
5. Mount Swagger UI at `/api-docs` and serve the raw spec at `/api-docs.json`
6. Load all persisted `behaviors` rows (table renamed from `node_components` in migration 022) from DB and call `syncBehaviors()` on each manager
7. Bind WebSocket upgrade handler; on connect, ApiController re-emits its current state via `rebroadcastTo()`
8. Start HTTP server on port 3001

**WebSocket message handlers** (registered on connect):
- `lipsync_input` → `LipsyncManager.fireVisemes(behaviorId, visemes)`
- `tracking_input` → `TrackingManager.fireLandmarks(behaviorId, frame)`
- `avatar_expressions_report` → `ApiControllerManager.setExpressionsForNode(nodeId, expressions)` — frontend tells the backend which VRM expressions exist on a freshly loaded avatar

## REST routes — `routes/` (per-resource split)

Response shape: `{ ok: true, data: ... }` or `{ ok: false, error: { status, message, code } }`. Older routes still return a plain string error; new routes (api_controller, expressions) use the structured `Error` envelope.

### File layout

| File | Covers |
|------|--------|
| [routes/index.ts](../../packages/backend/src/routes/index.ts) | Composes sub-routers, re-exports manager/ws setters from `shared.ts` |
| [routes/shared.ts](../../packages/backend/src/routes/shared.ts) | Manager singletons + setters, `refresh*` helpers (DB → `syncBehaviors`), uploads dir + extension/MIME tables, `discoverAssets`, `_resolveApiController` |
| [routes/projects.ts](../../packages/backend/src/routes/projects.ts) | `/projects` CRUD |
| [routes/scenes.ts](../../packages/backend/src/routes/scenes.ts) | `/projects/:projectId/scenes`, `/scenes/:sceneId` |
| [routes/scene-nodes.ts](../../packages/backend/src/routes/scene-nodes.ts) | `/scenes/:sceneId/nodes`, `/scene-nodes/:nodeId`, animation-clip CRUD |
| [routes/assets.ts](../../packages/backend/src/routes/assets.ts) | Project asset upload + listing (runs `discoverAssets()` on GET) |
| [routes/behaviors.ts](../../packages/backend/src/routes/behaviors.ts) | Behavior CRUD (`/api/scene-nodes/:id/behaviors`, `/api/behaviors/:id`) — each mutation calls `refreshAllBehaviorManagers()`. |
| [routes/api-controller.ts](../../packages/backend/src/routes/api-controller.ts) | REST surface of the api_controller behavior (see below) |
| [routes/expressions.ts](../../packages/backend/src/routes/expressions.ts) | Read-only listings: VRM expressions + animation clips for an avatar node |
| [routes/camera-effects.ts](../../packages/backend/src/routes/camera-effects.ts) | `/scene-nodes/:nodeId/effects`, `/effects/:id` — WS `camera_effect_*` broadcasts |
| [routes/signal.ts](../../packages/backend/src/routes/signal.ts) | Signal graph inspection + `POST /signal/graphs/:graphId/fire` (dispatches by graph-id prefix to VMC or tracking) |
| [routes/logic.ts](../../packages/backend/src/routes/logic.ts) | Logic over the unified `logic` table (renamed from `graphs` via migrations 022 → 025) — project, scene-node, and compose-layer GET/POST plus `PUT /logic/:id` and `DELETE /logic/:id`. Rows route through `LogicManager`. See [project-graphs.md](project-graphs.md). |
| [routes/meta.ts](../../packages/backend/src/routes/meta.ts) | `/signal/node-kinds`, `/behavior-kinds`, `/system/local-ips` |
| [routes/openapi.ts](../../packages/backend/src/routes/openapi.ts) | OpenAPI base spec + Zod→OpenAPI component-schema build |

Sub-routers are composed with `router.use(subRouter)` in `routes/index.ts` (no path prefix — each sub-router declares its full path).

### Route catalogue

For the canonical, always-current request/response contracts of every route, browse Swagger UI at `http://localhost:3001/api-docs`. The notes below cover only behaviour that is not visible from the schema alone.

- **behaviors** (behavior routes): every mutation calls `refreshAllBehaviorManagers()` so manager state hot-reloads from DB.
- **scene-nodes**: `POST /scenes/:sceneId/nodes` and `DELETE /scene-nodes/:nodeId` now broadcast **through the sync layer** (`sync.document.upsert/remove` for rtype `scene_node`, wire kind `'sync'`) rather than bespoke `node_added`/`node_removed` kinds; updates still broadcast the legacy `node_updated`. `POST /scene-nodes/:nodeId/clips` is an idempotent upsert keyed on `(source_file_path, clip_index)` — the frontend's Viewport calls it on VRM load to register real FBX clip durations.
- **assets**: GET also runs `discoverAssets()`; files live under `uploads/{projectId}/{subdir}/` with subdir inferred from extension (avatars, animations, images, other). See `routes/shared.ts` for `SUBFOLDER_BY_EXT` / `MIME_BY_EXT` / `allocateFilename`.
- **camera-effects**: create/delete now flow through the sync layer (`sync.document.upsert/remove`, rtype `camera_effect`, wire kind `'sync'`); updates still broadcast the legacy `camera_effect_updated`.
- **signal**: `graphId` format is `<prefix>:<behaviorId>` (e.g. `vmc-pipeline:abc123`); `routes/signal.ts` dispatches by prefix to the right manager's `fireGraphEvent`.
- **api-controller**: see the section below — first behavior with a public REST control surface.
- **expressions**: read-only — `GET .../expressions` returns the VRM expression list reported by the frontend on VRM load (with `reported: false` until the frontend has loaded the avatar at least once); `GET .../animations` lists registered animation clips with playback metadata.

### api_controller REST surface — `routes/api-controller.ts`

All routes are project-scoped via `/projects/:projectId/nodes/:nodeId/...`; `_resolveApiController` in `routes/shared.ts` confirms node ownership and resolves the active `behaviorId` (404 if no behavior is attached, 503 if the manager hasn't been wired yet).

| Method + path | Behaviour |
|---|---|
| `GET .../api-controller/state` | Returns `{ queue, loopMode, startedAt, blendshapes }` from `ApiControllerManager.getState()` |
| `PUT .../api-controller/animation` | One-shot: replaces the queue with one entry, forces `loopMode = 'last'` |
| `PUT .../api-controller/animation-queue` | Replaces the queue with an ordered list, accepts `loopMode: 'none' | 'last' | 'queue'` |
| `PUT .../api-controller/blendshapes` | Either `{ preset: '<name>' }` (single shape at weight 1.0) or `{ blendshapes: { name: weight, ... } }` |
| `DELETE .../api-controller/blendshapes` | Clears all active weights |

Clip resolution (in [api_controller/manager.ts:169](../../packages/backend/src/behaviors/api_controller/manager.ts)) tries clip id first then clip name, both scoped to the avatar's `source_node_id`, so the queue can only reference clips owned by this avatar. See [api-controller.md](api-controller.md).

## OpenAPI docs — `routes/openapi.ts`

`swagger-jsdoc` scans every `./src/routes/*.ts` for `@openapi` JSDoc blocks and merges them with the base spec in [openapi.ts](../../packages/backend/src/routes/openapi.ts). The base spec declares tags, servers, and `components.schemas`.

**Component schemas are generated from Zod**, not hand-written. Each schema in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) is tagged `.openapi('Name')` via `@asteasolutions/zod-to-openapi`; `buildZodComponentSchemas()` registers them in an `OpenAPIRegistry` and calls `OpenApiGeneratorV3.generateComponents()`. Routes reference these by name via `$ref: '#/components/schemas/<Name>'`. This means validation and docs cannot drift.

**Endpoints**:
- `GET /api-docs` — Swagger UI (interactive)
- `GET /api-docs.json` — raw OpenAPI 3.0 JSON spec

**Adding docs for a new route**:
1. Add an `@openapi` JSDoc block above the handler, with `tags`, `summary`, `parameters`, `requestBody`, `responses`.
2. If you need a new request/response body schema, add it to `packages/shared/src/schema.ts` with `.openapi('Name')`, and register it in the `named` array in `routes/openapi.ts`.
3. The named tags themselves are declared in the `tags:` array of the base spec — add a new tag there if you don't fit any existing one.

`z.prettifyError(parsed.error)` is used in v4-style validation handlers (api-controller routes) for human-readable messages.

## WebSocket — `ws/index.ts`

`WSSync` is a thin broadcast bus. No routing — all connected clients receive all broadcasts.

```ts
wsSync.broadcast(kind, payload, excludeWs?)  // multicast
wsSync.sendTo(ws, kind, payload)             // unicast
```

Message wire format: `{ kind, payload, timestamp }`.

Client connection: HTTP upgrade on any path → `wsSync.upgrade(req, socket, head)` → `onClientConnected` fires → server sends initial snapshot.

Most CRUD broadcasts no longer use one bespoke kind per entity: create/delete of `scene_node` / `behavior` / `camera_effect` / `compose_layer` / `track_clip` (and preset instantiation) ride a single `'sync'` message carrying a `SyncEnvelope`, produced via the `sync` hub (`sync/index.ts`) rather than direct `wsSync.broadcast`. Update broadcasts and the live pose pipeline still use legacy kinds. See [sync.md](sync.md).

## Update routes — `routes/update.ts` + `routes/config.ts`

### `routes/update.ts`

Mounted at `/api` alongside the main API router (`apiRoutes` from `routes/index.ts`). Startup calls `initUpdateChecker(installDir, wsSync)` once on boot to check GitHub Releases.

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
| `002_node_components.sql` | `node_components` table (replaces inline JSON components on nodes); renamed to `behaviors` in migration 022. Filename kept (historical CREATE). |
| `003_camera_effects.sql` | `camera_effects` table |
| `004_bone_attachment.sql` | `scene_nodes.bone_attachment` column (VRM bone name) |
| `005_node_hidden.sql` | `scene_nodes.hidden` column |
| `007_scene_node_properties.sql` | `scene_nodes.properties` JSON column — per-node properties bag; first use `blendTransitionTime` on VRM avatar nodes. `PUT /scene-nodes/:nodeId` shallow-merges incoming `properties` (mirrors the scene `runtime_settings` pattern); `POST` accepts the bag at insert time. |
| `022_rename_tables_to_vocab.sql` | Vocabulary rename: `ALTER TABLE node_components RENAME TO behaviors` and `ALTER TABLE graphs RENAME TO automations` (FK constraints carried across; no data change). Historical CREATE migrations 002/014 left untouched. |
| `023_rename_behavior_context_kinds.ts` | Vocabulary rename (run-fn, idempotent): rewrites stored descriptors in `logic.descriptor` + `presets.payload` — node kinds `component_id`→`behavior_id` / `component_config`→`behavior_config`, the broadcast-node port `componentId`→`behaviorId` (edge ports + value-input fallback config key), and `_componentConfig`→`_behaviorConfig`. Walks every `{nodes,edges}` descriptor at any nesting depth. |
| `024_rename_preset_graphs_key.ts` | Vocabulary rename (run-fn, idempotent): rewrites the top-level `graphs` key -> `automations` in existing `presets.payload` rows (nested standalone graphs in a preset are automations; later renamed to `logic` by 026). |
| `025_rename_automations_table_to_logic.sql` | Vocabulary rename: `ALTER TABLE automations RENAME TO logic` (the standalone-graph feature became "Logic"). Data-preserving; chain on existing DBs is graphs (014) → automations (022) → logic (025). |
| `026_rename_preset_logic_key.ts` | Vocabulary rename (run-fn, idempotent): rewrites the top-level preset payload key `automations` -> `logic`. |

All tables carry `project_id` FK for strict workspace isolation. The `behaviors.config` column (table renamed from `node_components` in migration 022) stores behavior config JSON including the `_nodeState` sub-key for graph persistence.

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
