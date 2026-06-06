# Preset Library

**Status: Implemented.**

Per-project library of serialised scene-node and compose-layer subtrees, with optional asset embedding. Presets are **portable across projects**: any DB id referenced inside a serialised subtree is replaced with a placeholder on export and re-bound to a freshly minted id on import.

Backend: `packages/backend/src/presets/`. Routes: `packages/backend/src/routes/presets.ts`. DB: migration 017 (`presets` table; per-project, cascade on project delete). Frontend: `components/editor/PresetLibrary.tsx` (bottom-dock drawer).

## What a preset contains

A preset payload (`format: 'vspark.preset.v2'`) is rooted at either a scene node or a compose layer and includes its **entire subtree** plus everything attached to it:

- **Scene-node root** — recursive `scene_nodes`, plus per-node `behaviors` (table renamed from `node_components` in migration 022), `camera_effects`, owned automations (`automations` where `owner_kind = 'scene_node'`; table renamed from `graphs`), owned track clips (`track_clips` where `owner_node_id` is in the subtree), and `animation_clips`.
- **Compose-layer root** — recursive `compose_layers` (via `parent_id`, migration 016), plus owned automations (`automations` where `owner_kind = 'compose_layer'`) and owned track clips.

Track clips carry their **event/marker lane** as well as scalar lanes/keyframes: `serialize.ts`'s `serializeClipEvents()` emits an `events` array per clip (each: `presetId`, `t`, `action`, `targetKind`, `targetPresetId` remapped through the same `realToPreset` map as lanes, `payload`); `deserialize.ts` premints event presetIds and inserts `track_clip_events` rows (resolving `targetPresetId` via `resolveId`). See [track-clips.md](track-clips.md).
- **Assets** — referenced files (avatar GLB, animation clip sources, etc.) are listed in an `assets[]` array. With `embedAssets: true` the file bytes are base64-inlined; without, only the SHA-256 hash + original path are recorded, and import attempts to match an existing asset by hash. See `presets/assets.ts`.

`exportedFrom: { projectId, rootSceneNodeId, rootId }` is audit-trail metadata and is **deliberately excluded from id substitution** (replacing the source rootId with a placeholder would be misleading; the field is never read on import). See `fd6e6cb`.

## Built-in presets (shipped, read-only)

`packages/backend/src/presets/builtins.ts` aggregates `BUILTIN_PRESETS` — presets
bundled with the app, authored as plain `vspark.preset.v2` objects (the backend
bundle has no JSON-module support). The definitions are split across
`presets/builtin_presets/`: `helpers.ts` (shared construction helpers),
`particles.ts`, `chat.ts`, and `alerts.ts`, all re-exported and combined by
`builtins.ts`. They are served read-only and never touch the `presets` table:

| Method + path | Purpose |
|---|---|
| `GET /api/presets/builtin` | List built-in summaries (`id, name, description, rootKind, builtin: true`). |
| `GET /api/presets/builtin/:id` | Full built-in incl. `payload`. |

These routes are registered **before** `/presets/:id` so the literal `builtin`
segment isn't captured as an id. The frontend (`PresetLibrary.tsx`) shows them
in a separate **Built-in** section above project presets, with a Use button and
no delete. Add more by appending objects to the relevant `builtin_presets/` file.

Ships with a Three-Point Lighting rig and an Organizer Group scaffold, plus:

- **Chat overlays** (`chat.ts`):
  - Chat overlay as a 2D compose `feed` layer (graph: `overlive_chat_feed` →
    `set_data` scoped to the layer).
  - Chat overlay as a 3D `feed` scene node (same graph pattern, scoped to the node).
  - Scrolling chat messages in 3D — a hidden `text_canvas` template + track clip
    sweeping `position.x` right→left (graph: `overlive_chat_message` → random Y +
    random Z → `spawn_clip` → `set_text` / `set_scene_node_param` via `spawnRef`).
- **Particle generators** (`particles.ts`): Rain, Snow, Fire, Magic Sparkles,
  Sparkler — each a `particle` scene node with a tuned `components.particle` config.
- **Event alert overlays** (`alerts.ts`): Donations, Tips, Subs, Raids — each a
  compose `group` containing a badge + text layer at base opacity 0, a hidden
  `audio` "Sound" layer (`visible:false`) as the sound source, an "Alert Fade" track
  clip fading opacity 0→1→0, and a graph: `overlive` event → `pack_event` →
  `queue_events` ← `clock` pop → `unpack_event` → `start_clip` + `set_text` fired on
  each released alert. The media triggers are **no longer `media_control` graph
  nodes**: the "Alert Fade" clip carries event markers at `t=0` that `restart` the
  hidden `audio` "Sound" layer (and, for `-video` variants, the `video` badge). Since
  the clip plays on each released alert (via `start_clip`), the markers fire
  client-side through the media registry (see [media.md](media.md)). Each event ships
  **two variants** — an image badge (`builtin:alert-<event>`) and a video badge
  (`builtin:alert-<event>-video`) — so there are 8 alert presets
  (Donation/Tip/Sub/Raid × image/video), 18 built-ins total.

### Scene-node component bag round-trip

`serialize.ts` now also captures the `scene_nodes.components` JSON bag
(transform / light / camera / billboard config) as `sceneNodes[].componentsBag`,
and `deserialize.ts` writes it back on instantiate (was previously dropped,
leaving instantiated nodes with empty config). The field is additive and
optional — payloads serialized before this change still import (the bag falls
back to `{}`). This is what makes the built-in light rig actually render.

## Id portability — placeholder substitution

Persisting a subtree requires solving a problem that wasn't visible until automations / clips / set_*_param nodes started referencing entity ids directly inside their JSON config: every literal scene-node id, behavior id, automation id, clip id, lane id, etc. inside a `descriptor`, `layer.config`, `properties`, or `config` blob would, after import into another project, point at an entity that no longer exists.

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

Instantiated automations are explicitly started after insert (`1a80383`) — without this fix the rows landed disabled-equivalent because the manager had been instantiated before they existed.

## Frontend — `components/editor/PresetLibrary.tsx`

Bottom-dock drawer (one of the editor's `bottomTab` options, alongside Assets and the Timeline tab (formerly "Clips") — see `310cbaa`). Lists project presets, supports drag-drop instantiation onto the scene tree / compose tree, name + description editing, and delete. Uses thumbnails when `thumbnail_path` is set on the row.

Preset payloads also flow through the clipboard for copy/paste of scene-node and compose-layer subtrees — see [clipboard.md](clipboard.md). The clipboard path serialises via `POST /api/presets/serialize`, ships the payload in a `ClipboardPayload` of kind `'scene-node'` / `'compose-layer'`, and re-instantiates on paste via `POST /api/presets/instantiate`.

## Cross-references

- [scene-graph.md](scene-graph.md) — `scene_nodes` table + bone attachment (the paste-onto-bone target).
- [compose.md](compose.md) — `compose_layers` table + nesting via `parent_id` (migration 016).
- [project-graphs.md](project-graphs.md) — automations are nested into preset payloads at the right owner scope.
- [track-clips.md](track-clips.md) — track clips owned by nodes / layers in the subtree are serialised with lanes + keyframes.
- [clipboard.md](clipboard.md) — uses `presets/serialize` + `presets/instantiate` to copy/paste scene-node and compose-layer subtrees within and across projects.
