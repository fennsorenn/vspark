# Plan: Actions — preauthored, project-level workflows (+ the nodes they need)

> **Status:** design-only — decided with the user 2026-11-06, not started.
> **Follows:** the Macros panel (`components/editor/macros/`, PR #59), which this
> supersedes once the Actions panel reaches parity (see Phase 3).

> Branch: `feature/actions`
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Goal

Streamers should be able to set up common stream automations — a chat command that
replies with a counter, a hotkey that plays a clip, an emote combo that triggers an
animation — from a settings form, without understanding Logic graphs. These
**Actions** are to the project what **Behaviors** are to an object: a preauthored
workflow per kind, configured by a form, whose Logic graph stays fully editable. Along
the way, the signal graph gains the general-purpose nodes these workflows need
(regex, if/else, cooldown, text format, variables, cross-graph triggers, combos).

## Constraints

### Concept and naming

- **[decided]** The name is **Actions** (DE: "Aktionen"). Not "Behaviors": a Behavior
  is attached to an object; an Action belongs to the project.
- **[decided]** An Action is an *interface over a preauthored workflow*, like a
  Behavior: each kind ships a graph template; the form edits settings, which the graph
  reads through a config node. The underlying Logic graph is **always editable**.
- **[decided]** When the graph differs from the template it was generated from, the UI
  shows a **"Modified" badge** and a **Reset** button (with confirmation) that
  regenerates it — for transparency.
- **[decided]** Settings come in two classes:
  - *value settings* (shortcut, reply text, clip, cooldown seconds, …) reach the graph
    through config nodes, live, and never touch the graph structure;
  - *shape settings* (response type, number of cycle positions, toggle vs cycle, …)
    regenerate the graph from the template. On an unmodified graph that happens
    silently; on a modified one the form warns that the change rebuilds the graph and
    discards the edits, and requires confirmation (same as Reset).
- **[decided]** Storage: a separate `actions` table, **strongly coupled** to one Logic
  graph per Action. Plain Logic rows must not carry empty action fields. The coupling
  is **ownership**: the graph is a `logic` row with `owner_kind = 'action'`,
  `owner_id = <action id>`, so the canvas, mesh sync, undo, validation and
  LogicManager's event routing are all reused, and deleting the Action deletes its
  graph.
- **[decided]** The graph is **stored** (not generated on load). *Proposed, not
  decided:* store a fingerprint of the template output it was generated from; on boot,
  regenerate graphs whose current fingerprint still equals the stored one so
  unmodified Actions follow template updates, and show "template update available" on
  modified ones. Leave node positions out of the fingerprint so tidying the canvas
  does not count as a modification.
- **[decided]** **Behaviors get the same treatment** in this effort: stored, editable
  graph, Modified badge, Reset.
- **[decided]** The **Macros panel is retired** once the Actions panel is at least as
  convenient for hotkeys (parity list in Phase 3) — not before.

### Signal-graph node principles (the user's standing design rules)

- **[decided]** Nodes do one step and are reusable across pipelines. Most are pure
  functions: compute outputs from inputs when pulled; no hidden state, no side effects.
- **[decided]** Events are for things outside the pipeline (chat messages, key
  presses, timers firing) and for nodes at the boundary that act on the outside
  world. Internal data flows over value (pull) edges, not event chains.
- **[decided]** No implicit configuration: everything a node depends on is an input
  port (inline literal, config node, or a wired constant).

### Node decisions

- **[decided]** Regex is a pure node; gating is a **separate if/else node** (event in +
  Bool → `then` / `else` event outs), reusable for any condition.
- **[decided]** Variables and cross-graph triggers are **project-wide** for now; finer
  scoping (per graph/object/user ownership) is deferred.
- **[decided]** Variables get an optional **`scope`** input to avoid collisions: empty =
  the shared user namespace; templates use their own scope. A graph-local variable uses
  the **Logic graph id** as scope, read from a new node (see `logic_id` below).
- **[decided]** **Shared cooldowns**: the cooldown node takes an optional **group**; a
  named group stores its "last fired" time in a variable, so several commands using
  the same group share one cooldown.
- **[decided]** Combos are **two separate node kinds** — threshold and timeout — and
  templates use both, wired from the same trigger.

### Kinds

- **[decided]** First version: **Hotkey** (incl. toggle/cycle), **Chat command**
  (incl. shared cooldown), **Chat pattern**, **Chat keyword**, **Keyword combo**,
  **Redemption**.
- **[decided]** Dropped: Timer. Deferred: alerts (see Out of scope).
- **[decided]** Alerts need a display surface, so they belong on an entity: Actions
  emit named triggers with a payload; a future "Alert" Behavior on an entity reacts
  to them.

### Observed (true of the code today; change if the work calls for it)

- **[observed]** Behavior graphs are **not editable today**: each kind's template is
  code-generated at boot and never stored (`behaviors/<kind>/graph.ts`, descriptor
  marked `readonly: true`; see migration 023's header comment). The managers build the
  graph with `SignalGraph.fromDescriptor` and also feed live data into it (UDP,
  landmarks, interceptors), so Behavior graphs must keep running in their managers,
  not in LogicManager.
- **[observed]** `behavior_config` reads a dotted field from `_behaviorConfig`, which
  the behavior manager injects into the node's config at resolve time.
  `LogicManager` rejects `behavior_config` / `behavior_id` in every Logic graph
  (`ALWAYS_FORBIDDEN_CONTEXT_KINDS`, `logic/manager.ts`).
- **[observed]** Chat, hotkey and OBS events reach graphs by iterating
  `logicManager.iterateNodes()` (`overlive/manager.ts`, `hotkeys/manager.ts`,
  `obs/manager.ts`). Behavior graphs are not in that iteration, so they do not receive
  those events.
- **[observed]** Logic ownership is polymorphic: `logic.owner_kind` is free text
  (`project` / `scene_node` / `compose_layer`; table created as `graphs` in migration
  014). Logic is a mesh model (`packages/shared/src/models.ts`); writes from tabs go
  through `frontend/src/mesh/logicWrites.ts`, including `commitGraphDiff` (node/edge
  diff as one undo step).
- **[observed]** `overlive_send_chat` already sends chat with a `${field}` template over
  user-added input ports (shared dynamic-port mechanism with `set_data`). Overlive
  trigger nodes expose an event plus pulled value outputs (`overlive_chat_command`:
  username, displayName, command, args, text, isMod, isSub, isBroadcaster;
  `overlive_chat_message`: text, html, isMod, isSub, …; `overlive_redemption`:
  rewardId, rewardTitle, message, amount, …).
- **[observed]** Existing building blocks: `cycle` (dynamic event-outs + persisted index,
  `static persistState`), `system_hotkey`, `clock`, `queue_events`, `pack_event` /
  `unpack_event` (dynamic ports), `media_control`, `set_expression`, `start_clip`,
  `set_scene_node_param`, `set_compose_layer_param`. Node state persists per graph in
  `logic.node_state` only for nodes that declare `static persistState`.
- **[observed]** The Macros panel's response set (`macros/actionRegistry.ts`):
  play_clip, set_expression, set_property, set_layer_property, spawn_clip,
  control_media; plus toggle and cycle rows (built on `cycle`).
- **[observed]** No regex, if/else, cooldown, text-format, variable, cross-graph trigger,
  combo or graph-id node exists yet. Next migration number is 045.

## Files in scope

- `packages/backend/src/signal/nodes/` — new nodes (Phase 1); `registry.ts`;
  `packages/shared/src/infer_nodes.ts` for nodes with dynamic ports.
- `packages/shared/src/models.ts` — new mesh models (`action`, `variable`).
- `packages/backend/src/db/migrations/045_*` — `actions` table, variables table if
  persisted outside the mesh docs, behavior graph storage (Phase 4).
- `packages/backend/src/actions/` (new) — template registry, fingerprint, lifecycle
  (create → generate graph, shape-setting changes, boot-time regeneration).
- `packages/shared/src/actions.ts` (new; add the `@vspark/shared` subpath in all four
  resolver configs: package.json exports, tsconfig paths, vite + vitest aliases,
  `bundle.mjs`) — kind metadata, settings schemas, template builders, fingerprint, so
  the frontend can preview and the backend runs the same thing.
- `packages/backend/src/logic/manager.ts` — `owner_kind = 'action'`; allow the settings
  config node only in action-owned graphs; inject the Action's settings.
- `packages/backend/src/behaviors/*` — Phase 4: load the stored graph instead of the
  template; same fingerprint / badge / reset.
- `packages/frontend/src/components/editor/actions/` (new) — Actions panel (left dock),
  per-kind settings forms, Modified badge, Reset, Open graph.
- `packages/frontend/src/components/editor/macros/` — reuse the shortcut recorder and
  response field editors; delete the rest after parity.
- `packages/frontend/src/i18n/locales/{en,de}/` + `help/content/{en,de}/` — new
  namespace, help page, vocabulary table entry (`dev-notes/modules/i18n-help.md`).
- Tests: backend node tests (`buildGraph`), route/lifecycle tests (`makeTestApp`),
  frontend store/hook tests, Playwright `cov-*.spec.ts` for every new `vs-` control.

## Out of scope

- **Alerts** and the "Alert" Behavior that reacts to triggers. This also needs
  Behaviors attachable to compose layers (today only `/api/scene-nodes/:id/behaviors`)
  and trigger routing into Behavior graphs.
- **Timer** Actions (dropped).
- Finer variable / trigger scoping (per object, per user ownership), per-user
  cooldowns.
- Other Action kinds discussed but not chosen: buttons/webhooks (Stream Deck), OBS /
  stream-state triggers, tracking-loss triggers.

## Approach

### Phase 1 — Nodes (each independently useful in plain Logic)

| Node | Ports | Notes |
|---|---|---|
| `regex` | in: `text`, `pattern`, `flags` → out: `matched` (Bool), one String per capture group, `groups` (record of named groups) | Pure. Named groups give named outputs; unnamed ones `group1…n`. Outputs are derived from the pattern, so they appear in the editor only when the pattern is an inline literal. The `groups` record lets fixed templates use whatever groups a user's pattern defines. Invalid pattern → `matched` false, logged once. |
| `if_else` | in: event, `condition` (Bool) → out: `then`, `else` events | The generic gate. |
| `cooldown` | in: event, `seconds`, `group` (optional) → out: event (passes), `blocked` event | Empty group = private to the node; named group = "last fired" stored in a project variable, shared. |
| `text_format` | in: `template`, user-added field ports, `values` (record, optional) → out: `text` | Pure. Same `${field}` syntax as `overlive_send_chat`; extract that templating into shared code and reuse it. `values` fields are usable in the template next to the named ports. |
| `variable` (get) | in: `name`, `scope` → out: `value` | Pure read. |
| `set_variable`, `increment_variable` | in: event, `name`, `scope`, `value` / `by`, `persistent` → out: event, `value` (after) | Boundary nodes. Increments run in the backend, which is the only writer of graph-driven changes, so concurrent increments can't lose updates. |
| `send_trigger` | in: event, `name`, `payload` (any, e.g. from `pack_event`) | Project-wide. |
| `on_trigger` | in: `name` → out: event, `payload` | Routed like hotkeys/overlive via `logicManager.iterateNodes()`. |
| `combo_threshold` | in: event, `threshold`, `window` (s), `key` (optional) → out: `reached` event, `count` | Each counted hit restarts the window; `reached` fires once per combo; the count resets when the window runs out. |
| `combo_timeout` | in: event, `timeout` (s), `key` (optional) → out: `ended` event, `count` (final) | `ended` fires on every expiry, also below any threshold — gate with if/else. |
| `logic_id` | out: `id` | The running graph's id, for graph-local variable scope. |
| `equals`, `chat_rank` | pure helpers | `chat_rank`: isSub/isMod/isBroadcaster + minimum rank → Bool. |

Combo `key` semantics (*proposed*): when a key is wired, a repeated key neither counts
nor extends the window; unwired, every event counts. Feed it the chatter's username for
"unique chatters".

Variables (*proposed*): one mesh document per (project, scope, name). Persistent ones
are committed and persisted; short-lived ones ride the `runtime` channel (retained,
not persisted, gone on restart). The UI can then list and reset counters live, and
group template-internal ones (scope = a graph id) under their Action. Deleting a
graph deletes the variables in its scope.

### Phase 2 — Actions core

1. `actions` table + `action` mesh model: id, project, kind, name, enabled, settings
   (JSON), template fingerprint; its graph is the `logic` row owned by it.
2. Template registry in shared code: per kind — label, icon, settings schema with each
   field marked value vs shape, default settings, `build(shapeSettings) →
   GraphDescriptor`.
3. **[decided]** One **shared settings node** for Behaviors and Actions: it reads a
   dotted field of the settings of whatever owns the graph, injected by the manager
   running it (behavior managers for Behaviors, LogicManager for
   `owner_kind = 'action'`). Generalize `behavior_config` (palette label "Settings")
   rather than adding a second kind; renaming its kind id is cheap now because Behavior
   graphs are not stored yet and Logic has always rejected it — do it before Phase 4
   starts storing Behavior graphs. Allowed only in graphs that have an owner with
   settings (Behaviors, action-owned Logic).
4. Lifecycle: create → build + store graph + fingerprint; shape-setting change →
   rebuild (with the modified-graph confirmation in the UI); Reset → rebuild; boot →
   regenerate unmodified graphs whose template changed.
5. Actions panel (left dock): list with enable toggle, add (pick kind), settings form,
   Modified / "template update available" badges, Reset (confirm), Open graph, delete.
   **[decided]** The list is **grouped by kind by default**, and each row renders a
   **preview of its most important settings** (e.g. the key combo for a Hotkey, the
   command and reply for a Chat command, the keyword and threshold for a combo), so all
   hotkeys can be overseen at a glance. Each kind declares its preview in the template
   registry. i18n EN+DE, help page with anchors, `HelpButton`s, `vs-` handles.

### Phase 3 — Kinds

Every kind: name, enabled, its settings, the shared frame from Phase 2.

- **Hotkey** — shortcut (Macros' recorder); mode *single / toggle / cycle* (shape);
  per position a response from the Macros set (type = shape, its fields = value);
  optional chat message. Template: `system_hotkey` → (`cycle`) → response sinks.
  **Parity with Macros before retiring it**: list with per-row enable toggle, inline
  shortcut recording, quick add, response picker with typed value controls (incl. the
  paramPath-typed property value), toggle and cycle, delete, Open graph. Existing
  Macros graphs stay as plain Logic; no migration (no released data).
- **Chat command** — command + aliases, minimum rank, cooldown seconds + optional
  cooldown group, reply text (`{user}`, `{args}`, `{count}`, plus named regex groups),
  optional counter (variable name, step, persistent), optional "args must match
  pattern". Template: `overlive_chat_command` → `chat_rank` → if/else → `cooldown` →
  [`regex` on args → if/else] → [`increment_variable`] → `text_format` →
  `overlive_send_chat`.
- **Chat pattern** — like Chat command, but triggered by any chat message
  (`overlive_chat_message`) whose full text matches a required pattern; named groups
  become reply/payload fields. Use case: `"<quote>" - <character>. <year>` → fields
  `quote`, `character`, `year`. Separate kind; shares the chat command template code.
- **Chat keyword** — keywords / emote names (whole word, case-insensitive), a response
  (sound via `media_control` on an audio object or layer, animation, emit trigger, …),
  cooldown + optional group.
- **Keyword combo** — keyword, threshold, window/timeout, "unique chatters" (wires the
  username into `key`), response on reached, optional chat message on end with the
  final count. Template: keyword match → `combo_threshold` + `combo_timeout`.
- **Redemption** — reward (entered as text for now), a response like Hotkey's,
  optional chat reply (`{user}`, `{message}`, `{reward}`), optional counter, optional
  "emit trigger" with the redemption as payload (for future alert Behaviors).

### Phase 4 — Behaviors stored and editable

Store each Behavior's graph and fingerprint (on the behavior row or alongside it);
managers load the stored graph instead of the code template; drop `readonly`; same
Modified badge / Reset / template-update handling as Actions. Existing behaviors are
backfilled from their templates by the migration, so they start unmodified.

## Acceptance / verification

- `pnpm lint` and `pnpm test` pass; coverage gates hold (`test:coverage`).
- Every new node has a `buildGraph` unit test, including: regex groups/record/invalid
  pattern, if/else, cooldown private + shared group, combo key/threshold/timeout timing,
  variable scope isolation and persistence across restart.
- Lifecycle tests: create, value-setting change (graph untouched), shape-setting change
  (rebuilt), modified detection ignores node positions, Reset, boot regeneration of
  unmodified graphs only.
- Playwright: Actions panel CRUD per kind, Modified badge appears after a canvas edit
  and Reset clears it (REST read-back); `controls.mjs bless` for new `vs-` handles.
  Run e2e on isolated ports (`PW_FRONTEND_PORT` / `PW_BACKEND_PORT`).
- Manual: a chat command with counter replies in Twitch chat; a keyword combo fires an
  animation; a hotkey Action toggles and cycles like the old Macros did.

## Output

Open a PR into `dev` when done (phases may land as separate PRs).
