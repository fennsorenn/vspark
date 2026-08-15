# OBS Integration

**Status: Implemented.** Originally two transports (browser-source bridge +
obs-websocket power tier); consolidated onto obs-websocket alone by
[plans/obs-consolidate-on-websocket.md](../plans/obs-consolidate-on-websocket.md).

vspark reacts to what OBS is doing and controls OBS back, from **Logic** graphs.
All of it runs over **obs-websocket**: one backend-held connection per project,
reaching `ws://localhost:4455` directly (vspark is self-hosted, so the backend is
co-located with OBS — no page relay). Alongside it sits one vspark-native flow,
render-client lifecycle, which involves OBS only incidentally.

It follows the same external-event-routing pattern as
[overlive.md](overlive.md) — a backend manager singleton fans inbound events into
running project-scoped logic via `logicManager`, matching `node.kind` and firing
the node's `event` input. Depends on [project-graphs.md](project-graphs.md): all
OBS source/action nodes and `client_lifecycle` are intended for project-scoped
**Logic** (they need no behavior context). See also
[signal-graph.md](signal-graph.md) for the node/decorator model.

## Why not the browser-source API

vspark is usually added to OBS as a Browser Source, and the page inside one gets
a `window.obsstudio` JS API. That was the original transport, and it had one
genuine advantage: zero setup. It was removed anyway, because its control half is
**silently gated by the source's "page permission" level** (READ_OBS / READ_USER
/ BASIC / ADVANCED / ALL). OBS does not *expose* methods above the granted level
— it does not reject them — so `api.setCurrentScene?.(name)` optional-chained
into a no-op at the default level: no scene change, no error, no log, and the
graph reported success. Confirmed live: a `clock → obs_set_scene` graph fired
repeatedly against a real OBS and produced nothing, anywhere.

obs-websocket has no such gate and returns a status per request, so a failed
action can name itself. The trade accepted in that consolidation: OBS control now
requires a connection set up under Accounts → OBS Connections, where the browser
path needed none. See the plan for the decision record — it deliberately reverses
the "out of scope" call made in [plans/obs-websocket-tier.md](../plans/obs-websocket-tier.md).

## Two flows

### 1. OBS ↔ graph nodes — `packages/backend/src/obs/ws_manager.ts`

```
OBS ⇄ ObsWsClient (obs-websocket v5)
  inbound:  op 5 Event → ObsWsManager._onObsEvent → _deliver
            → logicManager.iterateNodes() → matching obs_* node (project-scoped)
            → logicManager.fire(graphId, nodeId, 'event', mkEvent(payload))
  outbound: obs_* action node → getObsWsManager().<method>(projectId, …)
            → _clientFor (or log why not) → client.request(…) → _report
```

`ObsWsClient` (`packages/backend/src/obs/ws_client.ts`) is a hand-rolled
obs-websocket v5 client over the already-present `ws` package + Node `crypto`
(Hello/Identify SHA256 handshake, request/response correlation, event emit) —
matching the repo's hand-rolled `@overlive/*` adapter style, no new dependency.
Reconnection is owned by the manager so the client stays unit-testable.

`ObsWsManager` owns per-project connect + auto-reconnect, a status state machine
(`connecting`/`connected`/`reconnecting`/`disconnected`/`error`) persisted to the
row and broadcast as `obs_connection_status`, inbound event fan-out, and the
outbound request methods the action nodes call.

Credentials live in the Accounts UI (an **OBS Connections** section in
`OverliveAccountsModal`), persisted in the `obs_connections` table (migration
035). `packages/backend/src/routes/obs-connections.ts` is CRUD + `/test`
reconnect + a `GET /projects/:id/obs/inputs` picker proxy; mutations call
`refreshProject`.

### 2. Render-client lifecycle — `packages/backend/src/obs/manager.ts`

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
(`_forget` then re-add) so it doesn't double-count.

This flow is **vspark-native** — it works for a plain browser tab too, not just
OBS — and needs no obs-websocket connection. `ObsManager` and
`packages/frontend/src/obs/bridge.ts` are what is left of the browser-source
bridge after the consolidation: the names and paths are historical, the OBS parts
are gone.

## Event mapping

Inbound obs-websocket events are translated in `_onObsEvent` into the payload
shapes the source nodes have always consumed (`ObsEvent` in shared types),
`type` discriminant included, so graphs built against the browser bridge still
match:

| obs-websocket event | Node | Payload |
|---|---|---|
| `CurrentProgramSceneChanged` | `obs_scene_changed` | `{ type, name, width, height }` |
| `StreamStateChanged` | `obs_output_state` | `{ type, output: 'streaming', state, active }` |
| `RecordStateChanged` | `obs_output_state` | `output: 'recording'` |
| `ReplayBufferStateChanged` | `obs_output_state` | `output: 'replay'` |
| `ReplayBufferSaved` | `obs_output_state` | `output: 'replay', state: 'saved', active: true` |
| `VirtualcamStateChanged` | `obs_output_state` | `output: 'virtualcam'` |
| `InputVolumeChanged` | `obs_volume_changed` | `{ input, mul, db }` |
| `InputMuteStateChanged` | `obs_mute_changed` | `{ input, muted }` |

`OUTPUT_BY_EVENT` picks the output discriminator; `OUTPUT_STATE_BY_OBS` maps
OBS's `outputState` enum onto the `starting`/`started`/`stopping`/`stopped`/
`paused`/`unpaused` vocabulary. It is **deliberately partial**: OBS's
`RECONNECTING` / `RECONNECTED` / `UNKNOWN` states have no slot in that vocabulary
and had no browser-bridge equivalent either, so they are dropped rather than
widening a payload shape graphs match on.

`EVENT_SUB` bit flags live in `ws_client.ts`; `DEFAULT_SUBSCRIPTIONS` is
`Inputs | Scenes | Outputs` — the three families the source nodes need.

## Signal node kinds

OBS nodes live under `signal/nodes/obs/` (tag `'obs'`). `client_lifecycle` lives
at `signal/nodes/client_lifecycle.ts` (tag `'input'`, vspark-native but driven by
`ObsManager`). All are registered in `signal/registry.ts`. Nodes are class-instance
/ decorator form (`@SignalNode`, `@eventIn`/`@eventOut`/`@valueIn`/`@valueOut`);
labels and descriptions come from the `@SignalNode` decorator (no per-node i18n,
like the overlive action nodes).

| Kind | File | Role | Ports |
|---|---|---|---|
| `obs_scene_changed` | `obs/scene_changed.ts` | Event source — OBS active program scene changed. Config `onlyScene` filter. | out: `event` (Trigger), `name` (String), `width` (Float), `height` (Float); in: `event` (Any, manager entry) |
| `obs_output_state` | `obs/output_state.ts` | Event source — streaming / recording / replay / virtualcam run-state changed. Config `onlyOutput` filter. | out: `event` (Trigger), `output` (String), `state` (String), `active` (Bool); in: `event` (Any) |
| `obs_volume_changed` | `obs/volume_changed.ts` | Event source — `InputVolumeChanged` → input, mul, db. | in: `event` (Any) |
| `obs_mute_changed` | `obs/mute_changed.ts` | Event source — `InputMuteStateChanged` → input, muted. | in: `event` (Any) |
| `obs_connection_state` | `obs/connection_state.ts` | Event source — connect/disconnect edges + `isConnected`. | in: `event` (Any) |
| `obs_set_scene` | `obs/set_scene.ts` | Action — `SetCurrentProgramScene`. Name from `scene` input or `config.scene`. | in: `fire` (Trigger), `scene` (String) |
| `obs_set_transition` | `obs/set_transition.ts` | Action — `SetCurrentSceneTransition`. Name from `transition` input or `config.transition`. | in: `fire` (Trigger), `transition` (String) |
| `obs_control` | `obs/control.ts` | Action — arg-less verb chosen by `config.action` (start/stop streaming, recording + pause/unpause, replay buffer incl. save, virtualcam). | in: `fire` (Trigger) |
| `obs_set_volume` | `obs/set_volume.ts` | Action — `SetInputVolume` (dB or linear via `config.mode`). | in: `fire` (Trigger), `input` (String) |
| `obs_mute` | `obs/mute.ts` | Action — mute / unmute / toggle an input. | in: `fire` (Trigger), `input` (String) |
| `obs_replay_path` | `obs/replay_path.ts` | Action — on `fire`, `GetLastReplayBufferReplay` → `path` out. | in: `fire` (Trigger); out: `path` (String) |
| `client_lifecycle` | `client_lifecycle.ts` | Event source — render client connect/disconnect. Config `onlyTarget` filter. | out: `connected` (Trigger), `disconnected` (Trigger), `target` (String), `count` (Float); in: `event` (Any) |

Source/lifecycle nodes follow the overlive node pattern: an `event` input is the
manager's entry point; on an `undefined` payload (the engine's type-probe path)
they re-emit without touching state, otherwise they apply the config filter,
`setState` the latest payload, and emit. The value outputs pull the last stored
payload.

## Shared types — `packages/shared/src/types.ts`

- `ObsOutputKind`, `ObsOutputState` — the folded output-event vocabulary.
- `ObsEvent` — the normalised event union (`scene_changed` | `output_state`) the
  manager delivers into the source nodes. It predates obs-websocket (the browser
  bridge normalised `window.obsstudio` events into exactly this shape) and is
  kept verbatim so existing graphs still match.
- `ObsConnectionStatus` — the connection state machine's vocabulary.
- `WSMessageKind` extended with `client_hello` / `client_status` /
  `obs_connection_status`. **`client_status` is declared but not yet emitted** —
  reserved for a future backend→frontend client-roster push.

## Frontend i18n & help

- `'obs'` palette tag added to `NodePalette` `TAG_ORDER` and to
  `i18n/locales/{en,de}/signalGraph.json`.
- Help page `help/content/{en,de}/obs.md`; `'obs'` added to `help/docs.ts`
  `TOPIC_ORDER`. See [i18n-help.md](i18n-help.md).
- `editorStore.obsConnections` is the source of truth (so live
  `obs_connection_status` patches reach the status pills via
  `patchObsConnectionStatus` in `useWsSync`). The OBS Connections modal section
  reads/writes it through the `api.getObsConnections`/`createObsConnection`/…
  helpers.

## Wiring — `packages/backend/src/index.ts`

`initObsManager()` (singleton; `getObsManager()`) and `initObsWsManager(wsSync)`
(singleton; `getObsWsManager()` for node access) are created at startup, and
`obsWsManager.startAll()` connects every project with an enabled row. The
`onClientConnected` hook registers `ws.on('close', () =>
obsManager.handleClientGone(ws))`. The WS `onMessage` dispatcher handles
`client_hello` → `handleHello`.

## Caveats / decisions

- **Project targeting.** obs-websocket connections are per-project, but a signal
  node has no graph context of its own. `LogicManager._getNodeConfig` injects
  `_projectId` into **every** logic node's config; the OBS action nodes read
  `config._projectId` to target the right connection. Other nodes ignore the key.
  Inbound events fan out project-scoped via `logicManager.iterateNodes()`.

- **No de-duplication needed.** The browser bridge needed a 400ms dedup window
  because OBS events are global to the OBS *instance*, so every open browser
  source reported the same `obsSceneChanged`. There is now a single backend-held
  connection per project, so one OBS event is one graph fire. `_isDuplicate` and
  `DEDUP_WINDOW_MS` went with the bridge.

- **Canvas size on `obs_scene_changed`.** The browser event carried the scene's
  `width`/`height`; `CurrentProgramSceneChanged` does not. `GetVideoSettings` is
  read once per connection and cached on the `Conn` (`_loadCanvasSize`), since
  obs-websocket has no canvas-resize event to track. A failed read leaves 0×0 —
  the scene name is the useful part.

- **Failures name themselves.** Every fire-and-forget action resolves its client
  through `_clientFor` (missing projectId / no connection for the project /
  connection not identified — each logged distinctly) and pipes the request
  through `_report`, which logs a rejection as
  `[obs-ws] SetCurrentProgramScene failed: …`. Action nodes deliberately pass an
  empty name *through* to the manager rather than returning early, so the reason
  gets logged instead of swallowed.

- **`obs_control` keeps the old verb vocabulary.** Its `config.action` values are
  still the `window.obsstudio` method names (`startStreaming`,
  `unpauseRecording`, …). `CONTROL_REQUESTS` in `ws_manager.ts` maps them onto
  obs-websocket requests (`StartStream`, `ResumeRecord`, …) so graphs built
  before the transport change keep working.

- **Per-source visible/active events intentionally NOT modeled.** OBS exposes
  per-source `obsSourceVisibleChanged` / `obsSourceActiveChanged` events, but
  vspark logic graphs are **project-scoped, not per-client**, and WS sockets are
  ephemeral/anonymous — per-source identity has nothing stable to bind to. The
  useful lifecycle primitive is instead the vspark-native `client_lifecycle` node,
  scoped by the persistent `target` marker.

- **Password at rest is plaintext.** Tracked project-wide; it is one of three
  plaintext credential stores (see the ARCHITECTURE.md multi-user note).

- **One connection per project.** Multi-connection-per-project and an
  `Account`-style connection selector port are out of scope.

## Extending

**Add a new inbound OBS event family:**
1. Add a variant to the `ObsEvent` union in `packages/shared/src/types.ts` (or a
   plain payload shape, as the volume/mute events use).
2. Make sure the event's `EVENT_SUB` bit is in `DEFAULT_SUBSCRIPTIONS`
   (`ws_client.ts`) — without it OBS never sends the event.
3. Translate it in `ObsWsManager._onObsEvent` and `_deliver` it to the node kind.
4. Create `signal/nodes/obs/<name>.ts` mirroring `scene_changed.ts` (an `event`
   Any input that re-emits on undefined / filters + `setState` + emits otherwise),
   and register it in `signal/registry.ts`.
5. Add the `'obs'`-tagged label/description in the `@SignalNode` decorator; extend
   the help page if it's a user-facing concept.

**Add a new outbound action:**
1. Add a method to `ObsWsManager` mirroring `setScene` — validate arguments with
   `_requireName`, resolve the client with `_clientFor`, and wrap the request in
   `_report` so failures are logged. For another arg-less verb, just add it to
   `CONTROL_REQUESTS`.
2. Create `signal/nodes/obs/<name>.ts` mirroring `set_scene.ts`, reading
   `config._projectId`, and register it in `signal/registry.ts`.

**Phase 2 (enumerated, not built):** `obs_set_source_visible`
(`SetSceneItemEnabled`), `obs_set_filter_enabled` (`SetSourceFilterEnabled`),
`obs_set_source_transform` (`SetSceneItemTransform`). See
[plans/obs-websocket-tier.md](../plans/obs-websocket-tier.md).

## Tests

- `packages/backend/test/nodes.obs.test.ts` — the OBS event-source nodes +
  `client_lifecycle` (payload → state mapping, transport-agnostic).
- `packages/backend/test/nodes.obs.ws.test.ts` — the OBS action nodes against a
  mocked `ObsWsManager`.
- `packages/backend/test/obs.ws_manager.test.ts` — `ObsWsManager` lifecycle,
  status broadcast, scene/output/input event routing, and outbound requests
  (fake client).
- `packages/backend/test/obs.manager.test.ts` — `ObsManager` client-lifecycle
  bookkeeping.
- `packages/backend/test/api.obs-connections.test.ts` — connection REST CRUD.
