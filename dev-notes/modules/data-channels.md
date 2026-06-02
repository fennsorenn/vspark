# Data Channels + Template Feed Layer

**Status: Implemented (Phase 3 of the signal-graph expansion).**

A generic, data-shape-agnostic pipeline that lets a signal graph publish an arbitrary structured payload to a NAMED channel and have the frontend render it through a user-authored template. The motivating feature is an **internal chat overlay** (an accumulating, scrolling list), but only the history store and its feed node are chat-specific — everything from the `set_data` step onward is reusable for alert tickers, event logs, scoreboards, poll results, etc.

## Pipeline

```
OverliveManager (owns a bounded chat ring-buffer; chat-specific)
  → overlive_chat_feed node: `update` event + `messages: List<ChatFeedMessage>` (pull)   [chat-specific]
  → [graph: optional filter / transform / gate nodes]                                     [generic, optional]
  → set_data node: publishes an arbitrary payload to a NAMED data channel                 [generic]
  → DataChannelManager → WS broadcast                                                      [generic]
  → feed compose layer: subscribes to the channel, renders through a template             [generic]
```

The graph stays **in the path** (not bypassed), so chat can be filtered/transformed/gated before render. The template **adapts to the data, not vice versa** — it interpolates whatever fields the published payload carries.

## Chat-specific half

### Chat ring-buffer (`packages/backend/src/overlive/manager.ts`)

The OverliveManager owns the durable list — node state is per-instance and rebuilt on reconcile, the wrong place for history (mirrors how `overlive_chat_message` is a thin view over the *latest* event). A bounded per-project `Map<projectId, ChatFeedMessage[]>` (max `CHAT_BUFFER_MAX = 200`, oldest evicted) is pushed on every `chat.message` event in `routeEvent`, with the message html rendered via `tokensToHtml` (XSS-safe emote `<img>`s) exactly like `overlive_chat_message`. The buffer is cleared on project teardown / `close()`.

### `overlive_chat_feed` node (`signal/nodes/overlive/chat_feed.ts`)

A thin view over that buffer. `routeEvent` fires an `update` event into each matching `overlive_chat_feed` node carrying the current buffer snapshot (a fresh copy per node so persisted state never aliases the live buffer). The node caches it in state and exposes:

- `@eventOut('update')` — fires when the buffer changes.
- `@valueOut('messages', 'Any')` — the `ChatFeedMessage[]` (pull). Typed `Any` because the signal type map has no `List<T>` tag; it carries an array.

`account` / `channel` inputs mirror `overlive_chat_message`; routing/filtering reuses the shared `OverliveManager.nodeAccepts(...)` helper (empty account → project default account).

> **Buffer scope.** The buffer is project-wide, so a channel-filtered feed node still receives the whole project buffer (the channel filter only gates *which* nodes get the `update`). Per-channel buffering is a future refinement.

## Generic half (the reusable part)

### `DataChannelManager` (`packages/backend/src/data_channels/manager.ts`)

A NEW sibling of `RuntimeOverrideManager` — it reuses the override bus's WS + snapshot-on-connect shape but carries **arbitrary structured payloads** keyed by a free channel name (no paramPath coercion, no targetKind/targetId). Singleton, wired in `index.ts` with the WS injected.

- `set(sceneId, channel, payload)` — store + broadcast `data_channel_set`. Whole-payload republish per fire (no diffing — decision 8).
- `clear(sceneId, channel)` — broadcast `data_channel_clear`.
- `clearAllForScene(sceneId)` — producer-teardown convenience.
- `sendSnapshotTo(send)` — emits `data_channel_snapshot` on client connect.

**Scoping.** Channels are scene-scoped; an in-memory `Map<sceneId, Map<channel, payload>>`. A producer that can't resolve a scene publishes to the GLOBAL bucket `'*'`, and the frontend feed layer reads its own scene first then falls back to `'*'` — so single-scene projects work with zero config while multi-scene projects can disambiguate by wiring an explicit `scene` on `set_data`.

**WS messages** (added to `WSMessageKind`):

- `data_channel_set { sceneId, channel, payload }`
- `data_channel_clear { sceneId, channel }`
- `data_channel_snapshot { entries: [{ sceneId, channel, payload }] }`

### `set_data` node (`signal/nodes/set_data.ts`)

The generic sibling of `set_text`. Inputs `@eventIn('fire')`, `@valueIn('channel','String')`, `@valueIn('data','Any')`, `@valueIn('scene','String')` (optional; falls back to config then the global bucket). On fire it publishes `data()` to the named channel via the bus. The `data` input is `Any`/inferred, so a chat `List<ChatFeedMessage>`, a `pack_event` record, or any other value flows through unchanged.

### `feed` compose layer (`ComposeLayerStack.tsx` → `FeedLayer`)

A new `ComposeLayerKind` (`'feed'`, added to the union in `shared/types.ts` + `shared/schema.ts` + frontend `api/client.ts`, with an icon + add-menu entry in `ComposeTree.tsx` and a config editor in `ComposeLayerProperties.tsx`). Config: `channel`, `itemTemplate` (HTML with `{field}` / `{nested.path}` interpolation), optional `maxItems` + `reverse`.

It subscribes to the channel slice in the store (scene key first, then `'*'`), then renders:

- **array payload** → one render per item (e.g. a scrolling chat list);
- **record payload** → a single render.

Each interpolated string is sanitized with DOMPurify (`TEXT_SANITIZE_OPTS` — the same XSS-safe allow-list `text` layers use, which already passes chat emote `<img>`s). Stable React keys use the item's `id` when present (so the user's template owns CSS enter/exit + scroll — the layer stays a thin renderer).

### Store slice + WS handler (`editorStore.ts`, `useWsSync.ts`)

`dataChannels: Record<string, unknown>` keyed by `dataChannelKey(sceneId, channel)` = `` `${sceneId||'*'}::${channel}` ``. Actions `setDataChannel` / `clearDataChannel` / `replaceDataChannels` (snapshot), dispatched from the three WS handlers. Shared by `ViewerPage` so streamed output matches the editor.

## Known limitations (deferred)

- **WS volume.** `set_data` republishes the whole payload per fire (decision 8). Fine for chat rates; add diff/debounce only if a high-frequency producer needs it.
- **Producer-teardown clear.** `clearAllForScene` exists but is not auto-invoked on graph stop (the Node base has no unbind hook). Stale channels persist until overwritten or the server restarts. Snapshot-on-connect + whole-payload republish cover the common UX.
- **Per-channel chat buffering** — see the buffer-scope note above.

## Cross-references

- [overlive.md](overlive.md) — event routing into graph nodes; the chat ring-buffer lives in `OverliveManager`.
- [compose.md](compose.md) — compose layer model; `feed` is a new leaf layer kind.
- [signal-graph.md](signal-graph.md) — `set_data` is the generic producer; `overlive_chat_feed` the chat-specific source.
- [runtime-overrides.md](runtime-overrides.md) — the sibling bus whose WS + snapshot-on-connect shape this reuses.

## Files

- `packages/backend/src/data_channels/manager.ts` — the bus
- `packages/backend/src/signal/nodes/set_data.ts` — generic producer node
- `packages/backend/src/signal/nodes/overlive/chat_feed.ts` — chat feed source node
- `packages/backend/src/overlive/manager.ts` — chat ring-buffer + feed delivery
- `packages/backend/src/index.ts` — `dataChannelManager.init(ws)` + snapshot-on-connect
- `packages/backend/src/signal/registry.ts` — node registration
- `packages/shared/src/types.ts` — `ChatFeedMessage`, `'feed'` kind, WS kinds
- `packages/shared/src/schema.ts` — `'feed'` in `composeLayerKindSchema`
- `packages/frontend/src/store/editorStore.ts` — `dataChannels` slice + `dataChannelKey`
- `packages/frontend/src/hooks/useWsSync.ts` — three WS handlers
- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — `FeedLayer`
- `packages/frontend/src/components/editor/ComposeLayerProperties.tsx` — feed config UI
- `packages/frontend/src/components/editor/ComposeTree.tsx` — icon + add-menu + default config
- `packages/frontend/src/api/client.ts` — `'feed'` in `ComposeLayerKind`
