# Scene Graph

The hierarchy of spatial nodes in a scene. Covers both the DB/API layer and the frontend tree UI.

## Data model

### DB tables (migration 001 + later patches)

**`scenes`**: id, project_id, name, timestamps. Project-scoped; FK cascade delete.

**`scene_nodes`**: the scene tree.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| scene_id | TEXT FK → scenes | cascade delete |
| parent_id | TEXT FK → scene_nodes (self) | null = root node; cascade delete |
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
| `avatar` | VRM character. Drives VMC/MediaPipe pipelines. |
| `model` | GLTF/GLB static or animated mesh |
| `light` | Point or directional light |
| `camera` | Perspective camera; can have camera effects |
| `group` | Empty transform container |
| `particle` | Particle emitter |
| `billboard` | 2D sprite always facing screen |
| `prop` | Static mesh (alias of model, different semantic) |
| `godray_caster` | Invisible sun mesh for the GodRays post-processing effect |
| `text_troika` | **WIP (Phase 1)** — SDF text via `troika-three-text`. Config: `{ content, fontSize, color, anchorX, anchorY, maxWidth, billboard? }`. |
| `text_canvas` | **WIP (Phase 1)** — `THREE.CanvasTexture` on a plane mesh. Config: `{ content, fontSize, color, padding, allowHtml?, width, height, billboard? }`. With `allowHtml`, rasterises a sanitised HTML fragment via `html2canvas` (the path that renders overlive emote HTML). |

## WIP additions (Phase 1 — signal-graph expansion)

- **`opacity` on `components.transform`** (default 1) for all node kinds. Applied in `Viewport.tsx` by walking descendant meshes once per frame to set `material.transparent = true; material.opacity = value`, caching to avoid per-frame mutation when unchanged. Animatable via track clips and runtime overrides.
- **Runtime override read path:** `useTransformWithOverride` is extended to merge `runtimeNodeOverrides[node.id]` alongside the existing track-clip override slot. Conflict on transform/scalar paths: track-clip wins. For `opacity` and `text.content`, runtime overrides are the only override surface. See [runtime-overrides.md](runtime-overrides.md).
- **Tmp scene nodes** rendered from the spawn channel use the same node-kind renderers as persistent nodes. See [spawn.md](spawn.md).
- **Migration:** `0XX_text_kinds_and_opacity.ts` extends the kind enum and defaults `opacity: 1` on existing transform components.


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

This is not the same as `node_components` (the separate motion capture/breathing/etc. table). The `components` JSON column is for intrinsic per-kind data (transform, light params, camera settings); `node_components` rows are for behavioral drivers.

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
- **Context menu** (right-click): Add Child, Move Into (select target), Unparent, Delete

### Inline sections

**NodeComponentsSection**: shows ordered list of `node_components` rows for the selected node (sorted by `sort_order`). Excludes camera effects. Supports enable toggle and remove.

**CameraEffectsSection**: shown only for camera nodes. Lists `camera_effects` rows for this node. Supports enable toggle and remove.

**GraphListPanel**: browsable list of active signal graphs (VMC pipeline, breathing, etc.). Selecting a graph sets `activeGraphId` in the store, which opens the signal graph canvas.

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
| `group` | `THREE.Group` | No geometry |

**Particles and billboards are rendered at the top level** (not nested inside the React tree), even though they have a `parentId` in the DB. This preserves React component instance identity across reparenting and avoids destroying particle pools. See [nodes/particle.md](nodes/particle.md) for details.

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
