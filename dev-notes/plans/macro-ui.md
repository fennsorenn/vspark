# Plan: Macro UI — a friendly projection over hotkey→action logic graphs

> Branch: `feature/macro-ui` (builds on the `system_hotkey` node + `HotkeyManager`
> already merged) · Status: Stage 1 (backend vocabulary) landed; frontend stages pending
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Progress

- **Stage 1 — backend vocabulary: DONE.** `cycle` node (dynamic event-outs +
  persisted index; first node to use dynamic event-outs, so `NodeBindContext`
  gained a `selfId` field along the way), `set_expression` node (thin wrapper
  over `broadcastBus.publishBlendshapes`, producer id from `selfId`, slot
  released in `onUnbind`), and the `visible` Bool paramPath for both target
  kinds with consumers in `Viewport.tsx` (scene nodes) and `ComposeLayerStack.tsx`
  (compose layers), override-wins over the persisted flag. Unit + paramPath tests
  added; full monorepo lint + tests green. Registry is now 89 node kinds.
- **Stages 2–4 (Action Registry, projection, Macros panel, i18n/e2e): pending.**

## Goal

Make setting up a bunch of hotkey macros pleasant without leaving the power of the
signal graph behind. Ship a form-based **Macros** panel that reads as
"When I press [shortcut] → [do action]", backed entirely by the existing Logic
graph substrate. The panel is **UX sugar only**: it is a live, bidirectional
*projection* of the underlying `system_hotkey → action` graphs — it introduces no
new execution engine and no new persistence.

## Context / how we got here

The `system_hotkey` node + `HotkeyManager` (already merged) give us system-wide
hotkeys as a Logic input node. Authoring many macros by hand-wiring nodes on the
canvas is clunky. The graph editor is the wrong *interface* for macros but the
right *engine*, so we build a friendly front-end that compiles to — and reads back
from — the same graphs.

### Decisions locked with the user

1. **The macro UI owns zero state; it is derived from the logic descriptors.**
   The binding must be **bidirectional**: any change made on the graph canvas maps
   back into the macro UI, and vice versa. The only way to *guarantee* "never out
   of sync" is to not store the projection at all — compute it from the descriptors
   already kept live in the store (mesh feeder, incl. remote edits). Editing a
   macro row mutates the same descriptor the canvas edits.

2. **The projection is total and conservative.** Every `system_hotkey` node
   projects to exactly one row (nothing is hidden from the macro view). A row is
   either **fully modeled** (its chain exactly matches a known shape → inline
   editor) or **opaque** ("Multiple Actions / Custom" chip → read-only summary +
   "Open in graph editor"). A row is never silently dropped or half-edited. The
   classifier must be *strict*: only claim "modeled" when the round-trip is
   lossless; the moment the graph grows something we don't model, the row degrades
   to the chip rather than going stale.

3. **The action layer is the real work, not a veneer.** Setting *what happens* is
   the harder half — most actions need configuration, and we have no UI-component
   ↔ node-action mapping yet. This plan treats it as first-class (see the Action
   Registry below).

4. **Toggle is a general `cycle` node**, not a special case. One `Event<T>` in → N
   `Event<T>` outs, advancing the active output each fire. N=2 is toggle. The macro
   recognizer understands `hotkey → cycle → [action per output]` and renders it as
   a multi-state row. The node is independently useful (round-robin avatar/scene
   swaps), so it earns its place regardless of the macro UI.

5. **Expression-setting is cheap, via the existing broadcast bus.** `api_controller`
   already sets expressions at runtime through `broadcastBus.publishBlendshapes`
   (producer slot per `(nodeId, behaviorId)`, summed+clamped per tick, sticky until
   changed), and the `blendshapes_broadcast` node exposes the same bus to graphs.
   So a "set expression" macro action is a thin node over a proven path — not new
   infrastructure. The bus's sticky-slot model is a *feature* here: it pairs
   naturally with the cycle node (press → Happy=1, press again → 0/clear).

## The bidirectional contract (core mechanism)

Each action is **one Action Registry entry** that is both directions at once:

```ts
interface MacroActionDef {
  id: string            // 'play_clip'
  labelKey: string      // i18n → "Play clip"
  fields: MacroField[]  // controls the inline editor renders (pickers/number/enum)
  // graph → UI (read-back / point 1). Returns extracted field values or null if
  // this def does not exactly describe the given sink node + its inputs.
  match(node, graph): Record<string, unknown> | null
  // UI → graph (edit). Produces the node(s) + edges to splice into the descriptor.
  build(values): { nodes: DescNode[]; edges: DescEdge[]; sinkNodeId: string }
}
```

`match` and `build` **must be inverses** — a per-action property test asserts
`match(build(v)) === v`. That single pair defines the inline editor *and* the
read-back, so bidirectionality and the config UI are the same mechanism. Lean on
existing registries/components rather than re-describing everything:

- `set_*_param` actions derive their value control from **`paramPaths.ts`** (type +
  default + applicable kinds).
- Reuse the node-card pickers: `SceneEntitySelect` (scene-node / compose-layer),
  the clip picker, `AccountSelect` shape, etc.
- The expression picker reads the VRM expression list from **asset metadata**
  (already surfaced per `node.filePath`), with `api_controller._expressionsByNode`
  as the live fallback.

## Files in scope

### Backend — new action vocabulary (the genuine gaps)

- `packages/backend/src/signal/nodes/cycle.ts` — **new node** `cycle`. Dynamic
  outputs `out0…outN-1: Event<T>` (N editable on the card, like `pack_event`),
  single `in: Event<T>`. Active index in `getState/setState` (survives
  `reconcile`, cf. `queue_events`). On fire: emit on `out[index]`, then
  `index = (index+1) % N`. Register in `registry.ts`; add an `INFER_BY_KIND` entry
  so every output mirrors the resolved `in` type (cf. `enqueue → popped`).
- `packages/backend/src/signal/nodes/set_expression.ts` — **new node**
  `set_expression`. Config/inputs: target `nodeId` (SceneNode), `expression`
  (String), `weight` (Float). On fire, publishes to `broadcastBus.publishBlendshapes`.
  Fused single-sink node (not a `make_blendshape → broadcast` chain) so the macro
  recognizer sees one recognizable sink and round-trips losslessly. Resolve the
  **producer key** for standalone Logic (no behavior): use the logic/node id as a
  stable `behaviorId`-equivalent, and ensure the slot is cleared on graph stop
  (hook `dispose()` / node teardown → `broadcastBus.removeBehavior`-style cleanup).
- `packages/shared/src/paramPaths.ts` — add a **`visible` Bool paramPath** for
  `scene_node` (and compose-layer equivalent if it maps cleanly) so "show / hide"
  is addressable. Wire the consumer that applies it (runtime-override bus →
  Viewport visibility, mirroring how `opacity` is applied). Confirm whether a
  scene-node "hidden" flag already exists and whether this should drive it vs. a
  parallel runtime-only visibility.

### Frontend — the Macros panel + registry

- `packages/frontend/src/components/editor/macros/actionRegistry.ts` — the
  `MacroActionDef` table (`play_clip`, `set_property`, `control_media`,
  `send_to_feed`, `set_expression`, `set_visible`). Each with `fields` + `match` +
  `build`.
- `packages/frontend/src/components/editor/macros/projection.ts` — pure functions:
  descriptor(s) → macro rows. Classify each `system_hotkey`: no sink → incomplete;
  one modeled sink → modeled row; `hotkey → cycle → [modeled sinks]` → multi-state
  row; anything else → opaque. Strict/lossless; unknown ⇒ opaque.
- `packages/frontend/src/components/editor/macros/MacrosPanel.tsx` — the row list +
  "Add macro", inline action editor (renders `fields`), per-row enable toggle
  (reuses logic `enabled`), and an "Open in graph editor" escape hatch. Edits go
  through `build`/splice → PUT the descriptor via the existing logic routes.
- `packages/frontend/src/components/editor/macros/ShortcutRecorder.tsx` — click-to-
  record shortcut control. Captures `KeyboardEvent.code` + modifier booleans.
- `packages/frontend/src/components/editor/macros/keymap.ts` — **static translation
  table** from browser `KeyboardEvent.code` (`"KeyA"`, `"F8"`, `"Digit1"`) →
  `node-global-key-listener` key names (`"A"`, `"F8"`, `"1"`). Applied when saving
  a macro's `system_hotkey` config. This is the one genuinely fiddly bit — get it
  right cross-platform.
- Mount the panel in the left-dock Logic area next to `LogicSection`; add to the
  store's tab/section wiring as needed.
- i18n + help: new keys in `macros`/`signalGraph` namespaces (EN + DE); extend
  `help/content/{en,de}/logic.md` with a "Macros" section + a `HelpButton` on the
  panel. Node labels for `cycle` / `set_expression` follow the backend-metadata
  (English) convention like every other node.

### Tests

- Backend: `cycle` (round-robin + index survives reconcile), `set_expression`
  (publishes correct weights / clears slot on stop), `visible` paramPath coercion +
  apply.
- Frontend/shared: `match(build(v)) === v` round-trip per action def; projection
  classifier (modeled vs. cycle vs. opaque, incl. multi-sink → opaque); keymap
  covers the common keys.
- e2e: add `vs-` handles to the new controls, `controls.mjs bless`, exercise
  add-macro / edit-action / open-in-graph in a `cov-*.spec.ts`.

## Out of scope

- Non-hotkey triggers in the Macros panel (chat/redemption → action). The
  projection could later generalize the "trigger" half, but v1 is hotkeys only.
- Multi-node action *chains* beyond a single sink or a single `cycle` (those stay
  "Custom / open in graph").
- Cycle auto-reset (snap-back after N seconds / explicit `reset` input) — additive
  later.
- Macro import/export as presets (the existing presets system could carry them, but
  not part of v1).

## Approach (staged)

1. **Backend vocabulary first** (unblocks everything, independently useful):
   `cycle` node, `set_expression` node (+ producer-id/cleanup), `visible`
   paramPath + consumer. Land with unit tests.
2. **Action Registry + projection** as pure, well-tested modules (no UI yet).
   Nail the `match`/`build` inverse property.
3. **Macros panel** wired to the registry + projection; shortcut recorder + keymap;
   escape hatch to the canvas.
4. **i18n/help + e2e/coverage**, then polish (empty states, "Multiple Actions"
   summaries, per-row enable).

## Acceptance / verification

- `pnpm lint` + `pnpm test` green; new backend nodes covered; `match(build(v))`
  round-trips for every action def.
- Editing a macro row and editing the same graph on the canvas stay in sync in both
  directions (manual check with two views open); a graph the panel can't model
  shows "Multiple Actions", never a stale/blank row.
- A macro created in the panel fires its action when the hotkey is pressed
  (manual, on a machine where the OS hook is available).
- Toggle works via a 2-output `cycle`; "set expression" holds until toggled/cleared.

## Output

Open a PR into `dev` when done.
