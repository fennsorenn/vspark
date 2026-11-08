# Actions

**Status: Implemented (core + all six kinds: Hotkey, Chat command, Chat
pattern, Chat keyword, Keyword combo, Redemption).** See
[plans/actions.md](../plans/actions.md). The Macros panel is still present
(retiring it awaits the user trying the Actions panel; the parity additions
are under "Panel" below). Behaviors getting the same stored-graph treatment
(Phase 4) is implemented — see
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
| `packages/frontend/src/components/editor/actions/` | `ActionsPanel` (left-dock tab), the per-kind forms (`HotkeyForm`, `ChatForms` for the chat / redemption kinds) their shared fields (`fields.tsx`: account / rank / cooldown / counter / template fields, `ResponseEditor`) and input primitives (`draftInputs.tsx`: `DraftText` / `DraftNumber` commit on blur / Enter, `SettingCheck`). |
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

## Kinds

### Derived settings (`settings.derived`)

Some values a graph needs are functions of what the form edits: a regex built
from a command and its aliases, a counter's scope that depends on whether it is
named. A kind's `normalize` computes them into `settings.derived`, where
`settings` nodes read them like any other value setting (they are value
settings — `derived` is declared `value`). Because the backend normalizes every
action write (`guardAction`), they are always consistent with the edited
fields; the editor's `commitActionSetting` also writes `settings.derived` next
to a value edit when it changes (same batch, one undo step), so the running
graph does not wait for the server's correction. The form never edits them.
(Implementation choice of Phase 3, not a user decision: it keeps every typical
edit a value edit without adding node kinds.)

Two derived values are *templates* rendered by a `text_format` node, which is
how a fixed graph picks between two values without a select node:
`derived.counterScope` (`''` = shared, `'${id}'` with `logic_id` wired into the
`id` field = graph-local) and `derived.comboKey` (`'${user}'` with the
chatter's username = unique chatters, `''` = every message).

### Account

The chat / redemption kinds have an `account` value setting (empty = the
project's default overlive account), wired into the trigger node's `account`
port and the outbound nodes' `account` ports. Two supporting changes make that
work through ports (see [overlive.md](overlive.md)):

- `OverliveManager` resolves a trigger node's `account` / `channel` with
  `logicManager.pullInput` (wired port, else inline config), like the
  HotkeyManager does for combos.
- `overlive_send_chat` and `overlive_redemption_status` fall back to the
  project's default account when their account is empty (`acctOrDefault`).
  The other outbound overlive nodes are unchanged.

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


### Shared pieces of the chat / redemption kinds

Every optional part sits in a **fixed** structure switched by a value setting,
so no typical edit rebuilds the graph; the only shape setting in these kinds is
a response's `type`.

- **Rank gate** (`addRankGate`): `chat_rank(isSub, isMod, isBroadcaster ←
  trigger; minRank ← settings)` → `if_else`.
- **Cooldown** (`addCooldown`): `cooldown(seconds, group ← settings
  cooldown.*)`. An empty group is private to the node; a named group is
  shared across graphs (the cooldown node's `__cooldown/<group>` variable).
- **Counter + reply** (`addCounterReply`):
  `if_else(counter.enabled)` → then `increment_variable` → `done` → send;
  else → send. The counter variable is `derived.counterName` (`name` or
  `count`) in the scope rendered from `derived.counterScope` — an unnamed
  counter is graph-local (scope = graph id, cleaned up with the graph), a
  named one shared (scope `''`). The reply is a `text_format` (template ←
  `reply`; fields per kind + `count` ← a `variable` read of the counter;
  `values` ← the regex `groups` record, so named groups are placeholders)
  feeding `overlive_send_chat.template`; an empty reply sends nothing.
  Placeholders use the existing `${name}` syntax of `text_format` /
  `overlive_send_chat` (the plan wrote `{user}`; inferred to mean the
  placeholder names).
- **Single response** (`addSingleResponse`): the Hotkey response set at
  `response.<field>` (`response.type` = shape), sink id `response`.
- **Trigger**: `send_trigger(name ← settings trigger)`; an empty name sends
  nothing.

Settings normalization: `minRank` ∈ `everyone|sub|mod|broadcaster`;
`cooldown {seconds ≥ 0, group}` (default 10 s for the chat kinds);
`counter {enabled=false, name='', step=1, persistent=true}`.

| Kind | Settings (all value unless marked) | Template | Preview |
|---|---|---|---|
| `chat_command` | `account`, `command`, `aliases` (space/comma list), `minRank`, `cooldown`, `argsPattern`, `counter`, `reply`; derived `commandPattern`, `counterName`, `counterScope` | `overlive_chat_command` (command filter empty) → `regex(command, derived.commandPattern, i)` gate → rank gate → args: `equals(argsPattern, '')` skips, else `regex(args, argsPattern, i)` gate → cooldown → counter + reply (fields `user` ← displayName, `args`; `values` ← args groups) | headline `!hug !cuddle` + rank / cooldown / counter tokens; lines: quoted reply, args pattern |
| `chat_pattern` | `account`, `pattern`, `minRank`, `cooldown`, `counter`, `reply`; derived `fullPattern` (`^(?:pattern)$`), counter values | `overlive_chat_message` → `regex(text, fullPattern, i)` gate → rank gate → cooldown → counter + reply (fields `user`, `message`; `values` ← groups) | `/pattern/` + meta; reply |
| `chat_keyword` | `account`, `keywords` (comma list), `cooldown`, `response` (**`response.type` shape**), `trigger`; derived `keywordPattern` | `overlive_chat_message` → `regex(text, keywordPattern, iu)` gate → cooldown → response + `send_trigger` (payload ← the message's `data` record) | keywords + cooldown; response line, trigger line |
| `keyword_combo` | `account`, `keywords`, `threshold` (≥ 1), `window` (s), `uniqueChatters`, `response` (**type shape**), `endMessage`; derived `keywordPattern`, `comboKey` | keyword gate → `combo_threshold` + `combo_timeout` from the same hit (same `window`, key ← `text_format(derived.comboKey, user ← username)`); `reached` → response and `set_variable(comboReached = true)` (graph-local, short-lived); `ended` → `if_else(variable comboReached)` → clear + `overlive_send_chat(text_format(endMessage, count ← final count))` | keywords + `N× within S s` + unique; response, end message |
| `redemption` | `account`, `reward` (title), `response` (**type shape**), `counter`, `reply`, `trigger`, `markComplete`; derived `rewardPattern`, counter values | `overlive_redemption` → `regex(rewardTitle, rewardPattern, i)` gate → response; counter + reply (fields `user`, `message`, `reward`); `send_trigger` (payload ← the redemption's `data` record); `if_else(markComplete)` → `overlive_redemption_status(rewardId, redemptionId, status FULFILLED)` | reward + counter + complete; response, reply, trigger |

Matching details (in `@vspark/shared/actions`): command names drop a leading
`!` and duplicates; keywords match as whole words (`(?<![\p{L}\p{N}_])` …
`(?![\p{L}\p{N}_])`, flags `iu`, so emotes such as `:)` work and phrases match
across any whitespace); a reward matches its title exactly, case-insensitive,
surrounding spaces ignored; an empty command / keyword list / pattern / reward
never matches (the regex node treats `''` as no match). The Chat pattern
anchors the user's pattern to the whole message.

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
- `commitActionSetting(action, path, value)`: a value edit is one field write
  (plus `settings.derived` when the edit changes it, in the same batch).
  A shape edit writes `settings` + `templateFingerprint` and then the rebuilt
  graph, in one batch. Undo replays in reverse (graph first), so the server
  sees the restored graph before the restored settings and — the graph not
  matching the then-previous fingerprint — leaves it alone: one undo restores
  the settings and a hand-edited graph.
- `commitActionReset(action)`: graph (+ fingerprint if it changed), one batch.
- `commitActionDelete(id)`: `removeDoc`, i.e. `removeTree` (action + graph).
- `commitActionPatch(id, {name, enabled})`.

### Panel (`components/editor/actions/ActionsPanel.tsx`)

Left-dock tab `actions` (`LeftDockTab`), after Macros. The tab is split like
Logic: the list in the left dock (`ActionsPanel.tsx`), the selected action's
settings in the main view (`ActionEditor.tsx`, rendered by `Editor.tsx` when
`leftTab === 'actions'`). **Decided** (the user): the list is a list with a
preview of the most important settings, and the settings live in the main
view; a row keeps only the enable toggle as a control.

The list groups by kind in `ACTION_KINDS` order with a count and a
`HelpButton`. **Decided** (the user): one line per action. A row has the
enable checkbox, the name, the kind's preview on the same line (headline, then
each line after `→`; ids resolved to node / layer / clip names; cut off with an
ellipsis, the full text as tooltip) and the status (Modified / Template update
/ No graph) as coloured dots with tooltips. There is no small-screen layout;
the user mentioned a two-line row on small devices as a possible exception. Clicking a row sets `activeActionId` in the editor store
(in memory, not persisted). The editor shows the kind, name and badges, an
enabled toggle, the name field and the kind's form, then Open graph
(`setActiveLogic`, which switches to the Logic tab), Reset (enabled only when
there is something to reset; confirmed via `useConfirm`) and delete (which
clears the selection). Without a selection, or when the selected action is
gone, it shows an empty state. A shape edit on a modified graph asks for
confirmation first. Shared pieces (preview, badges, name field, render
boundary) are in `actions/parts.tsx`. The Hotkey form reuses
the Macros panel's `ShortcutRecorder`, `FieldEditor` and `effectiveFields`
(exported from `macros/MacrosPanel.tsx` with a `className` handle), so the
field labels still come from the `macros` i18n namespace — they need a new
home when Macros is retired.

The Logic panel lists action graphs in their own *Action Logic* section
(between Scoped Logic and Behavior Logic; **decided** by the user), one row per
action with a graph, in the Actions list's order (kind, then creation), labelled
with the action's name and kind, so a graph opened from the Actions panel shows
as selected. The row's dot switches the action itself (`enabled` on the
action, re-enabling the graph document too if it was off).

Other panel behaviour (added for Hotkey parity with Macros): each group header
has a `+` that adds another action of that kind in one click; a newly added
action is selected, so its settings open in the main view. (An inline
shortcut recorder in Hotkey rows existed briefly; it went with the move of the
settings to the main view.)

The chat / redemption forms (`ChatForms.tsx`) commit text and number fields on
blur / Enter (`DraftText` / `DraftNumber`), so typing a reply is one write and
one undo step. The primitives take the caller's `vs-` handle as `className`;
like the numeric inputs they are registered in `COMPONENTS` of
`e2e/scripts/controls.mjs` (their call sites count as controls) and their file
is excluded in `e2e/coverage-ignore.json`. The account select lists the editor store's `overliveAccounts`
with "Default account" (empty) first.

`vs-` handles: `vs-tab-actions`, `vs-action-add`, `vs-action-add-kind`
(`-<kind>`), `vs-action-group-add`, `vs-action-enable`, `vs-action-row` (select),
`vs-action-editor-enable`, `vs-action-name`, `vs-action-shortcut`,
`vs-action-mode`, `vs-action-positions`, `vs-action-response-type`,
`vs-action-field` (+ `-<field>`), `vs-action-account`, `vs-action-command`,
`vs-action-aliases`, `vs-action-min-rank`, `vs-action-cooldown-seconds`,
`vs-action-cooldown-group`, `vs-action-args-pattern`,
`vs-action-counter-enabled`, `vs-action-counter-name`,
`vs-action-counter-step`, `vs-action-counter-persistent`, `vs-action-reply`,
`vs-action-pattern`, `vs-action-keywords`, `vs-action-trigger`,
`vs-action-threshold`, `vs-action-window`, `vs-action-unique`,
`vs-action-end-message`, `vs-action-reward`, `vs-action-mark-complete`,
`vs-action-reset`, `vs-action-open-graph`, `vs-action-delete`; non-interactive
markers `vs-action-row`, `vs-action-group-<kind>`, `vs-action-preview`,
`vs-action-form`, `vs-action-response`,
`vs-action-badge-{modified,template,missing}`. e2e:
`e2e/tests/cov-actions.spec.ts` (core + Hotkey) and
`e2e/tests/cov-actions-kinds.spec.ts` (the other kinds + parity additions).

## Extending: a new kind

1. Add an `ActionKindDef` to `ACTION_KINDS` in `@vspark/shared/actions`:
   fields (mark every structure-changing field `shape`), defaults, normalize,
   `build` (read value settings ONLY through `settings` nodes; use stable node
   ids — they are part of the fingerprint), and `preview` (i18n keys under the
   `actions` namespace).
   Values the graph needs that are computed from edited fields go into
   `settings.derived` from `normalize`; optional parts are gated with
   `if_else` on a value setting rather than made shape settings. The `Tpl`
   builder and the `add*` helpers cover the chat / redemption pieces.
2. Add `kinds.<kind>.label` / `.description` and any preview keys to
   `i18n/locales/{en,de}/actions.json`, a `{#<kind>}` section to
   `help/content/{en,de}/actions.md` (the group header's `HelpButton` points at
   it), and a form component (register chat-like forms in `CHAT_FORMS`).
3. Tests: shared build/preview tests (`shared/test/actions*.test.ts`), a run
   through the engine with simulated events (`backend/test/actions.kinds.test.ts`
   delivers overlive events through `OverliveManager`'s routing), panel coverage
   in `frontend/test/actions*.test.tsx`, handles in `cov-actions*.spec.ts`.

Changing a template is safe: unmodified graphs are regenerated at the next
boot; modified ones show "Template update".

## Known gaps (observed, not decided)

- Row previews show a counter's name, not its live value (tabs do not open the
  variable collections yet — see [variables.md](variables.md)).
- The Redemption reward is matched by title only (not by reward id) and the
  form has no reward picker; "mark complete" only works for rewards created by
  the same Twitch app (a Twitch API rule).
- A Chat keyword / Redemption trigger payload is the trigger node's `data`
  record; the Keyword combo emits no trigger.
- `overlive_send_chat` renders `${name}` placeholders again in the already
  formatted reply, so a `${word}` typed by a chatter (e.g. in `${args}`) is
  blanked.

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
