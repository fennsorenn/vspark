# Asset Management

Covers file upload, storage, discovery, and placement into scenes.

## Backend — `routes/assets.ts`

### Storage layout

```
uploads/
  <projectId>/
    avatars/      .vrm, .glb, .gltf
    animations/   .fbx, .bvh
    images/       .jpg, .png, .webp, ...
    videos/       .mp4, .webm, .mov, .m4v, .ogv
    audio/        .mp3, .wav, .ogg, .m4a, .aac, .flac
    other/        everything else
```

Subfolder is inferred from file extension at upload time via `SUBFOLDER_BY_EXT` in
`routes/shared.ts`; matching MIME types come from `MIME_BY_EXT` there. Upload / list /
delete routes are generic and unchanged for the new kinds.

### DB table — `asset_files` (migration 001)

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| project_id | TEXT FK → projects | cascade delete |
| original_name | TEXT | original filename from client |
| stored_path | TEXT | absolute path on disk |
| mime_type | TEXT | |
| size | INTEGER | bytes |
| hash | TEXT | for deduplication; also the freshness key for `metadata` |
| is_deduplicated | INTEGER | 0/1 |
| metadata | TEXT | Migration 034: JSON `VrmAssetMetadata` (`{ bones, materials, morphTargets, expressions }`) pre-extracted from VRM/GLB at upload via `vrm/metadata.ts`. Nullable. |
| file_mtime | TEXT | Migration 034: cheap freshness gate (with `size`) so `discoverAssets` avoids sha256-ing every file on every listing. Nullable. |
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
4. `extractVrmMetadata()` (`vrm/metadata.ts`) on VRM/GLB → `metadata` JSON + record `file_mtime` (non-fatal; non-VRM `.glb` stores partial/empty metadata, never throws)
5. `INSERT INTO asset_files`
6. Return asset record

**DELETE** removes the DB record and deletes the file from disk.

### Key functions

- `sanitizeStem(name)` — removes path separators, spaces, and non-safe chars from the filename stem
- `allocateFilename(dir, stem, ext)` — increments suffix until a free name is found
- `discoverAssets(projectId)` — scans all subdirs under `uploads/<projectId>/` and upserts missing DB records. Extracts `metadata` for newly-discovered VRM/GLB files and runs a freshness/self-heal loop — `statSync` size+mtime gate trusts stored `hash`+`metadata`; on a mismatch it recomputes sha256 and, if the hash drifted, updates `hash`+`size`+`file_mtime`+`metadata` together. Also closes the existing gap where a file overwritten in place kept a stale hash (which broke preset re-linking by hash). See [backend-api.md](backend-api.md).

## Frontend — `AssetManager.tsx`

Tabbed panel. Reads from `useEditorStore`: `assets`, `activeSceneId`, `selectedNodeId`, `nodes`, `behaviors`, `cameraEffects`.

Upload `<input>`s (and the drop zone) accept **multiple** files: `handleUploadFiles(FileList | File[])` iterates and POSTs each, reporting any failures together. The same upload path backs OS image-file drag-and-drop onto the compose viewport (see [compose.md](compose.md)).

### Tabs

| Tab | Accepts | Asset kind |
|-----|---------|------------|
| Models | `.vrm`, `.glb`, `.gltf` | `model` |
| Animations | `.fbx`, `.bvh` | `animation` |
| Images | `.jpg`, `.png`, `.webp`, ... | `image` |
| Videos | `.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv` | `video` |
| Audio | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac` | `audio` |
| Behaviors (formerly "Components") | — | (behavior kinds, not file assets) |
| Effects | — | (camera effect kinds, not file assets) |

`AssetThumb.tsx` renders a first-frame `<video>` poster for video assets and a 🔊 icon
for audio. The `BottomDockTab` store field gained `'videos'` | `'audio'`.

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

**Videos**:
- "Add as Video" → creates a `video` scene node with the video source
- apply-source action onto a selected `video` node / compose layer

**Audio**:
- "Add as Audio" → creates an `audio` scene node with the audio source
- apply-source action onto a selected `audio` node

See [media.md](media.md) for the `video`/`audio` node kinds, the compose video layer,
and how playback is driven.

**Behaviors tab** (formerly "Components"):
- Lists all `behaviorKinds` from store, filtered by applicability
- Prevents adding duplicate kinds to the same node
- "Add" → `POST /scene-nodes/:nodeId/behaviors` with default config from kind definition

**Effects tab**:
- Only active when a camera node is selected
- Lists all 16 camera effect kinds
- Prevents adding duplicate kinds to the same camera
- "Add" → `POST /scene-nodes/:nodeId/effects` with `{kind, enabled: true, config: {}}`

## Asset kinds (frontend classification)

Assets in the store carry a `kind` field derived from MIME type (`AssetKind` union
in `api/client.ts`, classified by `guessAssetKind`):
- `model` — VRM/GLB/GLTF
- `animation` — FBX/BVH
- `image` — raster images
- `video` — `.mp4 .webm .mov .m4v .ogv` (`video/*`)
- `audio` — `.mp3 .wav .ogg .m4a .aac .flac` (`audio/*`)

This is set client-side from the MIME type; it is not stored in the DB.
