# Plan: OBS control via obs-websocket (power tier)

> Branch: `feature/obs-websocket-tier` · Status: draft → ready-for-handoff
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.
>
> Builds on the already-shipped **OBS browser-source bridge**
> ([modules/obs.md](../modules/obs.md)). Read that first — this plan reuses its
> `obs` node tag, help page, and manager conventions.

## Goal

Add an **opt-in obs-websocket connection per project** that unlocks OBS control
the browser-source API cannot reach — starting with **audio input volume + mute**
(the motivating ask), plus the replay-buffer file path, scene-item visibility, and
source filters. Credentials + connection status live in the existing **Accounts**
UI, alongside the Overlive stream accounts.

The browser-source bridge stays as the zero-config baseline; this is the
power tier for users who enable obs-websocket in OBS and enter its address +
password.

## Background: why a second tier

The native `window.obsstudio` browser API (what the shipped bridge uses) exposes
**no audio surface at all** — no volume, no mute, no source enumeration. Those
live only in **obs-websocket** (v5), which does have:

- `SetInputVolume` (`inputName` + `inputVolumeMul` linear 0.0–~20, **or**
  `inputVolumeDb` −100…+26; set one), `GetInputVolume`
- `SetInputMute` / `ToggleInputMute` / `GetInputMute`
- `GetInputList` (with `inputKind` filter to isolate audio inputs)
- events `InputVolumeChanged` / `InputMuteStateChanged` (`inputName`,
  `inputVolumeMul`, `inputVolumeDb`, `inputMuted`)
- `GetLastReplayBufferReplay` → `savedReplayPath` (the replay path the bridge
  can't get), `SetSceneItemEnabled`, `SetSourceFilterEnabled`,
  `SetSceneItemTransform`, and much more.

Unlike OBS *source* identity (unreachable from the browser API), obs-websocket
addresses inputs by **name**, and `GetInputList` enumerates them — so audio
sources are cleanly targetable and pickable.

## Decisions already made

- **Auth lives in the Accounts section.** Reuse `OverliveAccountsModal` (namespace
  `accounts`) by adding an **"OBS Connections"** section, rather than a new modal.
- **Backend holds the connection** (consistent with how Overlive accounts connect
  server-side). vspark's intended deployment is **self-hosted** — the backend runs
  on the same machine as OBS — so reaching `ws://localhost:4455` is a non-issue.
  (Even a cloud-hosted setup would run a local backend for other machine-local
  functionality, so backend-connect is the right model regardless.)
- **One connection per project** (an OBS instance is one machine). No per-node
  connection selector needed; nodes fan out project-scoped exactly like the
  existing `obs_*` browser nodes. (Multi-connection can come later via an
  `Account`-style port.)
- **Separate table + manager**, not shoehorned into `overlive_accounts`. That
  table is streaming-platform-shaped (`platform`, `broadcaster_id`,
  `app_credential_id`, OAuth); OBS is host/port/password. A parallel
  `obs_connections` table + `ObsWsManager` keeps both clean; only the *frontend
  modal* is shared. (Alternative considered and rejected: `platform='obs_websocket'`
  row in `overlive_accounts` with everything-but-credentials NULL.)
- **Reuse the status state machine + pill UI** (`connected` / `connecting` /
  `reconnecting` / `disconnected` / `error`), and the plaintext-credentials
  approach (encryption-at-rest stays a project-wide future item, same as Overlive).

## Reachability — settled

Backend-holds-connection means the backend reaches OBS's obs-websocket server
(default `ws://localhost:4455`). Since vspark is **self-hosted** (backend
co-located with OBS), this is a non-issue — no page-relay needed. A page-relay
transport for a hypothetical fully-remote backend is explicitly out of scope; even
that setup would run a local backend for other machine-local features, so
backend-connect stays correct. The OBS Connections UI should still default the host
to `localhost` and surface a clear error when the server is unreachable.

## Node set

New nodes under `signal/nodes/obs/`, tag `'obs'`. All route through `ObsWsManager`
(project-scoped, like the browser `obs_*` nodes). Editor picks input/scene/filter
names from dropdowns fed by a REST proxy (see below); free-text entry is the fallback.

### Phase 1 — audio + replay path

| Kind | obs-websocket call | Notes |
|---|---|---|
| `obs_set_volume` | `SetInputVolume` | config `inputName`, `mode` (`db`\|`mul`); `input`/`value` inputs override config. |
| `obs_mute` | `SetInputMute` / `ToggleInputMute` | config `inputName`, `action` (`mute`\|`unmute`\|`toggle`). |
| `obs_volume_changed` | ← `InputVolumeChanged` | event source; outs `input` (String), `mul` (Float), `db` (Float); config `onlyInput` filter. |
| `obs_mute_changed` | ← `InputMuteStateChanged` | event source; outs `input` (String), `muted` (Bool); `onlyInput` filter. |
| `obs_replay_path` | `GetLastReplayBufferReplay` on `fire` | outs `path` (String) — the thing the browser bridge can't get. Pairs with the shipped `obs_output_state` replay `saved` event. |
| `obs_connection_state` | ← manager status | event source; `connected`/`disconnected` outs — "OBS link lost" reactions. |

### Phase 2 — scene items, filters, sources (list-only in this plan)

`obs_set_source_visible` (`SetSceneItemEnabled`), `obs_set_filter_enabled`
(`SetSourceFilterEnabled`), `obs_set_source_transform` (`SetSceneItemTransform`).
Enumerate as planned; don't build until Phase 1 lands.

## Files in scope

**Backend**
- `packages/backend/src/db/migrations/035_obs_connections.sql` — **new** table:
  ```sql
  CREATE TABLE IF NOT EXISTS obs_connections (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    host           TEXT NOT NULL DEFAULT 'localhost',
    port           INTEGER NOT NULL DEFAULT 4455,
    password       TEXT NOT NULL DEFAULT '',      -- plaintext today (see encryption-at-rest)
    enabled        INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'disconnected',
    status_reason  TEXT,
    status_message TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_obs_connections_project_id ON obs_connections(project_id);
  ```
  (035 is the next slot; latest is 034. Run `scripts/buildMigrations.mjs` after.)
- `packages/backend/src/obs/ws_manager.ts` — **new** `ObsWsManager` singleton
  (`initObsWsManager`/`getObsWsManager`), mirroring `OverliveManager`:
  `startAll()`, `refreshProject(projectId)` reconcile, one client per enabled row,
  status → `persistStatus` + WS broadcast `obs_connection_status`
  `{ connectionId, projectId, status, reason, message }`, auto-reconnect. Inbound
  obs-websocket events → route into `obs_volume_changed` / `obs_mute_changed` /
  `obs_connection_state` nodes via `logicManager.iterateNodes()`/`fire()` (same
  fan-out helper shape as `ObsManager._deliver`). Outbound: `setVolume`, `setMute`,
  `getLastReplayPath`, etc., called by the action nodes' `onFire`.
- `packages/backend/src/routes/obs-connections.ts` — **new** CRUD
  (`GET/POST /projects/:projectId/obs-connections`, `PUT/DELETE
  /obs-connections/:id`, `POST /obs-connections/:id/test`), each calling
  `getObsWsManager().refreshProject(projectId)`. Plus a picker proxy:
  `GET /projects/:projectId/obs/inputs|scenes|scene-items|filters` → live
  `GetInputList` etc. (empty/501-ish when disconnected). Compose into
  `routes/index.ts`; register manager singleton in `routes/shared.ts` style.
- `packages/backend/src/signal/nodes/obs/{set_volume,mute,volume_changed,mute_changed,replay_path,connection_state}.ts`
  — **new**; register in `signal/registry.ts`.
- `packages/backend/src/index.ts` — `initObsWsManager(wsSync)` + `startAll()` at boot
  (next to `initObsManager`).
- **Dependency**: add `obs-websocket-js` (protocol v5, works in Node) to
  `packages/backend`. ⚠️ Confirm this choice vs. a hand-rolled client (the repo
  hand-rolls `@overlive/*` adapters) — obs-websocket-js is the standard and handles
  the Hello/Identify SHA256 auth handshake, so it's the recommended default.

**Shared**
- `packages/shared/src/types.ts` — `ObsConnectionStatus` enum, `ObsWsEvent` (volume /
  mute / connection), `ObsWsCommand` if a command envelope is used; extend
  `WSMessageKind` with `obs_connection_status`. (Reuse the existing `client_status`
  slot? No — distinct concept.)

**Frontend**
- `packages/frontend/src/components/editor/OverliveAccountsModal.tsx` — add an **OBS
  Connections** section (host/port/password/label form + status pill + Test +
  delete). Or extract a sibling `ObsConnectionsSection` rendered in the same modal.
- `packages/frontend/src/api/client.ts` — `ObsConnectionRecord` type + CRUD helpers
  (`getObsConnections`, `createObsConnection`, `updateObsConnection`,
  `deleteObsConnection`, `testObsConnection`, `getObsInputs`).
- `packages/frontend/src/store/editorStore.ts` — `obsConnections` slice (mirror of
  `overliveAccounts`) so node config dropdowns + status pills read live state.
- `packages/frontend/src/hooks/useWsSync.ts` — handle `obs_connection_status` →
  update the store (do this properly here, unlike Overlive which only REST-refetches;
  live pills are worth it). Node config input pickers read `getObsInputs` etc.
- **i18n**: extend `accounts.json` (en + de) with an `obs.*` block (labels, status);
  reuse the `obs` palette tag already added. German must be a real translation.
- **Help**: extend `help/content/{en,de}/obs.md` with an "obs-websocket connection"
  section (how to enable the server in OBS, the localhost/reachability caveat, the
  new nodes) and add a `HelpButton` next to the OBS Connections form.

## Out of scope

- **Page-relay transport** for cloud-hosted backends (backend-connect only here).
- **Encryption-at-rest** for the stored password (tracked project-wide; matches
  Overlive's current plaintext state).
- **Phase 2 nodes** (scene items / filters / transforms) — enumerated, not built.
- Multi-connection-per-project and an `Account`-style connection selector port.
- Re-routing the existing browser-source `obs_set_scene`/`obs_control` nodes through
  obs-websocket (they keep using the browser bridge).

## Approach

1. Migration 035 + `buildMigrations.mjs`; verify it loads on a fresh `:memory:` DB.
2. `ObsWsManager` with a stubbed client first (status lifecycle + fan-out +
   broadcast), unit-tested against a fake client, mirroring `obs.manager.test.ts`.
3. Wire `obs-websocket-js`; implement connect/auth/reconnect + the event
   subscriptions and the outbound calls.
4. REST routes + `index.ts` boot wiring + picker proxy endpoints.
5. Phase-1 nodes + registry; node tests via `loneNode` (sources) and a mocked
   `getObsWsManager()` (actions), mirroring `nodes.obs.test.ts`.
6. Shared types + `WSMessageKind`.
7. Frontend: store slice, API client, modal OBS section, `useWsSync` status handler,
   config-dropdown pickers.
8. i18n (`accounts.json` + palette) + help page section + `HelpButton`.
9. Docs: extend `modules/obs.md` (add the obs-websocket tier + the two-tier
   distinction) and flip a status note in `ARCHITECTURE.md`.

## Acceptance / verification

- `pnpm lint` clean; `pnpm test` green incl. new `ObsWsManager` + node tests.
- With a real OBS (obs-websocket enabled) reachable from the backend: adding a
  connection shows a `connected` pill; `obs_set_volume` / `obs_mute` change the
  input; `obs_volume_changed` fires on manual fader moves; `obs_replay_path`
  returns a path after a replay save.
- Disconnected/misconfigured connection degrades gracefully: status `error` with a
  message, action nodes no-op, picker endpoints return empty.
- i18n JSON validates (German curly quotes); help page renders; `HelpButton`
  resolves its anchor.

## Output

Open a PR into `dev` when done.
