# Composites

**Status: Implemented** (in `dev`, merge 405d4ff). Plan:
[../plans/composites.md](../plans/composites.md).

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

## Planned (batch 2)

WIP on `feature/stream-widgets`, plan [../plans/stream-widgets.md](../plans/stream-widgets.md):
2D goal, countdown, subathon timer, recent / top and ad break composites, plus the
follow / gift bomb / bits alert triggers, and the signal nodes and `<Countdown>`
feed-template helper they need. The plan's `[decided]` items are the user's; nothing
in it is built yet.

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
  links?, get?/set?, when? }`. `control` is one of text / number / slider / select /
  color / asset / account. `when` hides a setting based on the other settings' values
  (e.g. the account only for platform triggers).
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

Code-defined settings:

- **Alert Trigger** — replaces the queue graph's head node `ev` and its edges
  (`alertTriggerEdges`, `ALERT_TRIGGER_SPECS`). Triggers: donation / tip →
  `overlive_redemption` (tip = `currencyKind: 'tip'`), sub → `overlive_subscription`,
  raid → `overlive_raid`, named → `on_trigger`.
- **Show for** — sets the fade clip's duration and moves the fade-out keyframes; the
  fades keep their length.
- **Gap** — `1 / hz` of the queue's clock.
- **Badge type** — toggles image / video badge visibility and adds / removes the
  clip's video restart marker.
- **Scrolling chat Crossing time** — clip duration plus keyframe move.

## Backend

- **Payloads** — `presets/builtin_presets/composites.ts` (`BUILTIN_COMPOSITES`, ids
  `builtin:composite-alert`, `-chat-overlay`, `-chat-overlay-3d`, `-scrolling-chat`).
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
- **Overlive nodes** — `overlive_subscription` and `overlive_raid` gained a `data` (Any)
  output with the whole event record; raid's also carries `username` / `displayName`
  aliases of the raider so a template written for other events works unchanged. See
  [overlive.md](overlive.md).

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
    (`getBuiltinPreset` + `instantiatePreset`).
  - `CompositeSettings.tsx` — the Settings section and `CompositePartNote`; mounted in
    `ComposeLayerProperties` and `PropertiesPanel`.
  - `CompositeTag.tsx` — the tag on palette tiles and scene / compose tree rows.
- Context menus: **Dissolve** in `ComposeTree` and the `SceneGraph` node menu.
  `ComposeTree` hides "send to 3D" for parts and refuses cross-scene moves of parts.
- `vs-` handles: `vs-palette-composite`, `vs-composite-settings`,
  `vs-composite-setting` (+ `vs-composite-setting-<key>`), `vs-composite-dissolve`,
  `vs-node-ctx-dissolve`.

## i18n + help

Namespace `composites` (EN / DE). Help page `help/content/{en,de}/composites.md`,
anchors `{#composites}` `{#settings}` `{#alert}` `{#chat}` `{#parts}` `{#dissolve}`;
topic registered in `help/docs.ts` after `presets`. The German terms are in the [i18n-help.md](i18n-help.md)
vocabulary table: **Decided (user):** a composite is a *Widget*; Teil, Auflösen
and Benannter Auslöser were chosen by Claude and are not yet confirmed.

## Tests

- shared `packages/shared/test/composites.test.ts`
- backend `packages/backend/test/composites.test.ts`
- frontend `packages/frontend/test/composites.test.tsx`
- e2e `e2e/tests/cov-composites.spec.ts`

## Adding a composite type

1. Add a `CompositeTypeDef` to `packages/shared/src/composites.ts` and register it in
   `COMPOSITE_TYPES`.
2. Add a payload carrying the marker (part ids via `ref()`) to
   `presets/builtin_presets/composites.ts`.
3. Add an entry to `COMPOSITE_DEFS` in `components/editor/composites/compositeModel.ts`.
4. Add i18n keys for the type, its settings and select options
   (`composites:type.<type>`, `composites:group.<group>`,
   `composites:option.<key>.<option>`, …) in EN and DE.
5. Add a section to the help page and anchor it.

## Cross-references

- [presets.md](presets.md) — composites are instantiated through the preset path; id
  substitution remaps the marker's part ids. The imported-graph document-form fix
  (graph descriptors committed keyed, so `descriptor.nodes.<id>…` paths work at once)
  is what lets settings address graph node config right after placement.
- [signal-graph.md](signal-graph.md) — `send_trigger` / `on_trigger` (named trigger),
  `text_format`, the queue / clock nodes the alert graph uses.
- [overlive.md](overlive.md) — the event nodes behind the alert triggers.
- [i18n-help.md](i18n-help.md) — namespace, help page, vocabulary.
- [compose.md](compose.md), [scene-graph.md](scene-graph.md), [track-clips.md](track-clips.md)
  — the part document types.
