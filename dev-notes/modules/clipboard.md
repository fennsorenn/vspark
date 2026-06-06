# Editor Clipboard

**Status: Implemented.**

Single editor-wide clipboard slot driven by Cmd/Ctrl+C / Cmd/Ctrl+V across most concepts in the editor: signal-graph node selections, whole automations, scene-node subtrees, compose-layer subtrees, camera effects, behaviors, and track clips. (The clipboard `kind` discriminant strings — `'graph'`, `'graph-nodes'`, `'node-component'` — are persisted into the OS clipboard and were intentionally NOT renamed.)

Frontend module: `packages/frontend/src/clipboard.ts`.

## Storage

Mirrored in two places:

- **OS clipboard** via `navigator.clipboard` — survives reloads + crosses windows / tabs. Written eagerly on copy, read asynchronously on paste.
- **Zustand `clipboardPayload` slice** — synchronous mirror used by right-click context menus to decide whether to render "Paste …" items without an async permission round-trip on every menu open.

Both surfaces wrap the payload with a `{ vspark: 'vspark.clipboard.v1', payload }` sentinel so foreign OS-clipboard contents are ignored cleanly.

## Payload — discriminated union

`ClipboardPayload` has 7 variants, all distinguishable by `kind`:

| `kind` | Payload shape | Source / sink |
|---|---|---|
| `graph-nodes` | `{ nodes: GraphNodeDescriptor[], edges: GraphEdgeDescriptor[] }` | In-graph (substrate) selection — `SignalGraphCanvas` (`ec9c02e`). |
| `graph` | `{ name, descriptor, sourceOwnerKind: OwnerKind }` | Whole automation copy/paste across scopes — `AutomationsSection` / Automation UI (`9ac2740`). (`kind` string kept.) |
| `scene-node` | `{ preset: PresetPayloadInput }` | Scene-tree right-click + Cmd/Ctrl+C/V (`d26518a`). Re-uses preset serialise/instantiate machinery; see [presets.md](presets.md). |
| `compose-layer` | `{ preset: PresetPayloadInput }` | Compose-tree right-click + Cmd/Ctrl+C/V (`d26518a`). |
| `camera-effect` | `{ effect: Omit<CameraEffectRecord, 'id' \| 'nodeId'> }` | Camera-effect rows in `SceneGraph` (`d26518a` / `47af189`). |
| `node-component` (`kind` string kept) | `{ component: Omit<BehaviorRecord, 'id' \| 'nodeId'> }` | Behavior rows in `SceneGraph` (`d26518a` / `47af189`). |
| `track-clip` | `{ clip: Omit<TrackClipRecord, ...ids>, sourceOwnerId, sourceOwnerKind }` | Clip rows in `ClipsSection` (`47af189`). Lane `targetId`s are preserved; paste decides whether to retarget to the destination owner — see `ClipsSection.handlePasteClip`. |

Inner ids that the paste-side will re-mint (clip id, lane ids, kf ids, lane.clipId) are **deliberately omitted** so the destination can mint them.

## Wrapper tag

`WRAPPER_TAG = 'vspark.clipboard.v1'`. Bump if any of the variant shapes change incompatibly. Foreign clipboard contents (`{ vspark: ... }` missing or wrong tag) are silently ignored on paste.

## Context-menu integration

Cmd/Ctrl+C / Cmd/Ctrl+V are handled at keyboard scope per panel; right-click context menus surface explicit "Copy" / "Paste …" entries that gate on `clipboardPayload?.kind` matching the menu's accepted kinds. All consumers use the generic `components/editor/ContextMenu.tsx` (see `13f0021`, `47af189`).

## Cross-references

- [presets.md](presets.md) — `'scene-node'` / `'compose-layer'` variants reuse the preset payload format; cross-project paste works for free.
- [project-graphs.md](project-graphs.md) — `'graph'` variant (an Automation) pastes across owner scopes; the manager rebinds context nodes as needed.
- [track-clips.md](track-clips.md) — `'track-clip'` variant's `sourceOwnerKind` + `sourceOwnerId` drive the lane-retarget decision on paste.
