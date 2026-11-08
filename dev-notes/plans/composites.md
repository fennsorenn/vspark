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
  regenerated, so edits made to the parts are never lost.
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
- **[decided]** (user, 2026-11-08) **Keep the old presets** in the preset library
  until the composites are confirmed to replace them adequately.
- **[decided]** (user, 2026-11-08) **One alert type** with a trigger setting:
  donation / tip / sub / raid, plus a **generic trigger** (see open question 1).
- **[decided]** (user, 2026-11-08) **A composite is a parent node like any other.**
  Its parts are always listed as its children in the tree and are edited like any
  other node — there is no closed / opened mode. The one difference: **parts are
  protected from being moved out of place in the hierarchy.**
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

**Missing parts.** If a linked part or graph node is gone (see open question 3),
settings that point at it show as unavailable; nothing else breaks.

### The two templates in this scope

- **Alert** — one type with a **Trigger** setting (donation / tip / sub / raid /
  generic). Changing the trigger replaces the event node at the head of the queue
  graph — a `custom` setting, and the nearest thing to "generation" in this scope.
  The account and filter settings shown depend on the trigger. It contains both the
  image and the video badge. "Badge type" is a `custom` setting
  that toggles which one is visible and which one the fade clip's marker restarts, so
  the image/video variants collapse into one.
  - Settings: Badge type, Badge (image or video asset), Message (placeholder caption),
    Font / size / colour, Sound, Volume, Trigger, Account, Show for (seconds), Gap
    between alerts, trigger-specific filters (reward, tier, gift).
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
- **Tree:** the composite is an ordinary parent row with the tag; its parts are its
  children, selectable and editable like any node. Selecting the composite shows its
  own transform plus a **Settings** section generated from the type.
- **Protected parts:** dragging a part out of the composite (or to another depth
  inside it) is refused, in the tree drag-and-drop and in cut/paste. The rule is also
  enforced by the mesh `validate` guard for scene nodes and compose layers, so REST,
  the assistant and other tabs can't break it either: a write that changes a part's
  `parentId` away from where the composite's `parts` map puts it is refused. What
  else counts as "out of place" is open question 2.
- **Dissolve:** in the context menu and panel; undoable, no confirmation. Lifts the
  protection along with the marker.
- Owned logic graphs and track clips stay visible in their usual places.
- i18n EN + DE for every setting label; a help section (`{#composites}` in the
  relevant help page) with a `HelpButton` next to the Settings section; `vs-` handles
  for the new controls (`vs-composite-dissolve`, `vs-composite-setting-<key>`) and `controls.mjs bless`.

### Backend

The marker is ordinary config data and instantiation is the existing preset path.
The backend's share is the protection guard in the `scene_node` / `compose_layer`
bindings' `validate`. `GET /api/presets/builtin` gains a
`composite` field so the palette can list them.

## Files in scope

- `packages/shared/src/composites.ts` (new) — types, settings, links, read/write
  helpers. Exported via the shared index or a subpath (mind the four resolvers).
- `packages/backend/src/presets/builtin_presets/` — new composite payloads (one
  alert with both badges and the trigger; the chat overlays with the marker and CSS
  custom properties), built with the existing helpers. The current alert and chat
  presets stay as they are.
- `packages/backend/src/mesh/` (`scene_node` / `compose_layer` bindings) — part
  protection in `validate`.
- `packages/backend/src/presets/builtins.ts`, `routes/presets.ts` — `composite` in
  the summary.
- `packages/frontend/src/components/editor/createKinds.ts`, `CreatePalette.tsx`,
  `ComposeTree.tsx`, `SceneGraph.tsx` — listing, tag, refusing drags that move a
  part out of place.
- `packages/frontend/src/components/editor/PropertiesPanel.tsx`,
  `ComposeLayerProperties.tsx` — Settings section (new `CompositeSettings.tsx`).
- `packages/frontend/src/components/editor/ContextMenu.tsx` — Dissolve.
- i18n `locales/{en,de}/*.json`, help content `{en,de}`.
- `dev-notes/modules/presets.md` (or a new `composites.md`), `ARCHITECTURE.md`.

## Out of scope

- User-made composites; exposing arbitrary fields.
- Generation / regeneration of parts from settings (see the decided note above).
- Particle generators (single nodes, nothing to bundle).
- Converting alert or chat presets the user already placed in a project.
- Removing the old alert / chat presets (decided: only after the composites are
  confirmed to replace them).
- MCP tools for composite settings (the assistant can still instantiate the payload
  and edit parts).

## Acceptance / verification

- `pnpm lint`, `pnpm test` green; shared coverage gate holds.
- Shared unit tests: every link kind reads and writes; `custom` "Show for" moves the
  right keyframes; a missing part reads as unavailable.
- Frontend test: changing a setting issues one batched write.
- e2e (isolated ports): create an alert from the palette → change Message and Sound →
  REST read-back of the caption / audio layer; move the caption within the alert
  (allowed); drag it out of the alert (refused, also via REST); switch the trigger →
  the graph's event node changes; dissolve → marker gone, parts unchanged and
  movable.

## Open questions for the user

1. **Generic trigger.** Claude's reading (inferred, not confirmed): an alert that
   isn't tied to a platform event but is fired from elsewhere in vspark with a
   message — e.g. an Action response "Show alert", or a logic node / clip marker
   that sends it a text. Is that what's meant, or something else (e.g. "any Overlive
   event")?
2. **What "out of place" covers.** Proposal: parts can't be moved out of the
   composite or to a different depth; reordering parts among themselves (stacking
   order — e.g. caption above badge) is allowed; other objects may be added into a
   composite and moved out again freely. Confirm or adjust.
3. **Deleting a part.** Protected too (refused until dissolved), or allowed (its
   settings then show as unavailable)?
