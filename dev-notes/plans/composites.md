# Plan: Composites — built-in templates as objects with their own settings

> **Status:** design-only
> Branch: `feature/composites` (off `dev`)
> This plan is the seed context for an implementation session. It is a starting point,
> not an airtight spec — the open questions at the end need the user's answer first.

## Goal

Some built-in presets are really one thing made of several parts. The Donation Alert
is a group holding a badge, a caption, a hidden sound layer, a fade clip and a queue
graph. Today the user drops the preset and then hunts through the tree, the
properties of four layers, a track clip and a logic graph to change the message, the
sound or the account.

A **composite** packages such a template as one object in the tree with its own
settings ("Sound", "Message", "Account", "Show for", …), the same way a base object
or an Action presents settings instead of internals. It can be **opened** to edit
the parts directly (move the caption, change its font) and **dissolved** into the
plain group the preset produces today, for customising it further.

## Constraints

- **[decided]** (user, 2026-11-08) **Live link, not generation.** A composite's
  settings point at fields of its parts and write straight into them. The parts are
  the single source of truth; a setting has no stored value of its own. Nothing is
  regenerated, so edits made inside an opened composite are never lost.
- **[decided]** (user, 2026-11-08) Record that we **may switch to generation** (a
  kind template builds the parts from settings, with Modified / Reset as Actions do)
  if a future composite needs settings that change its structure. Live link is "for
  now", not a rule.
- **[decided]** (user, 2026-11-08) **Built-in types only.** No user-made composites
  and no "expose this field" flow.
- **[decided]** (user, 2026-11-08) **First scope:** the event alerts
  (Donation / Tip / Sub / Raid) and the chat overlays (2D feed layer, 3D feed node,
  scrolling 3D chat).
- **[decided]** (user, 2026-11-08) **No separate category.** Composites sit alongside
  the 3D objects and 2D layers (create palette, tree), marked with a _composite_ tag.
  The word "Component" is not used for them.
- **[observed]** Built-in presets are `vspark.preset.v2` payloads in
  `packages/backend/src/presets/builtin_presets/` (`alerts.ts`, `chat.ts`), served by
  `GET /api/presets/builtin[/:id]` and instantiated by `POST /api/presets/instantiate`.
  Instantiation commits every entity through the mesh store, and **id placeholder
  substitution is occurrence-based** (`presets/substitute.ts`): any real id anywhere
  in a payload is remapped on export and re-bound on import. See
  [`../modules/presets.md`](../modules/presets.md).
- **[observed]** Each alert ships twice (image badge / video badge), so there are 8
  alert presets.
- **[observed]** `peer.batch(fn)` groups writes into one undo action (plans
  README, "Undo logs on the peer that authors a committed write").
- **[observed]** The chat overlays' look lives in a feed layer's `css` string
  (`FEED_CHAT_CSS` in `builtin_presets/helpers.ts`), not in separate config fields.
- **[observed]** Adding a `@vspark/shared` subpath needs four resolver configs
  (package exports, tsconfig paths, vite alias, `bundle.mjs` alias); `tsc` only
  catches one of them.

## Proposed design

Everything in this section is a **proposal** (Claude, 2026-11-08), not a decision.

### What marks a composite

One field on the root entity and nothing on the parts:

```ts
// compose layer: config.composite   ·   scene node: components.composite
composite: {
  type: 'alert',            // the built-in type id
  parts: {                  // role → id of the entity playing it
    caption: '<layer id>',
    badgeImage: '<layer id>',
    badgeVideo: '<layer id>',
    sound: '<layer id>',
    fade: '<track clip id>',
    queue: '<logic id>',
  },
}
```

- The ids in `parts` are ordinary ids inside the payload, so the existing placeholder
  substitution remaps them on instantiate, copy/paste and save-as-preset — no new
  remapping code.
- **Dissolve** = delete `composite` from the root, in one undo step. What is left is
  exactly the plain preset output.
- No migration and no new table.

### Composite types (shared)

`packages/shared/src/composites.ts` declares each type: id, root kind
(`compose_layer` / `scene_node`), icon, i18n key, the parts' roles, and its
**settings**. Each setting is a list of **links**, one per kind of target:

| Link kind   | Target                                                              | Example                                                      |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `partField` | a field of a part (`config.content`, `config.fontSize`, `x`, asset) | Message, Font size, Badge image, Sound                       |
| `graphNode` | a field of a node's config in an owned logic graph                  | Account, reward filter, gap between alerts                   |
| `cssVar`    | a CSS custom property declared in a feed layer's `css`              | Chat font, bubble colour                                     |
| `custom`    | code-defined `get(parts) / set(parts, value) → writes`              | "Show for" (moves two keyframes + clip length), "Badge type" |

Reading a setting reads its first link; writing one writes every link in a single
`peer.batch`, so one change is one undo step. Built-in only means the `custom`
getters/setters can live in code.

**Missing parts.** If the user opens a composite and deletes a linked part or graph
node, settings that point at it show as unavailable; nothing else breaks.

### The two templates in this scope

- **Alert** — one type with an "Event" setting (donation / tip / sub / raid) instead
  of four types, _or_ four types sharing one definition (open question 2). It
  contains both the image and the video badge. "Badge type" is a `custom` setting
  that toggles which one is visible and which one the fade clip's marker restarts, so
  the image/video variants collapse into one.
  - Settings: Badge type, Badge (image or video asset), Message (placeholder caption),
    Font / size / colour, Sound, Volume, Account, Show for (seconds), Gap between
    alerts, event-specific filters (reward, tier, gift).
- **Chat overlay** (2D feed layer, 3D feed node) — settings: Account, Max messages,
  Font, Text colour, Bubble colour. The built-in `FEED_CHAT_CSS` gets rewritten to
  read CSS custom properties so `cssVar` links have something to write.
- **Scrolling chat (3D)** — settings: Account, Scroll speed (clip length), spawn area
  (the two `random` nodes' ranges), Font / colour of the text template.

The payloads keep being built by the existing helpers in `builtin_presets/`; a
composite is a builtin payload plus the `composite` marker on its root.

### Editor

- **Create palette, scene tree, compose tree:** composites are listed with the base
  kinds they belong next to (alert and chat overlay with 2D layers; 3D chat with 3D
  objects), with a small _composite_ tag. Creating one instantiates its payload.
- **Closed (default):** one row in the tree with the tag; its parts are not listed.
  Clicking it in the viewport or compose view selects the composite. The properties
  panel shows its own transform plus a **Settings** section generated from the type.
- **Open:** a button on the row / in the panel (and double-click) shows the parts as
  ordinary children that can be selected and edited. Open/closed is view state — not
  saved, not undoable.
- **Dissolve:** in the context menu and panel; undoable, no confirmation.
- Owned logic graphs and track clips stay visible in their usual places.
- i18n EN + DE for every setting label; a help section (`{#composites}` in the
  relevant help page) with a `HelpButton` next to the Settings section; `vs-` handles
  for the new controls (`vs-composite-open`, `vs-composite-dissolve`,
  `vs-composite-setting-<key>`) and `controls.mjs bless`.

### Backend

The backend needs almost nothing: the marker is ordinary config data, and
instantiation is the existing preset path. `GET /api/presets/builtin` gains a
`composite` field so the palette can list them.

## Files in scope

- `packages/shared/src/composites.ts` (new) — types, settings, links, read/write
  helpers. Exported via the shared index or a subpath (mind the four resolvers).
- `packages/backend/src/presets/builtin_presets/{alerts,chat,helpers}.ts` — add the
  marker; merge image/video alerts; CSS custom properties in `FEED_CHAT_CSS`.
- `packages/backend/src/presets/builtins.ts`, `routes/presets.ts` — `composite` in
  the summary.
- `packages/frontend/src/components/editor/createKinds.ts`, `CreatePalette.tsx`,
  `ComposeTree.tsx`, `SceneGraph.tsx` — listing, tag, closed/open rows.
- `packages/frontend/src/components/editor/PropertiesPanel.tsx`,
  `ComposeLayerProperties.tsx` — Settings section (new `CompositeSettings.tsx`).
- `packages/frontend/src/components/editor/ContextMenu.tsx` — Open / Dissolve.
- Selection / hit-testing in the viewport and compose view — select the root while
  closed.
- i18n `locales/{en,de}/*.json`, help content `{en,de}`.
- `dev-notes/modules/presets.md` (or a new `composites.md`), `ARCHITECTURE.md`.

## Out of scope

- User-made composites; exposing arbitrary fields.
- Generation / regeneration of parts from settings (see the decided note above).
- Particle generators (single nodes, nothing to bundle).
- Converting alert or chat presets the user already placed in a project.
- MCP tools for composite settings (the assistant can still instantiate the payload
  and edit parts).

## Acceptance / verification

- `pnpm lint`, `pnpm test` green; shared coverage gate holds.
- Shared unit tests: every link kind reads and writes; `custom` "Show for" moves the
  right keyframes; a missing part reads as unavailable.
- Frontend test: changing a setting issues one batched write.
- e2e (isolated ports): create an alert from the palette → change Message and Sound →
  REST read-back of the caption / audio layer; open → move the caption; dissolve →
  marker gone, parts unchanged.

## Open questions for the user

1. **Old presets.** Once the alert and chat composites exist, remove the matching
   built-in presets from the preset library (the composite plus Dissolve gives the
   same result), or keep both?
2. **Alerts: one type or four?** One "Alert" composite with an Event setting, or
   separate Donation / Tip / Sub / Raid entries in the palette? (Switching the event
   changes the graph's event node kind — under live link that would be a `custom`
   setting replacing one graph node, the nearest thing to "generation" in this scope.)
3. **Opening.** Should an opened composite close again when the selection leaves it,
   or stay open until closed?
