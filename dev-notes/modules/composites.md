# Composites

**Status: Implemented** (in `dev`, merge 405d4ff). Plan:
[../plans/composites.md](../plans/composites.md).
**Batch 2 (stream widgets): implemented on `feature/stream-widgets`, not yet merged
to `dev`.** Plan: [../plans/stream-widgets.md](../plans/stream-widgets.md). 3D variants
of the widgets: planned (second pass).

A composite is a built-in template placed as **one object** in the scene tree or the
compose tree, with its own settings ("Message", "Sound", "Show for", …). It is an
ordinary parent node: its parts are its children (plus the logic graphs and track
clips they own) and stay editable as usual. **Dissolving** removes the marker and
leaves the plain group behind.

## Decisions

- **Decided (user, 2026-11-08):** settings are a **live link**. A setting points at
  fields of the composite's parts and writes straight into them; the parts are the
  single source of truth, a setting stores no value of its own, and nothing is
  regenerated. This is "for now" — it may switch to generation (Actions-style
  templates with Modified / Reset) if a future composite needs settings that change
  its structure.
- **Decided (user, 2026-11-08):** built-in composite types only.
- **Decided (user, 2026-11-08):** first scope is alerts + chat overlays; one alert type
  with a trigger setting, including a generic **named trigger** (a consumer of
  `send_trigger` / On Trigger — the "alerts react to named triggers" consumer the
  Actions plan deferred).
- **Decided (user, 2026-11-08):** no separate category — composites sit with the base
  3D objects / 2D layers in the palette, marked with a "composite" tag.
- **Decided (user, 2026-11-08):** a composite is an ordinary parent node. Its parts'
  container and depth do not change and parts cannot be deleted on their own (the
  composite's logic may address them); reordering among siblings is allowed.
  Dissolving lifts both restrictions.
- **Decided (user, 2026-11-08):** the old alert / chat presets are kept until composites
  are confirmed to replace them.
- **Decided (user, 2026-11-08):** part protection lives in the editor + REST, not in the
  sync engine (there is no remove-validation hook in `packages/mesh`).

Batch 2 (stream widgets) — the plan's `[decided]` items are the user's:

- **Decided (user, 2026-11-09):** scope is goals (manual and Twitch-fetched), the
  remaining alert triggers, countdown, subathon timer, recent + top tracking, ad break;
  2D only, 3D as a second pass. (The plan also records, as `[decided]` without a
  date, that redemptions get no widget of their own — alerts and Actions cover them.)
- **Decided (user, 2026-11-09):** no per-second updates from the backend. A timer's
  graph publishes only when its end time changes; the page counts down with the feed
  template's `<Countdown>` helper ([data-channels.md](data-channels.md)).
- **Decided (user, 2026-11-09):** prefer general-purpose nodes (`math`, `clamp`,
  `step_lookup`, `date_time`) plus one small timer-state node (`deadline`); caps and
  stages are computed upstream of it, not inside it. The decision also named an
  `alarm` node; it was not built (`deadline` fires `finished` itself — Claude's call,
  see the plan's Deviations).
- **Decided (user, 2026-11-09):** subathon — per-event amounts configurable; a hard
  limit (the timer never goes past the cap — implemented as a cap on total length,
  which is Claude's reading) and a soft limit as diminishing adds in
  stages, with stage thresholds measured against the timer's **total length**
  (initial time + everything added); the settings UI shows the end time each stage
  corresponds to given the planned start.
- **Decided (user, 2026-11-09):** goals are manual (counted from chosen events, or set
  by hand through a named project variable other graphs and Actions can change) or the
  channel's Twitch goals.
- **Decided (user, 2026-11-09):** recent / top tracking is a `tally` node whose state
  lives in a project variable.
- **Decided (user, 2026-11-09):** tabs may write project variables (the timer buttons,
  a goal set by hand) — see [variables.md](variables.md).
- **Decided (user, 2026-11-09):** a widget's shared variable is unique on creation —
  placing a second goal gives it `goal 2`, not the first goal's `goal`. Timer widgets'
  trigger base names (`countdown start` …) are not made unique (not asked; raised by
  Claude as an open question).
- **Decided (user, 2026-11-09):** variable / trigger-name settings suggest names in
  use and accept new ones — see [variables.md](variables.md#name-suggestions-editor).

## Shared model — `packages/shared/src/composites.ts`

Subpath `@vspark/shared/composites`. Registered in the shared `package.json` exports,
backend + frontend `tsconfig` paths, frontend `vite.config.ts` and `vitest.config.ts`
aliases, and backend `bundle.mjs`.

### Marker

`CompositeMarker { type, parts: role → id }` sits on the **root only**:

| Root rtype | Marker path |
|---|---|
| compose layer | `config.composite` |
| scene node | `properties.composite` |

Scene nodes use `properties`, not `components`, because `components` entries are typed
ECS components. `MARKER_PATH` holds the mapping; `compositeMarkerOf` reads it.
`owningComposite` walks up from an entity's parent to find a root whose `parts` list
the id.

### Types

- `CompositeTypeDef { type, rootRtype, parts: role → PartRtype, settings }`, where
  `PartRtype` is `compose_layer | scene_node | logic | track_clip`.
- `CompositeSetting { key, control, group, options?, assetKind?, min/max/step/percent?,
  links?, get?/set?, when?, node?, plan? }`. `control` is one of text / number /
  slider / select / color / asset / account, plus (batch 2) `toggle` (on / off),
  `duration` (seconds edited as H:MM:SS), `stages` (a `{ at, value }` list with
  planning help), `timer` (not a value: Start / Pause / Resume / Reset buttons and the
  time left of a `deadline`) and `variable` (a number kept in a project variable).
  `when` hides a setting based on the other settings' values (e.g. the account only
  for platform triggers). `node: { part, id }` names the graph node (`deadline` or
  Get Variable) whose `name` / `scope` / `persistent` address the variable for
  `timer` / `variable`; a `scope` wired from a `logic_id` node resolves to the graph
  part's id. `plan: { initial, start }` names the setting keys a `stages` control
  reads for its planning help.
  `suggest?: 'trigger' | 'triggerBase' | 'variable'` makes a text setting offer names
  in use (`triggerBase`: the `<base>` of timer trigger sets, via `triggerBases`);
  set on alert `triggerName`, goal `countTrigger` + `variable`, countdown / subathon
  `finishTrigger` + `controlName`.
- `FieldWrite { rtype, id, path, value }` — one dotted-path write on a part document;
  `null` deletes a keyed element.

### Link kinds

1. **Document field** by dotted path. A graph node's config is
   `descriptor.nodes.<nodeId>.defaultConfig.<port>`; clip keyframes are
   `lanes.<lane>.keyframes.<kf>`.
2. **CSS custom property** inside a CSS string field (`cssVar` on the link), via
   `readCssVar` / `writeCssVar`.
3. **Code-defined `get` / `set`** for settings that touch several things at once (see
   the alert and scrolling-chat settings below).

`readSetting` reads the **first** link: `undefined` means the part is gone (the UI shows
"not available"), `null` means the part is there but the field is unset (shown as
empty). `writeSetting` writes to every link that still exists. `settingVisible`
evaluates `when`. `dissolveWrite` produces the write that drops the marker.

### Built-in types (`COMPOSITE_TYPES`)

| Type | Root | Parts |
|---|---|---|
| `alert` (`ALERT_COMPOSITE`) | compose layer | `badgeImage`, `badgeVideo`, `caption`, `sound` (layers), `fade` (track clip), `queue` (logic) |
| `chat_overlay` | compose layer | `panel` (the root itself), `feed` (logic) |
| `chat_overlay_3d` | scene node | `panel`, `feed` (logic) |
| `scrolling_chat` | scene node | `message` (scene node), `scroll` (track clip), `flow` (logic) |
| `goal` | compose layer | `panel` (the root feed layer), `flow` (logic) |
| `countdown` | compose layer | `panel`, `timer` (logic) |
| `subathon` | compose layer | `panel`, `flow` (logic) |
| `recent_events` | compose layer | `panel`, `flow` (logic) |
| `top_supporters` | compose layer | `panel`, `flow` (logic) |
| `ad_break` | compose layer | `panel`, `flow` (logic) |

Code-defined settings:

- **Alert Trigger** — replaces the queue graph's head node `ev` and its edges
  (`alertTriggerEdges`, `ALERT_TRIGGER_SPECS`). Triggers: donation / tip / bits →
  `overlive_redemption` (tip = `currencyKind: 'tip'`, bits = `currencyKind: 'bits'`),
  sub → `overlive_subscription`, gift → `overlive_gift_bomb`, follow →
  `overlive_follow`, raid → `overlive_raid`, named → `on_trigger`. Bits is its own
  trigger, so the donation trigger's currency options no longer list bits.
- **Show for** — sets the fade clip's duration and moves the fade-out keyframes; the
  fades keep their length.
- **Gap** — `1 / hz` of the queue's clock.
- **Badge type** — toggles image / video badge visibility and adds / removes the
  clip's video restart marker.
- **Scrolling chat Crossing time** — clip duration plus keyframe move.

### Stream widgets (batch 2)

Each widget is one `feed` compose layer — the root, playing `panel` — whose template
renders data published by its logic graph through `set_data` (scoped to the root
layer). The look is CSS custom properties `--w-font`, `--w-size`, `--w-color`,
`--w-accent`, `--w-track` in the layer's CSS, addressed by the shared `widgetLook`
settings. Timers keep their state in a `deadline` node's variable and publish its
`state` on `changed`; the template counts down with `<Countdown>`.

| Type | Graph (as built) | Settings |
|---|---|---|
| `goal` | Twitch: `overlive_goal` → `set_data`. Manual: an event source `src` → `increment_variable`, Get Variable `get` (`changed` → publish), `overlive_stream_online` → `set_variable` 0 for per-stream goals. The variable defaults to `goal` in the shared scope, persistent. | source (twitch / manual, swaps edge sets), account, goal kind (Twitch), label, target, current (`variable` control — set by hand), count (none or an event source, swaps `src`), count trigger name (named), variable name, period (stream / always — the reset edge), look |
| `countdown` | `deadline` (variable `countdown`, graph scope, persistent); `date_time` → `duration` in "until" mode; `finished` → `send_trigger`; timer triggers | controls (`timer`), mode (duration / until — the `date_time` edge), duration, until, title, finish trigger name, control name, look |
| `subathon` | Per source: event node → `math` (amount × rate) → `pack_event`; merged by one `unpack_event` → `math` multiply by the `step_lookup` factor of `deadline.total` → `clamp` to `[0, cap − total]` (`math` subtract) → `deadline.add`. `deadline` variable `subathon`, graph scope, persistent; timer triggers | controls, account, initial length, title, per sub / gift / 100 bits / tip / follow, hard cap (0 = none, stored as `NO_CAP`), planned start, stages (`stages` control), control name, look |
| `recent_events` | Per source: event node → `pack_event` (with a config-only `label`) → one `unpack_event` → `tally` (variable `recent`, graph scope, persistent); stream-online → `tally.reset` for per-stream lists | account, show + label per source (follow / sub / gift / bits / tip / raid; `toggle`s over edges), max entries, period, look |
| `top_supporters` | One event source `src` → `tally` (variable `top`); stream-online reset | metric (bits / tip / gift / sub / raid, swaps `src`), account, title, max entries, period, look |
| `ad_break` | `overlive_ad_start` → `deadline.start` with `durationSeconds`; `overlive_ad_end` → `reset`; `deadline` variable `ad`, not persistent | account, message, look |

Notes (observed, as built):

- Timer widgets are controlled by the editor's Start / Pause / Resume / Reset buttons
  (the `timer` control writes the variable directly) and by named triggers
  `<base> start | pause | resume | reset` (`on_trigger` nodes `tStart` … `tReset`);
  the base is the `controlName` setting.
- Subs count without gifted ones (`isGift: 'false'`); a gift bomb is its own event and
  adds per gifted sub (Twitch also sends one sub per recipient, which would count
  twice). The subathon's sub rate does not weight sub tiers (known limitation).
- The subathon graph is a loop (`deadline.total` feeds the add into the same
  `deadline`); it needs the inference fixpoint in
  [signal-graph.md](signal-graph.md).
- The goal's variable is in the shared scope (no `logic_id` wired), so two manual goal
  widgets left at the default name `goal` share one count (inferred from the payload,
  not tested). That is also what lets other graphs and Actions change it by name.

Shared helpers in `composites.ts` for these definitions:

- `EVENT_SOURCES` / `EVENT_SOURCE_SPECS` — events a widget can count or list (follow,
  sub, gift, bits, tip, raid, named) with each one's node kind, default config, user
  output and amount output; `readSource` maps a graph node back to its source.
- `swapNodeWrites(graphId, graphDoc, nodeId, next, edges)` — replace (or remove) a
  graph node and its edges; the account carries over between platform nodes.
- `edgeToggleWrites(graphId, graphDoc, edges, on)` — make a set of edges present or
  absent (the basis of the select / toggle settings that switch a graph's wiring).
- `gEdge(...)` — edge shorthand; `NO_CAP` — the stored "no hard cap" value (1e9 s).

## Backend

- **Payloads** — `presets/builtin_presets/composites.ts` (`BUILTIN_COMPOSITES`, ids
  `builtin:composite-alert`, `-chat-overlay`, `-chat-overlay-3d`, `-scrolling-chat`,
  `-goal`, `-countdown`, `-subathon`, `-recent-events`, `-top-supporters`,
  `-ad-break`).
  Part ids inside the marker are written with `ref()`, so the preset id substitution
  remaps them on instantiation ([presets.md](presets.md)). The alert carries both
  badges and a `text_format` node `fmt` that builds the caption from a Message
  template with the event record as values, and `${payload}` for named triggers.
- **Lookup** — `presets/builtins.ts` `getBuiltinPreset` also resolves composite ids.
  `GET /api/presets/composites` (registered before `/presets/:id`) lists them for the
  palette. Composites are **not** in `GET /api/presets/builtin` (the preset library)
  and not in the MCP `list_presets` tool — a known gap, out of scope for this round.
- **Guard** — `composites/guard.ts`:
  - `guardPartMove` is called from the `scene_node` and `compose_layer` mesh bindings'
    `validate` (which now receives `prev`); it refuses a change of `parentId` / root
    for a listed part, for every writer.
  - `partDeleteRefusal` is used by `DELETE /api/scene-nodes/:id` and
    `DELETE /api/compose-layers/:id` → 409, code `COMPOSITE_PART`.
  - The PUT routes map a move refusal to 409 too (`refusalStatus`).
- **Overlive nodes** — `overlive_subscription`, `overlive_raid`, `overlive_follow` and
  `overlive_gift_bomb` have a `data` (Any) output with the whole event record; raid's
  and gift bomb's also carry `username` / `displayName` aliases (raider / gifter) so a
  template written for other events works unchanged. The goal widget uses
  `overlive_goal`. See [overlive.md](overlive.md).

## Frontend

- `mesh/composites.ts` — marker reads (`compositeOf`, `isCompositeRoot`,
  `owningCompositeId`), `partMoveBlocked` / `refusePartMove` / `partDeleteBlocked`
  (with toasts), `dissolveComposite`, `compositeView`, and `commitSettingWrites` (one
  `meshBatch`).
- The write helpers in `mesh/writes.ts` and `mesh/layerWrites.ts` check on every move
  (patch / path containing `parentId`) and every delete. Delete-keeping-children on a
  composite root drops the marker in the same batch. `commitPromoteLayerToNode`
  refuses a part.
- `components/editor/composites/`:
  - `compositeModel.ts` — `COMPOSITE_DEFS` (palette entries) and `placeComposite`
    (`getBuiltinPreset` + `instantiatePreset`). A def's `uniqueVariable` (goal:
    `'goal'`) makes `placeComposite` rename the payload's shared-scope variable nodes
    to `uniqueName(...)` of the names in use (`renameVariable`).
  - `CompositeSettings.tsx` — the Settings section and `CompositePartNote`; mounted in
    `ComposeLayerProperties` and `PropertiesPanel`. Its header carries a per-type
    `HelpButton` (`TYPE_ANCHOR`: type → help anchor).
  - `CompositeControls.tsx` — the batch-2 controls: `DurationInput`
    (`parseDuration` / `formatDuration`), `TimerControl` (applies `deadlineOps` from
    `@vspark/shared/variables` to the timer's variable; in "until" mode Start computes
    the length from the wired `date_time` text), `VariableControl` (a number in a
    variable; writes where it already lives, a new one persistent), `StagesControl`
    (stage list + the end time each threshold corresponds to, from the initial length
    and planned start). Variable reads / writes go through `mesh/variables.ts`
    ([variables.md](variables.md)).
  - `CompositeTag.tsx` — the tag on palette tiles and scene / compose tree rows.
- Context menus: **Dissolve** in `ComposeTree` and the `SceneGraph` node menu.
  `ComposeTree` hides "send to 3D" for parts and refuses cross-scene moves of parts.
- `vs-` handles: `vs-palette-composite`, `vs-composite-settings`,
  `vs-composite-setting` (+ `vs-composite-setting-<key>`), `vs-composite-dissolve`,
  `vs-node-ctx-dissolve`, `vs-composite-timer-start` / `-pause` / `-resume` /
  `-reset` / `-time`, `vs-composite-stage-add` / `-at` / `-factor` / `-remove`.

## i18n + help

Namespace `composites` (EN / DE). Help page `help/content/{en,de}/composites.md`,
anchors `{#composites}` `{#settings}` `{#alert}` `{#chat}` `{#widgets}` (sub-anchors
`{#goal}` `{#countdown}` `{#subathon}` `{#recent}` `{#top}` `{#adbreak}`) `{#parts}`
`{#dissolve}`;
topic registered in `help/docs.ts` after `presets`. The German terms are in the [i18n-help.md](i18n-help.md)
vocabulary table: **Decided (user):** a composite is a *Widget*; Teil, Auflösen
and Benannter Auslöser were chosen by Claude and are not yet confirmed.

## Tests

- shared `packages/shared/test/composites.test.ts` (+ `variables.test.ts`, inference
  additions)
- backend `packages/backend/test/composites.test.ts` (each widget places, and every
  select / toggle setting keeps a valid, running graph) and
  `packages/backend/test/nodes.widgets.test.ts` (the new nodes)
- frontend `packages/frontend/test/composites.test.tsx`, `names.test.tsx`
- e2e `e2e/tests/cov-composites.spec.ts` (third test: timer buttons, stages, goal by
  hand, list toggles; a second goal gets `goal 2` and its variable input suggests
  `goal`)

## Adding a composite type

1. Add a `CompositeTypeDef` to `packages/shared/src/composites.ts` and register it in
   `COMPOSITE_TYPES`.
2. Add a payload carrying the marker (part ids via `ref()`) to
   `presets/builtin_presets/composites.ts`.
3. Add an entry to `COMPOSITE_DEFS` in `components/editor/composites/compositeModel.ts`.
4. Add i18n keys for the type, its settings and select options
   (`composites:type.<type>`, `composites:group.<group>`,
   `composites:option.<key>.<option>`, …) in EN and DE.
5. Add a section to the help page and anchor it; map the type to the anchor in
   `TYPE_ANCHOR` (`CompositeSettings.tsx`).
6. For a setting that switches graph wiring, build it from `edgeToggleWrites` /
   `swapNodeWrites`, and extend the backend composites test so every option leaves a
   running graph.

## Cross-references

- [presets.md](presets.md) — composites are instantiated through the preset path; id
  substitution remaps the marker's part ids. The imported-graph document-form fix
  (graph descriptors committed keyed, so `descriptor.nodes.<id>…` paths work at once)
  is what lets settings address graph node config right after placement.
- [signal-graph.md](signal-graph.md) — `send_trigger` / `on_trigger` (named trigger),
  `text_format`, the queue / clock nodes the alert graph uses; `deadline`, `tally`,
  `math`, `clamp`, `step_lookup`, `date_time` behind the widgets.
- [variables.md](variables.md) — where timer / tally / goal state lives; tab writes.
- [data-channels.md](data-channels.md) — `set_data`, the `feed` layer, `<Countdown>`.
- [overlive.md](overlive.md) — the event nodes behind the alert triggers.
- [i18n-help.md](i18n-help.md) — namespace, help page, vocabulary.
- [compose.md](compose.md), [scene-graph.md](scene-graph.md), [track-clips.md](track-clips.md)
  — the part document types.
