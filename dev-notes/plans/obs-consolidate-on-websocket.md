# Plan: consolidate the OBS integration onto obs-websocket

> Branch: `feature/obs-ws-consolidation` (create from `dev`, after #60 lands) ·
> Status: ready-for-handoff
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Goal

Move the OBS **control** and **state** nodes off the browser-source bridge
(`window.obsstudio`) and onto obs-websocket, so they work without an obscure OBS
setting and can report failure.

The two transports landed together in #60 but split by *capability* — browser
bridge for scenes/outputs, obs-websocket for audio/replay — rather than by what
each is good at. In practice the browser path has one disqualifying property:

**`obs_set_scene` silently does nothing unless the browser source's page
permission is set to "Advanced".** OBS does not expose `setCurrentScene` below
that level, so `handleObsCommand`'s `api.setCurrentScene?.(name)` optional-chains
into a no-op. No log, no error, and the graph reports success. Verified live on
2026-08-14: a `clock → obs_set_scene` graph fired repeatedly against a real OBS
with default page permissions and nothing happened, anywhere, visibly or in logs.

obs-websocket has none of that: `SetCurrentProgramScene` needs no page
permission, and every request returns a status.

## Context — read these first

- [dev-notes/modules/obs.md](../modules/obs.md) — both halves as built: the three
  browser-bridge flows, then the "obs-websocket power tier" section.
- [dev-notes/plans/obs-websocket-tier.md](./obs-websocket-tier.md) — the power
  tier's own plan. **Its "Out of scope" list explicitly excludes** re-routing
  `obs_set_scene` / `obs_control` through obs-websocket ("they keep using the
  browser bridge"). This plan deliberately reverses that call; the reason is the
  silent-failure property above, which that plan did not weigh.
- `packages/frontend/src/obs/bridge.ts` — the full `window.obsstudio` surface and
  the `OUTPUT_EVENTS` table folding 17 OBS events into one `output_state` family.

## Current split (verified 2026-08-14)

| Node | Fed by | Transport |
|---|---|---|
| `obs_scene_changed` | `ObsManager` | browser |
| `obs_output_state` | `ObsManager` | browser |
| `obs_set_scene` | → `ObsManager.command` | browser |
| `obs_set_transition` | → `ObsManager.command` | browser |
| `obs_control` | → `ObsManager.command` | browser |
| `client_lifecycle` | `ObsManager` | **vspark-native** |
| `obs_set_volume` | → `ObsWsManager` | ws |
| `obs_mute` | → `ObsWsManager` | ws |
| `obs_volume_changed` | `ObsWsManager` | ws |
| `obs_mute_changed` | `ObsWsManager` | ws |
| `obs_replay_path` | → `ObsWsManager` | ws |
| `obs_connection_state` | `ObsWsManager` | ws |

## The mapping is clean

Every browser **command** has a direct obs-websocket v5 equivalent:

| `window.obsstudio` | obs-websocket request |
|---|---|
| `setCurrentScene` | `SetCurrentProgramScene` |
| `setCurrentTransition` | `SetCurrentSceneTransition` |
| `start/stopStreaming` | `StartStream` / `StopStream` |
| `start/stopRecording` | `StartRecord` / `StopRecord` |
| `pause/unpauseRecording` | `PauseRecord` / `ResumeRecord` |
| `start/stopReplayBuffer` | `StartReplayBuffer` / `StopReplayBuffer` |
| `saveReplayBuffer` | `SaveReplayBuffer` |
| `start/stopVirtualcam` | `StartVirtualCam` / `StopVirtualCam` |

**Events** map too. `CurrentProgramSceneChanged` replaces the scene event, and
`StreamStateChanged` / `RecordStateChanged` / `ReplayBufferStateChanged` /
`VirtualcamStateChanged` replace the 17 folded output events — arguably more
naturally, since they carry an explicit state enum instead of encoding it in the
event name. Keep the existing `output_state` payload shape so graphs don't break.

Subscriptions: `EVENT_SUB` in `ws_client.ts` currently sends `Inputs` only.
Scenes and outputs need `Scenes` (`1 << 2`) and `Outputs` (`1 << 6`) added —
both constants already exist in that table.

**`client_lifecycle` does NOT map and must stay.** It tracks vspark render
clients connecting/disconnecting — a vspark concept with no OBS counterpart. It
lives in `ObsManager` only because it shares that manager's per-socket
bookkeeping.

## Constraints

- **Do not break existing graphs.** Node kinds, port names and payload shapes
  stay as they are. This is a transport change behind the same node surface.
- **`client_lifecycle` keeps working with no OBS connection at all** — it must
  not become dependent on obs-websocket, or a plain browser tab stops firing it.
- **Decide the zero-config story explicitly (see step 0).** The browser bridge's
  one real advantage is that it needs no setup: vspark-as-a-browser-source just
  works. obs-websocket needs the server enabled and a password stored. Removing
  the browser path entirely trades reliability for a setup step.
- Do not widen scope into Phase 2 of the power-tier plan (scene items, filters,
  transforms). Those are enumerated there, not built, and stay that way.

## Files in scope

- `packages/backend/src/obs/ws_manager.ts` — new `setScene` / `setTransition` /
  `control` methods; extend `_onObsEvent` for scene + output events.
- `packages/backend/src/obs/ws_client.ts` — widen `DEFAULT_SUBSCRIPTIONS`.
- `packages/backend/src/signal/nodes/obs/{set_scene,set_transition,control,
  scene_changed,output_state}.ts` — repoint at `getObsWsManager()`.
- `packages/backend/src/obs/manager.ts` — keep `client_lifecycle`; retire or
  shrink the rest depending on step 0.
- `packages/frontend/src/obs/bridge.ts` — same.
- `dev-notes/modules/obs.md`, `dev-notes/plans/obs-websocket-tier.md` — record
  that the "out of scope" decision was reversed, and why.

## Out of scope

- Phase 2 nodes (scene items, filters, source transforms).
- Encryption-at-rest for the stored obs-websocket password (tracked project-wide;
  it is one of three plaintext credential stores — see ARCHITECTURE.md
  multi-user note).
- Multi-connection-per-project.

## Approach

### Step 0 — decide the browser bridge's fate (ask before building)

An architectural call the worker should **put to the user first**:

- **(a) ws-preferred, browser fallback.** Nodes use obs-websocket when the
  project has a connection, else fall back to the browser bridge. Keeps
  zero-config working; costs a branch in every action node and makes behaviour
  depend on hidden config.
- **(b) ws-only, browser bridge deleted** (except `client_lifecycle`). One
  transport, one code path, errors always reported. Requires every user to set up
  obs-websocket — a real regression for the zero-config case.
- **(c) ws-only for control, browser retained for events.** Commands are where
  the silent failure bites; events already work fine over the bridge.

(a) is the safest, (b) is the cleanest. The user's phrasing ("migrating to ws
only") points at (b) — confirm before deleting anything.

### Step 1 — extend the ws manager

Add `setScene` / `setTransition` / `control` mirroring the existing `setMute` /
`setVolume`, including the `_clientFor` + `_report` error logging added in #60 so
failures name themselves. Widen `DEFAULT_SUBSCRIPTIONS` and extend `_onObsEvent`
to deliver `obs_scene_changed` and `obs_output_state`, preserving payload shape.

### Step 2 — repoint the nodes, one at a time

Start with `obs_set_scene` — it is the motivating case and the easiest to verify
by eye. Confirm it switches a real scene with page permissions left at default
(that is the whole point) before doing the rest.

### Step 3 — reconcile the browser bridge per step 0

## Acceptance / verification

Needs a real OBS; none of this is provable headless.

- **The headline check**: with the browser source's page permission at its
  **default**, a `clock → obs_set_scene` graph switches the program scene. That
  is the exact scenario that fails today.
- Scene changes made in OBS still fire `obs_scene_changed` with the right name,
  and stream/record/replay/virtualcam transitions still fire `obs_output_state`
  with the same payload shape as before.
- **De-duplication still holds**: with two vspark browser sources open, one OBS
  scene change produces **one** graph fire, not two. (The browser bridge needed a
  400ms dedup window for this because every source reports global events; over ws
  there is a single connection, so the dedup should become unnecessary — verify
  rather than assume, and remove it only if it is genuinely redundant.)
- `client_lifecycle` still fires on client connect/disconnect **with no OBS
  connection configured at all**.
- A failed action logs the reason (`[obs-ws] SetCurrentProgramScene failed: …`)
  rather than silently doing nothing.
- `pnpm lint` + `pnpm test` green.

## Output

Open a PR into `dev` when done. Step 1 + step 2's first node is a shippable
slice on its own — it fixes the silent-failure case without touching anything
else.
