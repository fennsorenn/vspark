# OBS Browser-Source Bridge

**Status: Implemented.** Branch `claude/obs-browser-api-nodes-7uaxg4`.

vspark is typically added to OBS as a **Browser Source**. The page inside that
source gets a `window.obsstudio` JS API, but the signal graph runs in the
**backend**. This module is the seam between the two: it routes OBS browser-API
events into project logic graphs, pushes graph-driven OBS control calls back out
to the source, and tracks render-client connect/disconnect for graph reactions.

It follows the same external-event-routing pattern as
[overlive.md](overlive.md) — a backend manager singleton fans inbound events into
running project-scoped logic via `logicManager`, matching `node.kind` and firing
the node's `event` input. Depends on [project-graphs.md](project-graphs.md): all
OBS source/action nodes and `client_lifecycle` are intended for project-scoped
**Logic** (they need no behavior context). See also
[signal-graph.md](signal-graph.md) for the node/decorator model.

## Three flows

The bridge has two halves — `packages/backend/src/obs/manager.ts` (`ObsManager`)
and `packages/frontend/src/obs/bridge.ts` (`startObsBridge` + `handleObsCommand`,
hooked into [`useWsSync`](frontend.md)) — that carry three independent flows.

### 1. Inbound — OBS events → graph nodes

```
window.obsstudio event (obsSceneChanged, obsStreamingStarted, …)
  → bridge.ts listener → normalise to ObsEvent → WS 'obs_event'
  → index.ts onMessage → ObsManager.handleEvent(sourceWs, event)
  → dedup (400ms) → _deliver: logicManager.iterateNodes() → matching obs_* node
  → logicManager.fire(graphId, nodeId, 'event', mkEvent(event))
```

The frontend installs `window` listeners once and normalises raw OBS events into
the shared `ObsEvent` union (`scene_changed` | `output_state`). The 17 distinct
OBS output run-state events (`obsStreamingStarted`, `obsRecordingPaused`,
`obsReplaybufferSaved`, `obsVirtualcamStopped`, …) are **folded into one
`output_state` family** with an `output` discriminator (`streaming` | `recording`
| `replay` | `virtualcam`), a `state` transition, and a resulting `active` flag
(see the `OUTPUT_EVENTS` table in `bridge.ts`).

`ObsManager.handleEvent` resolves the source socket's project scope (from its
prior `client_hello`), de-duplicates (below), then `_deliver`s into every running
node whose `kind` matches `OBS_KIND_BY_EVENT[event.type]`. The node's own
`onEvent` handler applies per-node config filters (`onlyScene` / `onlyOutput`).

### 2. Outbound — action nodes → OBS control

```
obs_set_scene / obs_set_transition / obs_control node fires
  → getObsManager().command({ verb, arg? })
  → ObsManager.command → WS broadcast 'obs_command' (to every client)
  → bridge.ts handleObsCommand → window.obsstudio.<verb>(arg?)
```

Fire-and-forget: OBS silently no-ops control calls above the source's **page
permission** level, so there is no ack to wait on. `command` broadcasts to every
connected client; each browser source applies the call (or ignores it if not in
OBS / method unavailable). `ObsCommand.verb` maps 1:1 to a `window.obsstudio`
method name; `setCurrentScene` / `setCurrentTransition` carry an `arg`, the rest
are arg-less.

### 3. Render-client lifecycle

```
WS (re)connect → bridge.ts sends 'client_hello' { projectId, target }
  → index.ts onMessage → ObsManager.handleHello → fire client_lifecycle (connected)
WS close → index.ts ws.on('close') → ObsManager.handleClientGone → fire (disconnected)
```

The WS socket is ephemeral and project-anonymous, so each client announces itself
on every (re)connect with its `projectId` and a **stable `target` marker**. The
marker is the persistent render-target id: an explicit `?obsTarget=` URL param
wins, else the active scene id (resolved in `bridge.ts resolveTarget()`); the
project id comes from the store or the first URL path segment (`resolveProjectId`).

`ObsManager` keeps per-socket identity (`_clients`) and a per-project live count
(`_countByProject`), and fires the `client_lifecycle` node on connect/disconnect
with `{ phase, target, count }`. A re-`hello` on the same socket is de-duplicated
(`_forget` then re-add) so it doesn't double-count. This flow is **vspark-native**
— it works for a plain browser tab too, not just OBS — but lives in `ObsManager`
because it shares the per-socket bookkeeping.

## Signal node kinds

OBS source/action nodes live under `signal/nodes/obs/` (tag `'obs'`).
`client_lifecycle` lives at `signal/nodes/client_lifecycle.ts` (tag `'input'`,
vspark-native but driven by `ObsManager`). All are registered in
`signal/registry.ts`. Nodes are class-instance / decorator form
(`@SignalNode`, `@eventIn`/`@eventOut`/`@valueIn`/`@valueOut`); labels and
descriptions come from the `@SignalNode` decorator (no per-node i18n, like the
overlive action nodes).

| Kind | File | Role | Ports |
|---|---|---|---|
| `obs_scene_changed` | `obs/scene_changed.ts` | Event source — OBS active program scene changed. Config `onlyScene` filter. | out: `event` (Trigger), `name` (String), `width` (Float), `height` (Float); in: `event` (Any, manager entry) |
| `obs_output_state` | `obs/output_state.ts` | Event source — streaming / recording / replay / virtualcam run-state changed. Config `onlyOutput` filter. | out: `event` (Trigger), `output` (String), `state` (String), `active` (Bool); in: `event` (Any) |
| `obs_set_transition` | `obs/set_transition.ts` | Action — `setCurrentTransition`. Name from `transition` input or `config.transition`. Needs ADVANCED (4). | in: `fire` (Trigger), `transition` (String) |
| `obs_control` | `obs/control.ts` | Action — arg-less verb chosen by `config.action` (start/stop streaming, recording + pause/unpause, replay buffer incl. save, virtualcam). Permission-gated per verb. | in: `fire` (Trigger) |
| `client_lifecycle` | `client_lifecycle.ts` | Event source — render client connect/disconnect. Config `onlyTarget` filter. | out: `connected` (Trigger), `disconnected` (Trigger), `target` (String), `count` (Float); in: `event` (Any) |

Source/lifecycle nodes follow the overlive node pattern: an `event` input is the
manager's entry point; on an `undefined` payload (the engine's type-probe path)
they re-emit without touching state, otherwise they apply the config filter,
`setState` the latest payload, and emit. The value outputs pull the last stored
payload.

## Shared types — `packages/shared/src/types.ts`

- `ObsOutputKind`, `ObsOutputState` — the folded output-event vocabulary.
- `ObsEvent` — the normalised inbound event union (`scene_changed` |
  `output_state`).
- `ObsCommand` — outbound control call (`verb` 1:1 with a `window.obsstudio`
  method + optional `arg`).
- `ObsEventMessage` (`obs_event`), `ObsCommandMessage` (`obs_command`),
  `ClientHelloMessage` (`client_hello`) — the WS payload shapes.
- `WSMessageKind` extended with `obs_event` / `obs_command` / `client_hello` /
  `client_status`. **`client_status` is declared but not yet emitted** — reserved
  for a future backend→frontend client-roster push.

## Frontend i18n & help

- `'obs'` palette tag added to `NodePalette` `TAG_ORDER` and to
  `i18n/locales/{en,de}/signalGraph.json`.
- Help page `help/content/{en,de}/obs.md`; `'obs'` added to `help/docs.ts`
  `TOPIC_ORDER`. See [i18n-help.md](i18n-help.md).

## Wiring — `packages/backend/src/index.ts`

`initObsManager(wsSync)` (singleton; `getObsManager()` for node access) is created
at startup. The `onClientConnected` hook registers `ws.on('close', () =>
obsManager.handleClientGone(ws))`. The WS `onMessage` dispatcher handles
`obs_event` → `handleEvent` and `client_hello` → `handleHello`.

## Caveats / decisions

- **Global-event de-duplication.** OBS events are global to the OBS *instance*, so
  **every** open browser source fires the same `obsSceneChanged` /
  `obsStreamingStarted`. Without dedup each source would re-fire the graph.
  `ObsManager._isDuplicate` drops identical events (keyed by
  `projectId:JSON(event)`) seen within `DEDUP_WINDOW_MS` (400ms); the `_lastSeen`
  map is opportunistically pruned past 256 entries.

- **Project scoping.** Inbound events fan out only to logic in the source's
  project (resolved via its `client_hello`). An un-helloed source (`projectId ===
  null`) reaches **all** projects, since OBS events are machine-global. Logic
  graphs are project-scoped, never per-client.

- **Permission levels — and the silent failure they cause.** OBS browser-source
  control calls are gated by the source's "page permission" level (READ_OBS /
  READ_USER / BASIC(3) / ADVANCED(4) / ALL(5)). OBS silently ignores calls above
  the granted level, so outbound actions are best-effort with no failure signal.
  `saveReplayBuffer` needs BASIC, scene/transition/replay-start need ADVANCED,
  and streaming/recording/virtualcam need ALL.

  > **In practice this reads as "the feature is broken".** A browser source's
  > default permission is below ADVANCED, so `obs_set_scene` did *nothing* out
  > of the box: OBS does not expose `setCurrentScene` at that level, the
  > frontend's `api.setCurrentScene?.(name)` optional-chains into a no-op, and
  > the graph reports success. Confirmed live — a `clock → obs_set_scene` graph
  > fired repeatedly against a real OBS and produced no scene change and no log
  > line anywhere. obs-websocket has no such gate and returns a status per
  > request, which is why
  > [obs-consolidate-on-websocket.md](../plans/obs-consolidate-on-websocket.md)
  > moves these nodes onto it. **`obs_set_scene` has already moved** (see the
  > power-tier table below); `obs_set_transition` and `obs_control` still carry
  > the caveat until the rest of that plan lands.

- **Per-source visible/active events intentionally NOT modeled.** OBS exposes
  per-source `obsSourceVisibleChanged` / `obsSourceActiveChanged` events, but
  vspark logic graphs are **project-scoped, not per-client**, and WS sockets are
  ephemeral/anonymous — per-source identity has nothing stable to bind to. The
  useful lifecycle primitive is instead the vspark-native `client_lifecycle` node,
  scoped by the persistent `target` marker.

- **Scope boundary vs obs-websocket.** This is a *browser-source-API* bridge. The
  richer OBS control surface (replay file path, source-by-name, transforms, etc.)
  lives in **obs-websocket** and is deliberately out of scope here.

## Extending

**Add a new inbound OBS event family:**
1. Add a variant to the `ObsEvent` union in `packages/shared/src/types.ts`.
2. In `bridge.ts`, add the `window` listener(s) that normalise the raw OBS event
   into that variant (extend `OUTPUT_EVENTS` if it's another output run-state).
3. Add the node kind to `OBS_KIND_BY_EVENT` in `manager.ts`.
4. Create `signal/nodes/obs/<name>.ts` mirroring `scene_changed.ts` (an `event`
   Any input that re-emits on undefined / filters + `setState` + emits otherwise),
   and register it in `signal/registry.ts`.
5. Add the `'obs'`-tagged label/description in the `@SignalNode` decorator; extend
   the help page if it's a user-facing concept.

**Add a new outbound action verb:**
1. Add the verb to `ObsCommand['verb']` in `packages/shared/src/types.ts` and to
   the `ObsStudioApi` interface in `bridge.ts`. If arg-less, `handleObsCommand`'s
   `default` branch handles it automatically; if it takes an arg, add a `case`.
2. Either add it to `obs_control`'s `VERBS` set (arg-less, config-selected) or
   create a dedicated node (mirror `set_scene.ts`) calling
   `getObsManager().command({ verb, arg? })`. Register in `registry.ts`.

## obs-websocket power tier

The browser-source bridge above is the zero-config baseline. A second, **opt-in**
tier connects the backend to OBS over **obs-websocket** for control the browser
API can't reach (audio volume/mute, replay file path, and — future — scene-item /
filter / transform control). See
[plans/obs-websocket-tier.md](../plans/obs-websocket-tier.md).

**Why a second tier:** `window.obsstudio` exposes no audio surface at all. Only
obs-websocket has `SetInputVolume` / `SetInputMute`, `GetInputList`,
`InputVolumeChanged` events, `GetLastReplayBufferReplay` (the replay path), etc.

**Connection model.** One backend-held connection per project. vspark is
self-hosted, so the backend is co-located with OBS and reaches
`ws://localhost:4455` directly — no page relay. Credentials live in the Accounts
UI (a new **OBS Connections** section in `OverliveAccountsModal`), persisted in
the `obs_connections` table (migration 035).

**Pieces:**
- `packages/backend/src/obs/ws_client.ts` — `ObsWsClient`, a hand-rolled
  obs-websocket v5 client over `ws` + Node `crypto` (Hello/Identify SHA256
  handshake, request/response correlation, event emit). No new dependency;
  reconnection is owned by the manager so the client stays unit-testable.
- `packages/backend/src/obs/ws_manager.ts` — `ObsWsManager` (singleton
  `initObsWsManager`/`getObsWsManager`, injectable client factory for tests).
  Per-project connect + auto-reconnect, a status state machine
  (`connecting`/`connected`/`reconnecting`/`disconnected`/`error`) persisted to
  the row and broadcast as `obs_connection_status`, inbound event fan-out into
  project graphs (same `_deliver` shape as `ObsManager`), and outbound request
  methods (`setScene`, `setTransition`, `control`, `setVolume`, `setMute`,
  `getLastReplayPath`, `listInputs`). Every fire-and-forget action resolves its
  client through `_clientFor` and pipes the request through `_report`, so a
  failure names itself (`[obs-ws] SetCurrentProgramScene failed: …`) instead of
  going quiet. `control`'s verb keys are the old `window.obsstudio` method names
  (`startStreaming`, …), kept verbatim so existing `obs_control` node configs
  survive the transport change; `CONTROL_REQUESTS` maps them onto requests.
- `packages/backend/src/routes/obs-connections.ts` — CRUD + `/test` reconnect +
  `GET /projects/:id/obs/inputs` picker proxy. Mutations call `refreshProject`.

**Nodes** (tag `'obs'`, under `signal/nodes/obs/`):

| Kind | File | Role |
|---|---|---|
| `obs_set_scene` | `set_scene.ts` | Action — `SetCurrentProgramScene`. Name from `scene` input or `config.scene`. Moved here off the browser bridge (see [obs-consolidate-on-websocket.md](../plans/obs-consolidate-on-websocket.md)); node kind and ports unchanged. |
| `obs_set_volume` | `set_volume.ts` | Action — `SetInputVolume` (dB or linear via `config.mode`). |
| `obs_mute` | `mute.ts` | Action — mute / unmute / toggle an input. |
| `obs_volume_changed` | `volume_changed.ts` | Event source — `InputVolumeChanged` → input, mul, db. |
| `obs_mute_changed` | `mute_changed.ts` | Event source — `InputMuteStateChanged` → input, muted. |
| `obs_replay_path` | `replay_path.ts` | Action — on `fire`, `GetLastReplayBufferReplay` → `path` out. |
| `obs_connection_state` | `connection_state.ts` | Event source — connect/disconnect edges + `isConnected`. |

**Project targeting.** obs-websocket connections are per-project, but a signal
node has no graph context of its own. `LogicManager._getNodeConfig` now injects
`_projectId` into **every** logic node's config; the obs-websocket action nodes
read `config._projectId` to target the right connection. Other nodes ignore the
key. Inbound events fan out project-scoped via `logicManager.iterateNodes()`.

**Frontend.** `editorStore.obsConnections` is the source of truth (so live
`obs_connection_status` patches reach the status pills via
`patchObsConnectionStatus` in `useWsSync`). The OBS Connections modal section
reads/writes it through the `api.getObsConnections`/`createObsConnection`/… helpers.

## Tests

- `packages/backend/test/nodes.obs.test.ts` — the browser-bridge OBS /
  `client_lifecycle` nodes.
- `packages/backend/test/obs.manager.test.ts` — `ObsManager` dedup, fan-out,
  project scoping, and client-lifecycle bookkeeping.
- `packages/backend/test/nodes.obs.ws.test.ts` — the obs-websocket nodes.
- `packages/backend/test/obs.ws_manager.test.ts` — `ObsWsManager` lifecycle,
  status broadcast, event routing, and outbound requests (fake client).
- `packages/backend/test/api.obs-connections.test.ts` — connection REST CRUD.
