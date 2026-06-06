# Data Channels + Template Feed Layer

Phase 3. A generic, data-shape-independent path for publishing arbitrary
structured data from the signal graph to the frontend, rendered through a
user-authored template. The motivating use is an internal **chat overlay**, but
only the chat *history store* and its feed node are chat-specific — everything
from the publish step onward is reusable for alert tickers, event logs,
scoreboards, poll results, etc.

## Pipeline

```
OverliveManager (owns a bounded chat ring-buffer; chat-specific)
  → overlive_chat_feed node: `update` event + `messages` list (pull)   [chat-specific]
  → [graph: optional filter / transform / gate nodes]                   [generic, optional]
  → set_data node: publishes a payload to a NAMED data channel          [generic]
  → DataChannelManager → WS `data_channel_set`                          [generic]
  → frontend Zustand `dataChannels` slice (useWsSync)                   [generic]
  → `feed` compose layer: renders the payload through a template        [generic]
```

## Chat-specific half

### Chat ring-buffer — `overlive/manager.ts`
`OverliveManager` keeps a bounded ring-buffer of recent `ChatFeedItem`s **per
account** (`chatBuffers: Map<accountId, ChatFeedItem[]>`, capped at
`CHAT_BUFFER_MAX = 200`). On every `chat.message` event (`routeEvent` →
`pushChatAndNotifyFeed`) it appends a `ChatFeedItem` (the `overlive_chat_message`
per-message shape **plus** `id` = platform messageId for stable React keys,
`channel`, and `timestamp`) and evicts the oldest beyond the cap.

Durable history lives **here**, not in graph node state — node state is
per-instance and rebuilt on `reconcile()`, the wrong place for accumulating
history. The feed node is a thin view, mirroring how `overlive_chat_message` is a
thin view over the latest event.

After appending, the manager fires the current buffer snapshot (newest last)
into every matching `overlive_chat_feed` node's `event` input. Account/channel
matching is shared with the plain event nodes via `nodeAcceptsEvent`; an empty
channel filter on the feed node means "all channels for this account", otherwise
the delivered slice is filtered to the matching channel.

### `overlive_chat_feed` node — `signal/nodes/overlive/chat_feed.ts`
- in:  `account` (Account), `channel` (String), `maxLength` (Float),
       `event` (Any — manager delivery)
- out: `update` (Trigger event), `messages` (value — `ChatFeedItem[]`)

`onEvent` trims the delivered snapshot to `maxLength` (input → config →
`DEFAULT_MAX_LENGTH` = 50; the manager `CHAT_BUFFER_MAX` = 500 is the hard
ceiling above it), stores it in node state, and emits `update`. The `messages`
pull returns the stored snapshot. (The manager re-sends the full buffer on the
next message, so a reconcile that wipes node state self-heals.)

## Generic half (the reusable part)

### `DataChannelManager` — `data_channels/manager.ts`
Sibling of `RuntimeOverrideManager`. In-memory, keyed by **`(scope, field)`** —
`scope → Map<field, value>`:
- **scope** — a consumer's id (a compose layer / scene node id), or `''` for
  GLOBAL (visible to every consumer). A consumer reads `global ∪ its-own-id`.
- **field** — one published value's label (the former "channel name"), referenced
  by bare name in templates.

Public API: `init(ws)`, `set(scope, fields)` (**merge** — overwrites the named
fields, leaves others; so two producers sharing a scope don't clobber),
`seed(scope, fields)` (merge only fields not already present), `clear(scope,
field?)`, `clearAll()`, `sendSnapshotTo(send)`. WS broadcasts:
`data_channel_set {scope, fields}`, `data_channel_clear {scope, field?}`,
`data_channel_snapshot {entries: [{scope, fields}]}`.

Scopes/fields are **retained** until cleared, and re-sent as a snapshot on every
new WS connect (wired in `index.ts`'s `onClientConnected`, alongside the
track-clip + override snapshots) so a freshly-loaded editor/viewer matches
current state.

**Scoping model:** the original Phase-3 bus addressed by a single flat channel
name. It was reshaped (still pre-merge) so a `set_data` node exposes multiple
labeled fields and optionally targets one consumer. Producers are
project-scoped automations with no scene context, so the bus can't infer a target —
hence the explicit `scope` (a `SceneEntity` chosen on `set_data`). Unscoped =
global. The consumer side needs no config: a `feed` layer/3D billboard listens on
`global ∪ own-id` by identity, and only mounts when its compose scene is shown.

**Teardown clearing:** when a graph stops or reconciles, the engine calls each
node's `unbind()` (via `SignalGraph.dispose()`, invoked from
`AutomationManager.stop()`); `set_data.onUnbind` clears the fields it published
from every scope it touched (tracked in `_published`). Without this, retired
scoped data lingered on the bus and — because a feed layer merges `global ∪ own`
with **own winning** — a layer's stale own-scope value would shadow new global
data, freezing the layer. (Note: data published before a process restart by a
graph that was already stopped pre-dispose is only cleared by a backend restart,
which resets the in-memory `_scopes`.)

**Known limitations:**
- Whole-value republish per field on each `fire` — no diff/debounce. Fine for
  chat rates.
- Two producers writing the same `(scope, field)` share one slot (last write
  wins); one's teardown clears the shared field. `clear`/`clearAll` exist for
  explicit resets.
- Bare-name template access (`with(channels)`) requires field labels to be valid
  JS identifiers; `set_data` `seed`s declared fields as `null` on bind so a
  reference resolves before the first publish (otherwise a `ReferenceError`,
  which the feed layer swallows to empty and retries on the next update).

### `set_data` node — `signal/nodes/set_data.ts`
Publishes a set of user-defined named **fields** to the bus. Dynamic labeled
input ports work exactly like `pack_event` — `config.fields: string[]` + the
shared `inferSetData` in `shared/infer_nodes.ts` (registered in `INFER_BY_KIND`,
which also flags it `dynamic` so the editor renders the same ports). Static ports:
`fire` (Trigger event) and `scope` (`SceneEntity`). On `fire`, each declared
field's value is read via `this.input(name)` and the whole record is published to
the resolved scope (`scope().id`, else config fallback, else `''`/global) via
`dataChannelManager.set`. `onBind` `seed`s the declared fields as `null` into the
config-resolved scope (see bare-name note above).

The `scope` input is a `SceneEntity` — the generic supertype of the entity-ref
types in `shared/signal.ts` (all three carry a **bare id string** at runtime;
ids are unique across nodes/layers, so the kind isn't needed in the value):

- `SceneNode` — a scene node id (e.g. `scene_entity.nodeId`, the `targetId` of
  `set_scene_node_param` / the `nodeId` of the broadcast nodes).
- `ComposeLayer` — a compose layer id (`set_compose_layer_param.targetId`).
- `SceneEntity` — either; the supertype. `isAssignable` widens `SceneNode` and
  `ComposeLayer` **into** a `SceneEntity` input (asymmetric, like list fan-in;
  see `signal_types.ts`), so any entity output can drive `scope` / `set_text`.

`EntityId` was retired in favour of these three (more precise producers, a
permissive consumer). Unconnected, the node card renders a dropdown
(`SceneEntitySelect` in `SignalNodeCard.tsx`, all three in `STATIC_INPUT_TYPES`)
filtered to the port's type — nodes, layers, or both; the chosen **id string**
lands in `config.scope`, read back via the engine's unconnected→config fallback.
The labeled-field editor (`PackFieldsEditor`) is shown for both `pack_event` and
`set_data`.

### `feed` compose layer — `ComposeLayerStack.tsx` (`FeedLayer`)
New `ComposeLayerKind` `'feed'` (added to `shared/types.ts`,
`shared/schema.ts`, and the frontend's local `ComposeLayerKind` in
`api/client.ts`; icon + addable entry in `ComposeTree.tsx`; config editor in
`ComposeLayerProperties.tsx`). Config is just `template` (a **JSX-ish (htm)
template**) + `css` — **no channel/scope config**: the layer reads the fields
visible to it (`global ∪ its-own-layer-id`) by identity.

**Template engine = `htm`** (`htm.bind(React.createElement)`). The template is
the body of an htm tagged-template literal; `compileTemplate` wraps it in a
`new Function('html','Emote','channels', 'with(channels){ return html`…` }')`
(memoised per source string) and re-renders are cheap. It produces **real React
elements**, so reconciliation keys (`key=${m.id}`) handle per-item enter
animation — no string diffing/morphdom. Every in-scope field is exposed to the
template **by its bare name** via `with(channels)` (a field labeled `chat` →
`${chat.map(...)}`), so the layer stays data-shape-independent and config-free.

Engine choice (Phase 3): we evaluated safe-mdx (MDX→AST, no eval, ~10KB via a
backend-parse split — even patched + measured working) but it **cannot render
JSX produced inside an expression** (`{data.map(m => <div/>)}` throws "visitor
JSXElement is not supported"), so it can't do the per-item loop. react-jsx-parser
does it but is ~90KB and not splittable. htm wins on weight (~0.7KB) + JSX-ish
syntax + the loop; its cost is that templates run via `new Function` (eval).

**Safety:** templates execute as code. Acceptable under vspark's current
local/single-user model — no worse than the `browser` compose layer, which
already runs arbitrary web content. Revisit before any multi-user /
untrusted-preset-import story. The only raw-HTML injection is the per-field
`<Emote html=…>` helper, which DOMPurifies through `TEXT_SANITIZE_OPTS` (the
emote allow-list); all structural markup is real React elements, never an HTML
string. `FeedContent` evaluates the template inside a synchronous `try/catch`
(the htm tag builds its element tree eagerly), so a bare field referenced before
its producer publishes — or a typo — renders as nothing and **retries on the next
update** rather than latching; a `FeedErrorBoundary` (keyed on template source) is
a backstop for any escaped throw. Compile-time syntax errors show a placeholder.

**CSS scoping:** `css` is injected as `<style>@scope ([data-feed-scope="…"]) {
… }</style>` with a per-layer `useId()` scope id, so two feed layers can't
clobber each other's class names (requires the `@scope` at-rule — modern
Chromium / OBS browser source). Dynamic styles go inline in the template
(`style=${{ color: m.color }}`).

### `feed` scene node (3D) — `Viewport.tsx` (`FeedCanvasNode`)

The in-scene (3D) analog of the 2D `feed` compose layer: a `feed` scene
`NodeKind` (added to `shared/types.ts` + `sceneNodeKindSchema`) rendered as a
`THREE.CanvasTexture` on a plane, flat-mounted alongside `text_canvas`. Config
lives under `node.components.feed`: `{ template, css, width, height, padding,
fontSize, color, billboard? }`. Like the 2D layer it's a **config-free
consumer** of the bus by identity — it reads `global ∪ its own node id` (so a
`set_data` node targets it by picking the feed node as its `scope`).

Rendering reuses `text_canvas`'s rasterisation but sources content from the
template, not a param: it renders the htm template into an **off-screen React
root** (`createRoot` into a fixed/off-left host `div`, committed synchronously
via `flushSync`), waits for emote `<img>`s, then `html2canvas` → `drawImage`
onto the CanvasTexture canvas. Going through real React (not an HTML string)
keeps the `<Emote>`/`with(channels)` semantics identical to the 2D layer; going
through `html2canvas` (rather than drei `<Html>`) means it composites into WebGL
and screen recordings. `css` is scoped to the host via `@scope
([data-feed-scope="…"])`, same as the 2D layer. Transform/opacity overrides
apply (`useTransformWithOverride`/`useApplyOpacity`), so it's positionable and
animatable like any scene node. Re-renders on every bus update — fine for chat
rates, like `text_canvas`.

### Shared template engine — `lib/feedTemplate.tsx`

The htm template machinery is shared by both feed surfaces (2D layer + 3D node):
`html` (htm bound to `createElement`), the `Emote` helper, `compileTemplate`
(cached `new Function` compile), `FeedContent` (the try/catch render wrapper),
`FeedErrorBoundary`, and the `FEED_DEFAULT_TEMPLATE`/`FEED_DEFAULT_CSS` chat
defaults. `ComposeLayerStack.FeedLayer`, `Viewport.FeedCanvasNode`,
`ComposeTree`, and `SceneGraph` all import from here.

### Frontend store + WS — `store/editorStore.ts`, `hooks/useWsSync.ts`
`dataChannels: Record<scope, Record<field, value>>` slice with
`mergeDataChannels(scope, fields)`, `clearDataChannels(scope, field?)`,
`replaceDataChannels(entries)`. `useWsSync` handles `data_channel_set` /
`data_channel_clear` / `data_channel_snapshot`. `FeedLayer` selects
`dataChannels['']` and `dataChannels[layer.id]` and merges them (`global ∪ own`).
Shared by `Editor` and `ViewerPage` (both call `useWsSync` + render
`ComposeLayerStack`), so streamed output matches the editor.

## Wiring a chat overlay
1. In a project (or scoped) graph: `overlive_chat_feed` → `set_data`. On
   `set_data`, add a field named `chat`, then wire `feed.update → set_data.fire`
   and `feed.messages → set_data.chat`. Leave `scope` unset for a global overlay,
   or pick this feed layer to make the field private to it.
2. Add a `feed` compose layer (it ships a default chat `template` + `css`). The
   default template loops the bare field:
   `${(chat || []).map((m) => html`<div key=${m.id}>${m.displayName}: <${Emote} html=${m.html} /></div>`)}`.
3. Chat arrives → messages append + render; emotes show via `<Emote>`.

Adding more labeled fields to one `set_data` (e.g. `donors`, `nowPlaying`) makes
them all available to every in-scope template by name, confirming the layer is
data-shape-independent.

## Cross-references
- [overlive.md](overlive.md) — event nodes, account/channel routing the chat
  buffer reuses.
- [runtime-overrides.md](runtime-overrides.md) — the sibling bus this mirrors
  (snapshot-on-connect pattern, `set_text` ↔ `set_data`).
- [compose.md](compose.md) — compose layer model the `feed` layer extends.
- [signal-graph.md](signal-graph.md) — node model, `Any`/wildcard typing.
