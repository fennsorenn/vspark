# Preset Library

**Status: Implemented.**

Per-project library of serialised scene-node and compose-layer subtrees, with optional asset embedding. Presets are **portable across projects**: any DB id referenced inside a serialised subtree is replaced with a placeholder on export and re-bound to a freshly minted id on import.

Backend: `packages/backend/src/presets/`. Routes: `packages/backend/src/routes/presets.ts`. DB: migration 017 (`presets` table; per-project, cascade on project delete). Frontend: `components/editor/PresetLibrary.tsx` (bottom-dock drawer).

## What a preset contains

A preset payload (`format: 'vspark.preset.v2'`) is rooted at either a scene node or a compose layer and includes its **entire subtree** plus everything attached to it:

- **Scene-node root** — recursive `scene_nodes`, plus per-node `node_components`, `camera_effects`, owned standalone graphs (`graphs` where `owner_kind = 'scene_node'`), owned track clips (`track_clips` where `owner_node_id` is in the subtree), and `animation_clips`.
- **Compose-layer root** — recursive `compose_layers` (via `parent_id`, migration 016), plus owned standalone graphs (`graphs` where `owner_kind = 'compose_layer'`) and owned track clips.
- **Assets** — referenced files (avatar GLB, animation clip sources, etc.) are listed in an `assets[]` array. With `embedAssets: true` the file bytes are base64-inlined; without, only the SHA-256 hash + original path are recorded, and import attempts to match an existing asset by hash. See `presets/assets.ts`.

`exportedFrom: { projectId, rootSceneNodeId, rootId }` is audit-trail metadata and is **deliberately excluded from id substitution** (replacing the source rootId with a placeholder would be misleading; the field is never read on import). See `fd6e6cb`.

## Id portability — placeholder substitution

Persisting a subtree requires solving a problem that wasn't visible until graphs / clips / set_*_param nodes started referencing entity ids directly inside their JSON config: every literal scene-node id, component id, graph id, clip id, lane id, etc. inside a `descriptor`, `layer.config`, `properties`, or `config` blob would, after import into another project, point at an entity that no longer exists.

Backend: `packages/backend/src/presets/substitute.ts`.

- **Export pass** (`makeExportSubstituter`) builds a single regex of every real id being serialised (the same `realToPreset` map collected as rows are emitted with `presetId` tags like `n5`, `c3`, `g1`, `tc4`, `ln2`, `k7`, `ce2`, `ac4`). One walk over the payload replaces each match with `__preset:<tag>`. **Occurrence-based**, not per-kind whitelist — naturally covers any future node kind or config shape.
- **Import pass** (`makeImportSubstituter`) builds the reverse `placeholderTag → newRealId` map after minting and walks the payload again before insert.

Placeholders that don't match (e.g. a Twitch account id referenced from inside a graph node's `defaultConfig.account`) are left intact — the caller / runtime surfaces them as "external refs" the user may need to rebind. See `344de06`, `fd6e6cb`.

## REST surface — `routes/presets.ts`

| Method + path | Purpose |
|---|---|
| `GET    /api/projects/:projectId/presets` | List preset summaries for a project. |
| `POST   /api/projects/:projectId/presets` | Save a serialised subtree as a named preset (body: `{ name, description?, rootKind, rootId, embedAssets? }`). |
| `GET    /api/presets/:id` | Fetch a single preset with full `payload`. |
| `DELETE /api/presets/:id` | Drop a preset row. |
| `POST   /api/presets/serialize` | Stateless: serialise a subtree, return the payload without saving (used by clipboard copy paths). |
| `POST   /api/presets/instantiate` | Insert payload into a target project (body: `{ payload, projectId, rootSceneNodeId? \| rootComposeSceneId?, parentId?, boneAttachment? }`). Returns the newly minted root id. Accepts both `vspark.preset.v1` and `v2`. |

**Paste-onto-bone**: `instantiate` accepts a `boneAttachment` target field. When set, the root scene node is created as a child of `parentId` (typically the VRM avatar) with that bone name, so a user can paste a sword preset onto a hand bone in the scene tree.

Instantiated standalone graphs are explicitly started after insert (`1a80383`) — without this fix the rows landed disabled-equivalent because the manager had been instantiated before they existed.

## Frontend — `components/editor/PresetLibrary.tsx`

Bottom-dock drawer (one of the editor's `bottomTab` options, alongside Assets and Clips — see `310cbaa`). Lists project presets, supports drag-drop instantiation onto the scene tree / compose tree, name + description editing, and delete. Uses thumbnails when `thumbnail_path` is set on the row.

Preset payloads also flow through the clipboard for copy/paste of scene-node and compose-layer subtrees — see [clipboard.md](clipboard.md). The clipboard path serialises via `POST /api/presets/serialize`, ships the payload in a `ClipboardPayload` of kind `'scene-node'` / `'compose-layer'`, and re-instantiates on paste via `POST /api/presets/instantiate`.

## Cross-references

- [scene-graph.md](scene-graph.md) — `scene_nodes` table + bone attachment (the paste-onto-bone target).
- [compose.md](compose.md) — `compose_layers` table + nesting via `parent_id` (migration 016).
- [project-graphs.md](project-graphs.md) — standalone graphs are nested into preset payloads at the right owner scope.
- [track-clips.md](track-clips.md) — track clips owned by nodes / layers in the subtree are serialised with lanes + keyframes.
- [clipboard.md](clipboard.md) — uses `presets/serialize` + `presets/instantiate` to copy/paste scene-node and compose-layer subtrees within and across projects.
