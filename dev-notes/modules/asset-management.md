# Asset Management

Covers file upload, storage, discovery, and placement into scenes.

## Backend — `routes/api.ts`

### Storage layout

```
uploads/
  <projectId>/
    avatars/      .vrm, .glb, .gltf
    animations/   .fbx, .bvh
    images/       .jpg, .png, .webp, ...
    other/        everything else
```

Subfolder is inferred from file extension at upload time.

### DB table — `asset_files` (migration 001)

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| project_id | TEXT FK → projects | cascade delete |
| original_name | TEXT | original filename from client |
| stored_path | TEXT | absolute path on disk |
| mime_type | TEXT | |
| size | INTEGER | bytes |
| hash | TEXT | for deduplication |
| is_deduplicated | INTEGER | 0/1 |
| created_at | TEXT | |

Index on `(project_id, hash)` for dedup and discovery lookups.

### Routes

```
GET    /projects/:projectId/assets
POST   /projects/:projectId/assets    body: { name, data (base64), mimeType }
DELETE /assets/:assetId
```

**GET** runs `discoverAssets()` before returning — scans `uploads/<projectId>/` subdirs and inserts DB records for any files found on disk but not yet registered. This is the recovery mechanism if files are placed manually or restored from backup.

**POST** flow:
1. `sanitizeStem()` — strip path traversal, spaces, special chars
2. `allocateFilename()` — find non-colliding name (e.g., `model_2.vrm` if `model.vrm` exists)
3. `writeFileSync()` base64-decoded data to disk
4. `INSERT INTO asset_files`
5. Return asset record

**DELETE** removes the DB record and deletes the file from disk.

### Key functions

- `sanitizeStem(name)` — removes path separators, spaces, and non-safe chars from the filename stem
- `allocateFilename(dir, stem, ext)` — increments suffix until a free name is found
- `discoverAssets(projectId)` — scans all subdirs under `uploads/<projectId>/` and upserts missing DB records

## Frontend — `AssetManager.tsx`

Tabbed panel. Reads from `useEditorStore`: `assets`, `activeSceneId`, `selectedNodeId`, `nodes`, `nodeComponents`, `cameraEffects`.

### Tabs

| Tab | Accepts | Asset kind |
|-----|---------|------------|
| Models | `.vrm`, `.glb`, `.gltf` | `model` |
| Animations | `.fbx`, `.bvh` | `animation` |
| Images | `.jpg`, `.png`, `.webp`, ... | `image` |
| Components | — | (component kinds, not file assets) |
| Effects | — | (camera effect kinds, not file assets) |

### Asset-to-scene actions

**Models (VRM/GLB/GLTF)**:
- "Add to scene" → `POST /scenes/:sceneId/nodes` with `kind: 'avatar'` (VRM) or `kind: 'model'` (GLB/GLTF), `filePath` set to the stored path

**Animations (FBX/BVH)**:
- "Apply to node" → `PUT /scene-nodes/:nodeId` with `components.animation.idleUrl` set
- Requires an avatar or model node to be selected

**Images**:
- "Add as billboard" → creates a `billboard` node with the image path
- "Apply texture" → updates selected billboard or particle node's texture
- "Set background" → updates selected camera node's `camera.backgroundImage`

**Components tab**:
- Lists all `componentKinds` from store, filtered by applicability
- Prevents adding duplicate kinds to the same node
- "Add" → `POST /scene-nodes/:nodeId/components` with default config from kind definition

**Effects tab**:
- Only active when a camera node is selected
- Lists all 16 camera effect kinds
- Prevents adding duplicate kinds to the same camera
- "Add" → `POST /scene-nodes/:nodeId/effects` with `{kind, enabled: true, config: {}}`

## Asset kinds (frontend classification)

Assets in the store carry a `kind` field derived from MIME type:
- `model` — VRM/GLB/GLTF
- `animation` — FBX/BVH
- `image` — raster images

This is set client-side from the MIME type; it is not stored in the DB.
