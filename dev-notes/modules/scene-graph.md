# Scene Graph

The hierarchy of spatial nodes in a scene. Covers both the DB/API layer and the frontend tree UI.

## Data model

### Scenes-as-nodes (migration 018)

Migration 018 (`refactor_scenes_to_nodes`) collapsed the standalone `scenes` table into `scene_nodes` itself: a scene is now a `scene_nodes` row with `kind = 'scene'`. Scene ids are **reused** as the kind=scene node ids so existing FKs stay valid. The migration also:

- Added `project_id` to `scene_nodes` (backfilled from the old `scenes.project_id` join).
- Renamed `scene_nodes.scene_id` → `scene_nodes.root_scene_node_id` (every node points at the kind=scene row that roots its tree).
- Renamed `track_clips.scene_id` → `track_clips.root_scene_node_id`.
- Dropped the `scenes` table.

The frontend "scenes" list in the editor's left dock (`310cbaa`) is now just a filtered view of kind=scene nodes for the active project; scene delete + scene rename are PUT/DELETE on the corresponding `scene_nodes` row. Pre-migration the DB is backed up to a sibling `.bak` file (`3330c0d`).

Compose-layer roots followed the same pattern at the same time — see [compose.md](compose.md) for the `compose_scene` kind + project-scoped compose hierarchy.

### DB tables (migration 001 + later patches)

**`scene_nodes`**: the project's spatial entity tree, including scene-root rows (`kind = 'scene'`).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| project_id | TEXT FK → projects | cascade delete; added in migration 018 |
| root_scene_node_id | TEXT FK → scene_nodes(id) | The kind=`scene` row that roots this node's tree. For the scene-root itself this is its own id. Renamed from `scene_id` in migration 018. |
| parent_id | TEXT FK → scene_nodes (self) | null = scene-root (kind=`scene`) or top-level under it; cascade delete |
| name | TEXT | display name |
| kind | TEXT | see node kinds below |
| file_path | TEXT | asset path (avatars, models) |
| bone_attachment | TEXT | VRM bone name; child is parented to this bone on an ancestor avatar |
| hidden | INTEGER | 0/1; added in migration 005 |
| properties | TEXT | Migration 007 (implemented): JSON blob of per-node properties. First use: `blendTransitionTime` on VRM avatar nodes (default 0.5s). Plumbed through shared types/schema, scene-nodes routes, API client `mapNode`, editorStore `NodeRecord`. `PUT /scene-nodes/:nodeId` shallow-merges incoming `properties` into the stored blob (mirrors the scene `runtime_settings` pattern). |
| components | TEXT | JSON blob of per-kind config (transform, light, camera, etc.) |
| created_at, updated_at | TEXT | |

Index on `(scene_id, parent_id)` for tree traversal.

Self-referential FK with cascade: deleting a parent deletes all descendants.

### Node kinds

| Kind | Purpose |
|------|---------|
| `scene` | Scene-root container (migration 018). One per scene; reuses the old `scenes.id`. Holds `properties` carrying the legacy `runtime_settings`. |
| `avatar` | VRM character. Drives VMC/MediaPipe pipelines. |
| `model` | GLTF/GLB static or animated mesh |
| `light` | Point or directional light |
| `camera` | Perspective camera; can have camera effects |
| `group` | Empty transform container |
| `particle` | Particle emitter |
| `billboard` | 2D sprite always facing screen |
| `prop` | Static mesh (alias of model, different semantic) |
| `godray_caster` | Invisible sun mesh for the GodRays post-processing effect |
| `text_troika` | SDF text via `troika-three-text`. Config: `{ content, fontSize, color, anchorX, anchorY, maxWidth, billboard? }`. With `billboard: true` the rendered text quaternion-locks to the active camera. `renderNodeElement` returns `null` for this kind so it mounts flat at the top level (like billboards/particles); the per-scene mount happens via `SceneNodes` `flatTextTroika`. |
| `text_canvas` | `THREE.CanvasTexture` on a plane mesh, flat-mounted like `billboard`. Config: `{ content, fontSize, color, padding, allowHtml?, width, height, billboard? }`. Plain-text path uses a 2D canvas context with word-wrap. With `allowHtml`, the content is sanitised via `DOMPurify` (curated allow-list, see `lib/textSanitize.ts` `TEXT_SANITIZE_OPTS`) and rasterised off-DOM via `html2canvas` — this is the path used to render overlive emote HTML. |
| `video` | 3D video plane backed by `THREE.VideoTexture`, mirrors `billboard` (facing/backface/size). Per-instance playback config (`autoplay`/`loop`/`onEnd: 'freeze'\|'hide'`/`muted`/`volume`). **Flat-mounted** like billboards (`renderNodeElement` returns `null`; rendered at the top level) so reparenting doesn't remount the `<video>` and restart it. Registers a `MediaHandle` keyed by `node.id`. See [media.md](media.md). |
| `audio` | Non-visual audio source modelled on `light` (editor gizmo when not `viewerMode`). `audioType: 'simple'` → `THREE.Audio`; `'directional'` → `THREE.PositionalAudio` positioned by `useTransformWithOverride` with `refDistance`/`rolloffFactor`/`maxDistance` + cone. Uses a shared per-camera `THREE.AudioListener` (`getAudioListener`). Muted in the editor unless `editorAudioPreviewEnabled`; audible in the viewer. Registers a `MediaHandle` keyed by `node.id`. See [media.md](media.md). |
| `feed` | In-scene (3D) data-channel overlay — the analog of the 2D `feed` compose layer. `THREE.CanvasTexture` on a plane (`Viewport.FeedCanvasNode`), flat-mounted like `text_canvas`. Config: `{ template, css, width, height, padding, fontSize, color, billboard? }` (under `components.feed`). Subscribes to the data-channel bus by identity (`global ∪ this node's own id`), renders the htm template into an **off-screen React root** (`createRoot` + `flushSync`), then rasterises via `html2canvas`. Shares the template engine (`lib/feedTemplate.tsx`) with the 2D feed layer. A `set_data` node targets it by picking the feed node as its `scope`. See [data-channels.md](data-channels.md). |

## Implemented (Phase 1 — signal-graph expansion)

- **`opacity` on `components.transform`** (default 1) for all node kinds. Read by `Viewport.useTransformWithOverride` and applied via a new `useApplyOpacity(groupRef, opacity)` hook, which walks descendant meshes once per frame:
  - Sets `material.transparent = true; material.opacity = value` while `opacity < 1`.
  - Caches the *original* `material.transparent` flag per material; when `opacity` returns to `≥ 1` the original flag is restored (so we don't permanently flip an opaque material into the transparent draw queue).
  - Wired into `AvatarNode`, `ModelNode`, `BillboardNode`, `ParticleNode`, `GodrayCasterNode`. Lights and cameras are skipped.
  - Animatable via track clips and runtime overrides.
- **Runtime override read path:** `useTransformWithOverride` merges `runtimeNodeOverrides[node.id]` alongside the existing clip override slot. Conflict on transform/scalar paths: **clip wins**. For `opacity` and `text.content`, runtime overrides are the only surface. See [runtime-overrides.md](runtime-overrides.md).
- **Tmp scene nodes** rendered from the spawn channel arrive via the normal `node_added` / `node_removed` WS messages and render through the same per-kind renderers as persistent nodes. See [spawn.md](spawn.md).
- **Schema:** `sceneNodeKindSchema` and the `NodeKind` union (`packages/shared/src/types.ts`) extended with `text_troika`, `text_canvas`, `video`, `audio` (and backfilled `billboard`). New frontend deps: `dompurify`, `html2canvas`, `troika-three-text` (ambient `.d.ts` at `packages/frontend/src/types/troika-three-text.d.ts`).

## Implemented — video & audio scene-node kinds

The `video` and `audio` node kinds (and their playback model, the media-command bus, and the track-clip event lane that drives them) are documented in [media.md](media.md). Both are flat-mounted (like billboards/text): `video` for stable `<video>` playback across reparenting, `audio` because it's non-visual. Each registers a `MediaHandle` in the media registry keyed by `node.id`. Audio audibility is gated (editor-muted unless `editorAudioPreviewEnabled`; audible in the viewer).


### `components` JSON structure (per node)

Stored as a single JSON blob in `scene_nodes.components`. Each key is a sub-component type:

```ts
{
  transform?: { x, y, z, rx, ry, rz, sx, sy, sz }
  light?:     { type: 'point' | 'directional', color, intensity }
  camera?:    { fov, near, far, backgroundImage? }
  billboard?: { url, width, height }
  particle?:  { emitter config }
  animation?: { idleUrl, clips: [] }
  // ...
}
```

This is not the same as the `behaviors` table (the separate motion capture/breathing/etc. table, renamed from `node_components` in migration 022). The `components` JSON column (the ECS `Component` union — `TransformComponent`/`LightComponent`/etc. — which keeps the "Component" name) is for intrinsic per-kind data (transform, light params, camera settings); `behaviors` rows are for behavioral drivers (now called **Behaviors**).

## Backend routes

```
GET    /projects/:projectId/scenes
POST   /projects/:projectId/scenes         body: { name }
DELETE /scenes/:sceneId

GET    /scenes/:sceneId/nodes
POST   /scenes/:sceneId/nodes              body: { name, kind, filePath?, parentId?, boneAttachment?, components? }
PUT    /scene-nodes/:nodeId                body: { name?, kind?, filePath?, parentId?, boneAttachment?, hidden?, components? }
DELETE /scene-nodes/:nodeId
```

`POST /scenes/:sceneId/nodes` broadcasts `node_added` to all WebSocket clients.  
`PUT /scene-nodes/:nodeId` broadcasts `node_updated`.  
`DELETE /scene-nodes/:nodeId` broadcasts `node_removed` (cascade handles children in DB, but the broadcast is only for the deleted node).

## Frontend — `SceneGraph.tsx`

Tree panel on the left side of the editor. Renders the active scene's node hierarchy.

### Rendering logic (`renderNode`)

1. Splits children into **bone-attached** and **free** children
2. Free children render as nested rows with chevron toggles
3. Bone-attached children are shown inline under the bone row of their ancestor avatar (visual grouping, not a different parent in the data model)
4. Recursion handles arbitrary depth

### Drag and drop (reparenting)

- Drag a node row → sets drag state
- Drop onto another node → `PUT /scene-nodes/:draggedId` with `parentId: targetId`
- Drop onto a bone row → `PUT /scene-nodes/:draggedId` with `parentId: avatarNodeId` and `boneAttachment: boneName`
- Drop onto the root area → `PUT /scene-nodes/:draggedId` with `parentId: null, boneAttachment: null`
- Visual feedback: highlight target row with color and outline during hover

### Node row controls

- **Visibility toggle** (eye icon) → `PUT /scene-nodes/:id` with `{ hidden: !current }`
- **Camera preview** (✦, camera nodes only) → `setPreviewEffectsCamera(nodeId)` — enables post-processing in the viewport for this camera
- **Viewer link** (↗, camera nodes only) → opens `/viewer/:projectId/:nodeId` in a new tab
- **Context menu** (right-click): real popup menu (was `window.prompt` based; refactored in `13f0021`) using the generic `components/editor/ContextMenu.tsx`. The legacy in-place ContextMenu was renamed to `SceneNodeContextMenu`. Items include Add Child, Move Into, Unparent, Delete, plus Copy / Paste entries that gate on the editor clipboard kind (`d26518a`, `47af189`) — see [clipboard.md](clipboard.md).

### Inline sections

**BehaviorsSection** (component renamed from `NodeComponentsSection`): shows ordered list of `behaviors` rows for the selected node (sorted by `sort_order`). Excludes camera effects. Supports enable toggle and remove.

**CameraEffectsSection**: shown only for camera nodes. Lists `camera_effects` rows for this node. Supports enable toggle and remove.

**AutomationListPanel** (renamed from `GraphListPanel`): browsable list of the project's Automations and behavior signal graphs (VMC pipeline, breathing, etc.). Selecting an automation sets `activeAutomationId` in the store, which opens the `SignalGraphCanvas` (the signal-graph substrate editor).

## Frontend — `Viewport.tsx` (`SceneNodes` component)

```tsx
export function SceneNodes({ omitNodeId?, omitKinds?, viewerMode? })
```

Filters nodes to the active scene and optional exclusions. Recursively renders the hierarchy via `renderNodeElement()`.

### Node kind → Three.js component

| Kind | Component | Notes |
|------|-----------|-------|
| `avatar` | `AvatarNode` | VRM loader, animation mixer, VMC retargeting |
| `model`, `prop` | `ModelNode` | GLTF/GLB loader, animation |
| `light` | `LightNode` | Point or directional |
| `camera` | `CameraNode` | Perspective camera |
| `godray_caster` | `GodrayCasterNode` | Sun mesh for GodRays |
| `particle` | `ParticleNode` | GPU-instanced particle system — see [nodes/particle.md](nodes/particle.md) |
| `billboard` | `BillboardNode` | 2D sprite — see [nodes/particle.md](nodes/particle.md) |
| `video` | `VideoNode` | `THREE.VideoTexture` plane — see [media.md](media.md) |
| `audio` | `AudioNode` | Non-visual Web Audio source — see [media.md](media.md) |
| `group` | `THREE.Group` | No geometry |

**Particles, billboards, video and audio nodes are rendered at the top level** (not nested inside the React tree), even though they have a `parentId` in the DB. This preserves React component instance identity across reparenting — for particles it avoids destroying pools; for `video`/`audio` it keeps the `<video>`/Web Audio element from remounting and restarting playback. See [nodes/particle.md](nodes/particle.md) and [media.md](media.md).

### Node registry

`nodeGroupRegistry: Map<nodeId, THREE.Group>` — maps every node ID to its outermost Three.js Group. Used by `BoneAttacher` and other components that need to imperatively reference scene objects.

### Bone attachment

`BoneAttacher` is a component that runs each frame and imperatively parents a node's group into the matching VRM bone node. This means bone-attached nodes (e.g., a prop on the right hand) follow skeleton motion without being part of the VRM's own bone hierarchy.

## Transform update flow

1. User edits position/rotation/scale in `PropertiesPanel`
2. On blur → `api.updateNode(nodeId, { components: { ...existing, transform: newTransform } })`
3. `PUT /scene-nodes/:nodeId` → DB write → WS `node_updated` broadcast
4. `useWsSync` applies the patch to the store
5. Viewport reads transform from store and sets `group.position`, `group.rotation`, `group.scale` each frame
