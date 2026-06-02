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
- in:  `account` (Account), `channel` (String), `event` (Any — manager delivery)
- out: `update` (Trigger event), `messages` (value — `ChatFeedItem[]`)

`onEvent` stores the delivered snapshot in node state and emits `update`. The
`messages` pull returns the stored snapshot. (The manager re-sends the full
buffer on the next message, so a reconcile that wipes node state self-heals.)

## Generic half (the reusable part)

### `DataChannelManager` — `data_channels/manager.ts`
Sibling of `RuntimeOverrideManager`. In-memory, **keyed by channel name only**
(no sceneId, no targetKind/targetId, no paramPath coercion). Public API:
`init(ws)`, `set(channel, payload)`, `clear(channel)`, `clearAll()`,
`sendSnapshotTo(send)`. WS broadcasts: `data_channel_set {channel, payload}`,
`data_channel_clear {channel}`, `data_channel_snapshot {entries}`.

Channels are **retained** until overwritten or cleared, and re-sent as a snapshot
on every new WS connect (wired in `index.ts`'s `onClientConnected`, alongside the
track-clip + override snapshots) so a freshly-loaded editor/viewer matches
current state.

**Scoping decision (Phase 3):** the plan originally specced scene-scoped
channels, but the motivating producer (`overlive_chat_feed` → `set_data`) is
driven by the OverliveManager firing into **project-scoped graphs**, which have
no scene context (the engine rejects an explicit `scene_entity` there). So the
bus addresses by channel name only; "scene-scoping" is handled naturally on the
frontend — a `feed` layer only mounts (and renders) when its compose scene is the
one being shown. Channel-name uniqueness is the user's responsibility.

**Known limitations** (deferred, as in the plan):
- Whole-payload republish per `set` — no diff/debounce. Fine for chat rates.
- No per-producer teardown clearing (channels are retained like a last value);
  re-publishing replaces, and `clear`/`clearAll` exist for explicit resets.

### `set_data` node — `signal/nodes/set_data.ts`
Generic sibling of `set_text`. in: `fire` (Trigger event), `channel` (String),
`data` (Any — inferred from whatever is wired in). On `fire`, publishes
`data()` to the named channel via `dataChannelManager.set`. The `data` input is a
wildcard, so a record (`pack_event`), a list (`overlive_chat_feed.messages`), or
a scalar all flow through unchanged.

### `feed` compose layer — `ComposeLayerStack.tsx` (`FeedLayer`)
New `ComposeLayerKind` `'feed'` (added to `shared/types.ts`,
`shared/schema.ts`, and the frontend's local `ComposeLayerKind` in
`api/client.ts`; icon + addable entry in `ComposeTree.tsx`; config editor in
`ComposeLayerProperties.tsx`). Config:
- `channel` — which data channel to subscribe to.
- `itemTemplate` — HTML string with `{field}` interpolation (default `{html}`).
- `maxItems` — cap rendered elements (newest kept); `reverse` — flip order.
- `gap`, `justify` — container layout.

Subscribes to `dataChannels[channel]` in the store. Normalises the payload to a
list of records (array → per-element; record → single render; scalar/empty →
nothing), interpolates `{field}` tokens per item, and **sanitises the result
through `TEXT_SANITIZE_OPTS` (DOMPurify)** — the same XSS-safe allow-list the
`text` layer / `text_canvas` use, so emote `<img>`s render and scripts don't.
Stable keys come from each item's `id`, so per-item CSS enter/exit + scrolling
work; per-item animation is left to the user's template + CSS (the layer is a
thin renderer).

### Frontend store + WS — `store/editorStore.ts`, `hooks/useWsSync.ts`
`dataChannels: Record<channel, payload>` slice with `setDataChannel`,
`clearDataChannel`, `replaceDataChannels`, parallel to the runtime-override
slice. `useWsSync` handles `data_channel_set` / `data_channel_clear` /
`data_channel_snapshot`. Shared by `Editor` and `ViewerPage` (both call
`useWsSync` + render `ComposeLayerStack`), so streamed output matches the editor.

## Wiring a chat overlay
1. In a project (or scoped) graph: `overlive_chat_feed` → `set_data`
   (`channel = 'chat'`): wire `update → fire` and `messages → data`.
2. Add a `feed` compose layer, set its `channel` to `chat`, author an
   `itemTemplate` (e.g. `<div><b style="color:{color}">{displayName}</b>: {html}</div>`).
3. Chat arrives → messages append + render; emotes show via the `html` field.

A non-chat payload (a `pack_event` record, a static list) published to a
different channel and rendered through a different template confirms the layer is
data-shape-independent.

## Cross-references
- [overlive.md](overlive.md) — event nodes, account/channel routing the chat
  buffer reuses.
- [runtime-overrides.md](runtime-overrides.md) — the sibling bus this mirrors
  (snapshot-on-connect pattern, `set_text` ↔ `set_data`).
- [compose.md](compose.md) — compose layer model the `feed` layer extends.
- [signal-graph.md](signal-graph.md) — node model, `Any`/wildcard typing.
