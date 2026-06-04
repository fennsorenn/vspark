# Phase 3 — Generic Data Channels + Template Feed Layer (chat overlay as first use)

## Context

vspark can react to chat events in the signal graph (`overlive_chat_message` emits an event +
exposes the *latest* message's fields), but there is **no chat history** anywhere and no way to
render an accumulating, scrolling list on-screen. Phase 2 (just shipped) added typed payloads,
dynamic ports, and `pack_event`/`queue_events`/`unpack_event`, which makes structured data flow
through the graph — the missing pieces for a data-driven overlay are (a) durable list state, (b)
a generic way to publish arbitrary structured data from the graph to the frontend, and (c) a
generic layer that renders that data through a user template.

The motivating feature is an **internal chat overlay**, but the design goal is explicitly *not*
to hardcode chat: only the history store and its feed node are chat-specific; everything from the
publish step onward is **data-shape-agnostic** and reusable for alert tickers, event logs,
scoreboards, poll results, etc.

### Pipeline (user-confirmed design)

```
OverliveManager (owns a bounded chat ring-buffer; chat-specific)
  → overlive_chat_feed node: `update` event + `messages: List<ChatMessage>` (pull)   [chat-specific]
  → [graph: optional filter / transform / gate nodes]                                 [generic, optional]
  → set_data node: publishes an arbitrary payload to a NAMED data channel             [generic]
  → WS broadcast (data channel)                                                       [generic]
  → FrontendTemplateLayer (compose layer): subscribes to the channel, holds payload   [generic]
    in React state, renders it through a DATA-SHAPE-INDEPENDENT template
```

Key properties:
- **The overlive store owns the list**, not a graph node (node state is per-instance + rebuilt on
  reconcile — wrong place for durable history). The node is a thin *view* over the buffer, mirroring
  how `overlive_chat_message` is a thin view over the latest event.
- **The graph is in the path** (not bypassed) so chat can be filtered/transformed/gated before render.
- **The template adapts to the data, not vice versa.** The layer receives *some* payload + a template
  that interpolates whatever fields that payload has. Chat-message-list is one shape; a record, a list
  of alerts, etc. all render through the same mechanism.

### Decisions locked with the user
1. Overlive store owns chat history; a chat-specific node exposes `update` event + `messages` list.
2. Render path: store → graph → `set_data` node → WS → generic frontend template layer (React state).
3. Generic/chat split: chat-specific store + feed node; **generic** `set_data`, data channel, and
   template layer.
4. Template is **data-shape-independent** — interpolates whatever fields the published payload carries.
5. **Bus: a NEW sibling `DataChannelManager`** (not an extension of `RuntimeOverrideManager`). It
   reuses the override bus's WS + snapshot-on-connect pattern but carries arbitrary structured
   payloads keyed by a free channel name — no paramPath coercion, no targetKind/targetId. Keeps the
   override bus focused on scalar param writes.
6. **Channels are scene-scoped**, snapshot on WS connect, cleared on producer teardown (mirrors the
   override bus + broadcast bus; viewer matches editor per scene).
7. **Per-item animation is user-driven** via the template + CSS (stable keys; the user's template
   owns transitions). The layer stays a thin generic renderer. Opt-in presets can come later.
8. **WS volume deferred**: `set_data` republishes the whole payload per fire. Fine for chat rates;
   documented as a known limitation. Add diff/debounce only if a high-frequency producer needs it.

## Components

### Chat-specific
- **Chat ring-buffer in `OverliveManager`** (`packages/backend/src/overlive/manager.ts`): bounded
  per-project (or per-account/channel) list of recent `ChatMessage`s; push on each chat event, evict
  oldest past `maxItems`. Expose a getter for the feed node + a change signal.
- **`overlive_chat_feed` node** (`packages/backend/src/signal/nodes/overlive/chat_feed.ts`): outputs
  `@eventOut('update')` (fires when the buffer changes) + `@valueOut('messages', …)` returning
  `List<ChatMessage>` (pull). Reads the manager buffer (like the other overlive nodes read event state).
  Account/channel value inputs for routing/filtering, consistent with `overlive_chat_message`.

### Generic (the reusable half)
- **`DataChannelManager`** (`packages/backend/src/data_channels/manager.ts`) — NEW sibling of
  `RuntimeOverrideManager` (decision 5). Scene-scoped (decision 6). Public API mirrors the override
  bus (see `runtime_overrides/manager.ts`): `set(sceneId, channelName, payload)`,
  `clear(sceneId, channelName)`, `clearAllForScene(sceneId)` (called on producer teardown),
  `sendSnapshotTo(ws)` (on connect). WS broadcasts `data_channel_set` / `data_channel_clear` /
  `data_channel_snapshot`. Carries **arbitrary structured payloads** (no paramPath coercion, no
  targetKind/targetId). Wire the singleton in `index.ts` like the other managers; inject the WS.
  Whole-payload republish per `set` (decision 8 — no diffing).
- **`set_data` node** (`packages/backend/src/signal/nodes/set_data.ts`): the generic sibling of
  `set_text`. Inputs `@eventIn('fire')`, `@valueIn('channel', 'String')`, `@valueIn('data', 'Any')`
  (the payload — typed via inference), optional `persist`. On fire: publishes `data` to the named
  channel via the bus. Mirror `set_text`'s structure (`packages/backend/src/signal/nodes/set_text.ts`).
- **`FrontendTemplateLayer`** — new `ComposeLayerKind` (add `'feed'` or `'template'` to the union in
  `packages/shared/src/types.ts` + `packages/shared/src/schema.ts`; render branch in
  `packages/frontend/src/components/editor/ComposeLayerStack.tsx` alongside image/video/browser/html).
  Config: `channel` (which data channel to subscribe to), `itemTemplate` (HTML string with
  `{field}` interpolation), optional `containerTemplate`/wrapper + `maxItems`/`reverse`. Subscribes
  to the channel slice in the Zustand store (fed by the WS `data_channel_set` handler in
  `hooks/useWsSync.ts`), holds payload in React state, renders:
    - if payload is an array → map each item through `itemTemplate`;
    - if payload is a record → single render through `itemTemplate`.
  Sanitize interpolated HTML via the existing `packages/frontend/src/lib/textSanitize.ts` (DOMPurify)
  path — reuses the XSS-safe pipeline that `text_canvas`/html layers already use; the chat `html`
  field already carries emote `<img>`s through it. Real DOM → CSS enter/exit + scroll possible.
- **Zustand slice + WS handler** for data channels (`store/editorStore.ts`, `hooks/useWsSync.ts`),
  parallel to the runtime-override slice. Shared by `ViewerPage` so streamed output matches the editor.

## Resolved design decisions
All open questions resolved with the user (see "Decisions locked" 5–8 above):
- Bus = new sibling `DataChannelManager` (not an override-bus extension).
- Channels scene-scoped; snapshot on connect; cleared on producer teardown.
- Per-item animation user-driven via template + CSS (stable keys); layer is a thin generic renderer.
- WS volume deferred: whole-payload republish per fire; documented as a known limitation.

## ⚠ NOTE FOR THE EXECUTING (CLOUD) INSTANCE — read first
Adding a `@vspark/shared/<subpath>` requires updating FOUR resolver configs or builds break in ways
`tsc`/lint does NOT catch (this bit Phase 2 three times):
1. `packages/shared/package.json` exports map
2. `packages/backend/tsconfig.json` + `packages/frontend/tsconfig.json` paths
3. `packages/frontend/vite.config.ts` resolve.alias (list specific subpaths before shorter prefixes; bare last)
4. `packages/backend/bundle.mjs` esbuild alias map
Phase 3 likely adds no new shared subpath (data-channel types can live in existing `types.ts`), but if
you DO add one, do all four. **Verify with `cd packages/frontend && pnpm exec vite build` AND
`pnpm --filter @vspark/backend bundle`, not just `tsc --noEmit`.** Toolchain: discover pnpm via
`find /home/fennsorenn/snap/code -maxdepth 5 -name pnpm -type f | sort -V | tail -1`; there is no root
`lint` script (use `pnpm -r` / `--filter`); no test runner — type-check + targeted runtime spikes via
`tsx` are the correctness gate. Node 18 locally; TS 5.9, Stage-3 decorators (no experimentalDecorators).

## Dependencies
- Builds directly on Phase 2 (typed payloads + dynamic ports + inference): `set_data`'s `data` input
  is `Any`/inferred, and `List<ChatMessage>` flows typed from the feed node through the graph.
- Independent of the open PR #13 (Phase 2 → main); start on a fresh branch off `dev` after that merges.

## Verification (tentative)
1. Wire `overlive_chat_feed → set_data(channel: 'chat')` and a `feed` layer subscribed to `'chat'`
   with an item template; send chat → messages append + scroll, emotes render.
2. Publish a *non-chat* payload (e.g. a `pack_event` record or a static list) to a channel and render
   it through a different template → confirms the layer is data-shape-independent.
3. Reload / new WS connect → snapshot restores current channel state.
4. `lint` clean; ViewerPage renders the same feed as the editor.

## Workflow
- Fresh branch off `dev` (e.g. `feature/data-channels-feed`); never commit to dev/main directly.
- Conventional commits; doc-updater at start (planned/WIP) and end (implemented).
- New module docs: `dev-notes/modules/data-channels.md`; cross-ref overlive.md, compose.md, signal-graph.md.
