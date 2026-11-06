# Actions

**Status: Implemented (core + Hotkey kind).** Other kinds (Chat command, Chat
pattern, Chat keyword, Keyword combo, Redemption) are planned — see
[plans/actions.md](../plans/actions.md) Phase 3. Behaviors getting the same
stored-graph treatment (Phase 4) is implemented — see
[component-managers.md](component-managers.md#stored-editable-graphs).

An **Action** is a project-level, preauthored workflow configured by a settings
form. It is to the project what a [Behavior](component-managers.md) is to an
object: each kind ships a graph template, the form edits settings, and the
graph reads those settings through `settings` nodes. The graph is a normal,
stored, editable [Logic](project-graphs.md) graph owned by the action.

Decisions recorded in the plan (user, 2026-11-06) that this module follows:

- **Decided:** the name is *Actions* (DE *Aktionen*); an Action belongs to the
  project, a Behavior to an object.
- **Decided:** the graph is always editable; when it differs from the template
  output it was generated from, the UI shows a **Modified** badge and a
  **Reset** button (with confirmation).
- **Decided:** two classes of settings — *value* settings reach the graph
  through `settings` nodes live and never touch its structure; *shape* settings
  regenerate the graph (silently when unmodified; with a "discards your edits"
  confirmation when modified).
- **Decided:** a separate `actions` table, coupled to its graph by
  **ownership** (`logic.owner_kind = 'action'`, `owner_id = <action id>`);
  plain Logic rows carry no action fields; deleting the Action deletes its
  graph.
- **Decided:** the graph is stored, not generated on load.
- **Decided:** one shared settings node for Behaviors and Actions (the former
  `behavior_config`, now kind `settings`, palette label "Settings").
- **Decided:** the list is grouped by kind by default and each row previews its
  most important settings, declared per kind.
- **Decided:** the Macros panel is retired only once the Actions panel reaches
  parity for hotkeys (plan Phase 3) — it is still present.

The fingerprint-based boot regeneration was *proposed, not decided* in the plan;
it is implemented as proposed (below).

## Files

| File | Role |
|---|---|
| `packages/shared/src/actions.ts` (`@vspark/shared/actions`) | Kind registry, settings classes, templates (`build`), previews, fingerprints, graph status. Shared so backend and editor run the same template code. |
| `packages/backend/src/db/migrations/045_actions.sql` | `actions` table. |
| `packages/backend/src/sync/resources.ts` (`action` resource) | Row ⇄ DTO. |
| `packages/backend/src/mesh/index.ts` (`action` binding) | Tab rights, `guardAction` validation, `withPrev` tap → lifecycle. |
| `packages/backend/src/actions/lifecycle.ts` | What a committed action write does to its graph; create / reset / boot sync / status. |
| `packages/backend/src/routes/actions.ts` | REST CRUD + reset + kinds. |
| `packages/backend/src/logic/manager.ts` | Runs action-owned graphs; injects the action's settings into `settings` nodes. |
| `packages/frontend/src/mesh/actions.ts` | Read hooks + tab-authored writes. |
| `packages/frontend/src/components/editor/actions/` | `ActionsPanel` (left-dock tab) and the per-kind form (`HotkeyForm`). |
| `packages/frontend/src/help/content/{en,de}/actions.md` | Help page. |

## Data

### `actions` table (migration 045)

`id`, `project_id` (FK → projects, cascade), `kind`, `name`, `enabled`,
`settings` (JSON), `template_fingerprint` (nullable), `created_at`, `updated_at`.

### Mesh model `action`

DTO `{ id, projectId, kind, name, enabled, settings, templateFingerprint,
createdAt }`. No parent (there is no `project` rtype, same as project Logic).
In `TAB_MODELS`; tabs have full rights (`TAB_AUTHORED`). The backend
`validate` (`guardAction`) refuses unknown kinds, a missing name and — for tab
writes — a project that is not this server's; it normalizes `settings` for
every writer (a correction when they were not normalized).

### The graph

A `logic` document with `ownerKind: 'action'`, `ownerId: <action id>`, created
under the derived id `actionGraphId(actionId)` (`<actionId>-graph`), looked up
by ownership. The `logic` model's `parent` maps action-owned graphs to the
action, so `removeTree(actionId)` — a tab's delete, or the backend tap on any
remove — removes the graph with it, in one undo step.
`logic.persists` requires the owning `actions` row.

The derived id exists so two writers that both create the graph (the editor
and the boot repair) converge on one document. (Inferred design choice, not a
user decision.)

## Settings, templates, fingerprints (`@vspark/shared/actions`)

Each kind (`ActionKindDef`) declares: `label`, `icon`, `fields` (dotted paths,
`*` = every key of a keyed map, each `value` or `shape`), `defaults()`,
`normalize(raw)`, `build(shape) → { nodes, edges }`, `preview(settings)`.

- **Value vs shape is enforced by projection:** `build` receives only
  `shapeOf(kind, settings)` — the normalized settings restricted to the shape
  fields — so a template has no access to value settings and cannot bake them
  into the graph. Value settings reach the graph only through `settings` nodes.
- A path not matched by any shape field is a value (`settingClassOf`).
- `graphFingerprint(descriptor)` (also used for Behaviors' stored graphs —
  [component-managers.md](component-managers.md#stored-editable-graphs)) hashes node ids, kinds and `defaultConfig`
  plus the edges; node **positions**, the graph's id/label/readonly and edge
  transport hints are excluded (tidying the canvas is not a modification). A
  53-bit non-cryptographic hash (cyrb53) over canonical JSON.
- `templateFingerprint(kind, settings)` = fingerprint of the template output.
- `changesShape(kind, prev, next)` compares template fingerprints, so an edit
  to a shape field that does not change the output (e.g. `positions` while in
  single mode) is not a rebuild.
- `actionGraphStatus(action, graph)`:
  `modified = graphFingerprint(graph) ≠ action.templateFingerprint`;
  `templateUpdateAvailable = templateFingerprint(kind, settings) ≠ action.templateFingerprint`;
  `missingGraph` when there is no graph.

## Lifecycle (`backend/src/actions/lifecycle.ts`)

Driven from the `action` binding's persistence tap, so it holds for REST,
tabs, undo and redo alike. The binding sets `withPrev`, which reads the
previous row back from SQLite before the save and hands it to `onSaved`.

| Committed change | Effect |
|---|---|
| create (no previous row) | Nothing structural — the creator writes the graph next to the action (REST `create`, the editor in one batch). The graph's own tap starts it. |
| value setting | `logicManager.setActionSettings` swaps the running graph's settings in place; `settings` nodes resolve config live, so the next pull sees the new value. The graph is not written. |
| shape setting, graph **unmodified** (its fingerprint equals the previous `templateFingerprint`) | Graph rebuilt from the template; `templateFingerprint` follows. |
| shape setting, graph **modified** | Graph kept; the action then reads "template update available". The backend never discards user edits on its own — only a writer that confirmed it does (the editor writes the rebuilt graph itself; REST callers use reset). |
| shape setting, graph already equals the new template (the writer rebuilt it) | Only the fingerprint is made consistent. |
| `enabled` toggled | `logicManager.reconcileOwnedBy('action', id)` starts / stops the graph. |
| remove | The tap's `removeTree` removes the graph; its own tap stops it. |

`reset(id)` rewrites the graph from the template for the current settings
(creating it if missing) and sets the fingerprint.

`bootSync()` (called in `index.ts` after the mesh hydrated, before
`logicManager.startAllEnabled()`): for each action, a missing graph is
created; an unmodified graph whose template output changed is regenerated; a
graph that already equals the current template only gets its fingerprint
aligned; a modified graph is left alone.

## Running (`logic/manager.ts`)

- `startAllEnabled` includes `owner_kind = 'action'`; `start` skips an action
  graph whose action is missing or disabled.
- `_resolveProjectId` resolves an action graph's project through
  `actions.project_id`, so `iterateNodes` routing (overlive, hotkeys, OBS,
  Phase-1 trigger nodes) and `_projectId` injection work in action graphs.
- `settings` nodes in an action graph get `_settings` = the action's current
  settings (held per running graph, replaced in place by `setActionSettings`).
- `validateDescriptor`: `settings` is allowed only when `ownerKind` is
  `action` (Behaviors run their graphs in their managers, not here);
  `behavior_id` stays forbidden in all Logic; `scene_entity` is not allowed in
  action graphs (no owner entity).

### Hotkey kind

Settings: `shortcut {key, ctrl, shift, alt, meta}` (value), `mode`
`single | toggle | cycle` (shape), `positions` 2–8 (shape; used in cycle mode),
`responses.<i>` per position with `type` (shape) and the type's fields (value).
Responses are the Macros panel's set (`RESPONSE_TYPES`, same ids, sinks and
fields as `macros/actionRegistry.ts`): `play_clip` → `start_clip`, `spawn_clip`,
`set_expression`, `set_property` → `set_scene_node_param`,
`set_layer_property` → `set_compose_layer_param`, `control_media` →
`media_control`.

Template:

```
settings(shortcut.key|ctrl|shift|alt|meta) ──value──▶ system_hotkey (id hotkey)
system_hotkey.event ─▶ [cycle (count = 2 | positions), out<i>] ─▶ response_<i>.fire
settings(responses.<i>.<field>) ──value──▶ response_<i>.<field>
```

A position without a response type leaves that output unconnected.

Two supporting changes make the template work through ports only:

- `HotkeyManager` resolves a hotkey node's combo with
  `logicManager.pullInput` (wired port, else inline config — the engine's
  ordinary value-input resolution; `SignalGraph.pullInput`), so a combo wired
  from a `settings` node matches. Before, it read only `defaultConfig`.
- `media_control` has an `action` value input (falls back to `config.action`,
  so existing graphs are unchanged).

## REST (`routes/actions.ts`)

| Method + path | Purpose |
|---|---|
| `GET /api/action-kinds` | Kinds with fields (value/shape) and defaults. |
| `GET /api/projects/:projectId/actions` | List, with `graphId`, `modified`, `templateUpdateAvailable`, `missingGraph`. |
| `POST /api/projects/:projectId/actions` | Create (`CreateAction`: `id?`, `kind`, `name?`, `enabled?`, `settings?` merged over the defaults); writes the graph. |
| `GET /api/actions/:id` | One action (same read model). |
| `PUT /api/actions/:id` | `UpdateAction`: `name?`, `enabled?`, `settings?` (deep-merged). Follows the lifecycle table — a modified graph is kept. |
| `POST /api/actions/:id/reset` | Regenerate the graph. |
| `DELETE /api/actions/:id` | Delete the action and its graph. |

All writes go through the mesh collections (mesh.md principle 5). MCP tools for
Actions do not exist yet.

## Editor

### Writes (`frontend/src/mesh/actions.ts`)

- `commitActionCreate(projectId, kind, name)`: action + graph in one batch
  (one undo step), action first so the graph's owner exists when it lands.
- `commitActionSetting(action, path, value)`: a value edit is one field write.
  A shape edit writes `settings` + `templateFingerprint` and then the rebuilt
  graph, in one batch. Undo replays in reverse (graph first), so the server
  sees the restored graph before the restored settings and — the graph not
  matching the then-previous fingerprint — leaves it alone: one undo restores
  the settings and a hand-edited graph.
- `commitActionReset(action)`: graph (+ fingerprint if it changed), one batch.
- `commitActionDelete(id)`: `removeDoc`, i.e. `removeTree` (action + graph).
- `commitActionPatch(id, {name, enabled})`.

### Panel (`components/editor/actions/ActionsPanel.tsx`)

Left-dock tab `actions` (`LeftDockTab`), after Macros. Groups by kind in
`ACTION_KINDS` order with a count and a `HelpButton`; each row has the enable
checkbox, name, badges (Modified / Template update / No graph), the kind's
preview (ids resolved to node / layer / clip names), and Settings, Open graph
(`setActiveLogic`, which switches to the Logic tab), Reset (enabled only when
there is something to reset; confirmed via `useConfirm`) and delete. A shape
edit on a modified graph asks for confirmation first. The Hotkey form reuses
the Macros panel's `ShortcutRecorder`, `FieldEditor` and `effectiveFields`
(exported from `macros/MacrosPanel.tsx` with a `className` handle), so the
field labels still come from the `macros` i18n namespace — they need a new
home when Macros is retired.

The Logic panel lists action graphs under *Scoped Logic*, labelled with the
action's name, so a graph opened from the Actions panel shows as selected.

`vs-` handles: `vs-tab-actions`, `vs-action-add`, `vs-action-add-kind`
(`-hotkey`), `vs-action-enable`, `vs-action-settings`, `vs-action-name`,
`vs-action-shortcut`, `vs-action-mode`, `vs-action-positions`,
`vs-action-response-type`, `vs-action-field` (+ `-<field>`), `vs-action-reset`,
`vs-action-open-graph`, `vs-action-delete`; non-interactive markers
`vs-action-row`, `vs-action-group-<kind>`, `vs-action-preview`,
`vs-action-badge-{modified,template,missing}`. e2e: `e2e/tests/cov-actions.spec.ts`.

## Extending: a new kind

1. Add an `ActionKindDef` to `ACTION_KINDS` in `@vspark/shared/actions`:
   fields (mark every structure-changing field `shape`), defaults, normalize,
   `build` (read value settings ONLY through `settings` nodes; use stable node
   ids — they are part of the fingerprint), and `preview` (i18n keys under the
   `actions` namespace).
2. Add `kinds.<kind>.label` / `.description` and any preview keys to
   `i18n/locales/{en,de}/actions.json`, a `{#<kind>}` section to
   `help/content/{en,de}/actions.md` (the group header's `HelpButton` points at
   it), and a form component rendered from `ActionRow`.
3. Tests: shared build/preview tests, a lifecycle case in
   `backend/test/api.actions.test.ts`, panel coverage in
   `frontend/test/actions.test.tsx`, handles in `cov-actions.spec.ts`.

Changing a template is safe: unmodified graphs are regenerated at the next
boot; modified ones show "Template update".

## Known gaps (observed, not decided)

- Presets and project export do not include Actions.
- Deleting a project (`DELETE /api/projects/:id`, a raw SQL delete) removes
  its `actions` rows through the FK cascade, but not the action graphs'
  `logic` rows (same as project Logic), and the action documents stay in the
  running server's mesh replica until restart.
- The Macros i18n namespace calls responses "actions" (DE "Aktionen"), which
  now collides with the Action concept; the Actions UI says "Response" /
  "Reaktion".

## Cross-references

- [project-graphs.md](project-graphs.md) — Logic, owner kinds, validation.
- [signal-graph.md](signal-graph.md) — the `settings` node, live config.
- [component-managers.md](component-managers.md) — Behaviors (same settings
  node, injected by their managers).
- [mesh.md](mesh.md) — models, tab writes, undo.
- [i18n-help.md](i18n-help.md) — `actions` namespace, help page, vocabulary.
