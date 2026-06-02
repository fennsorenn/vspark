# Overlive Integration

**Status: Implemented.** Branch `feature/overlive-integration`.

Integrates the [`overlive`](https://github.com/) SDK (`~/projects/overlive`) into vspark so signal graphs can react to live-stream events from Twitch and StreamElements (subs, bits, chat, redemptions, raids, follows, ads, ban, stream online/offline, etc.).

Depends on [project-graphs.md](project-graphs.md): the 13 Overlive event nodes are intended for project-scoped standalone graphs (they need no component context) and consume the `Account` port type.

## Overlive packages consumed

- `@overlive/core` — shared kit / event bus (`OverliveKit`, `AdapterStateSnapshot`, `AdapterEmittedEvent`)
- `@overlive/twitch` — Twitch EventSub / IRC adapter (`TwitchAdapter`)
- `@overlive/twitch-oauth` — OAuth code flow, refresh, `revokeAccessToken`, `buildAuthorizeUrl`, `exchangeCode`, `fetchAuthorizedUser`, `DEFAULT_SCOPES`
- `@overlive/se` — StreamElements adapter (`SEAdapter`, JWT-authenticated)

All four are published to npm and pinned via standard semver ranges in `packages/backend/package.json`. CI installs from the registry like any other dep.

## Local development against a local overlive checkout

When you want vspark to consume your local `~/projects/overlive/` working tree instead of the published packages — for cross-repo edits — use `pnpm link --global`. Do **not** edit `package.json` to point at the local path; it'll get committed and break CI.

One-time per overlive package you want linked:

```bash
cd ~/projects/overlive/packages/core && pnpm link --global
cd ~/projects/overlive/packages/twitch && pnpm link --global
cd ~/projects/overlive/packages/twitch-oauth && pnpm link --global
cd ~/projects/overlive/packages/se && pnpm link --global
cd ~/projects/overlive/packages/emotes && pnpm link --global
```

Then in vspark:

```bash
cd ~/projects/vspark
pnpm link --global @overlive/core @overlive/twitch @overlive/twitch-oauth @overlive/se @overlive/emotes
```

Gotchas:
- `pnpm install` (any kind) wipes the links. You have to re-run the second command after every install.
- Overlive's TS sources are linked directly; vspark will type-check against the local source, not the published `.d.ts`. Mismatches between published version and your local can mask compile errors until you publish.
- To go back to the published versions: `pnpm unlink --global @overlive/core ...` then `pnpm install`.

## Concepts

| Concept | Description |
|---------|-------------|
| App credential | Per-project Twitch dev-app: `client_id` + `client_secret` + `redirect_uri`. Stored plaintext (single-user assumption — see ARCHITECTURE Future Features). |
| Account | A logged-in identity: Twitch channel (OAuth) or SE connection (JWT). Owned by a project. Twitch rows reference an `app_credential_id`; SE rows leave it NULL. |
| OverliveManager | Backend singleton (init'd in `src/index.ts`). Owns one shared `OverliveKit` **per loaded project**, registers one adapter per account row, fans inbound events into running project graphs. |
| `Account` port | Signal-graph value port (`Account` in `SignalTypeMap`, colour `#9146ff` in `SIGNAL_TYPE_COLORS`). Resolves to an account row id at runtime; consumed by every Overlive event node. |

## DB

Two migrations, both per-project, both cascade on project delete.

### `overlive_app_credentials` — migration 012

| Column | Notes |
|---|---|
| `id`, `project_id`, `label` | |
| `client_id`, `client_secret` | Plaintext today. |
| `redirect_uri` | Whatever the user registered at dev.twitch.tv (may be a tunnel domain, not this backend's origin). |
| `created_at`, `updated_at` | |

### `overlive_accounts` — migration 013

| Column | Notes |
|---|---|
| `id`, `project_id`, `label` | |
| `platform` | `twitch` | `streamelements` |
| `app_credential_id` | FK to `overlive_app_credentials(id)` ON DELETE SET NULL. NULL for SE rows. |
| `credentials` | JSON. Shape depends on platform: Twitch `{ accessToken, refreshToken, scopes[], expiresAt? }`, SE `{ jwt, channelId }`. |
| `broadcaster_id`, `broadcaster_login` | Twitch user_id + login, or SE channel id (login NULL). |
| `status` | Last known: `connected | connecting | reconnecting | disconnected | error | needs_reauth`. |
| `status_reason` | `AdapterStateReason` (e.g. `token_revoked`, `scope_missing`) when error/needs_reauth. |
| `status_message` | Free-form. |

## REST surface

### `routes/overlive-accounts.ts` — CRUD

| Method + path | Purpose |
|---|---|
| `GET  /api/projects/:projectId/overlive-app-credentials` | List apps. |
| `POST /api/projects/:projectId/overlive-app-credentials` | Register an app (`label`, `clientId`, `clientSecret`, `redirectUri`). |
| `PUT  /api/overlive-app-credentials/:id` | Patch any field. |
| `DELETE /api/overlive-app-credentials/:id` | Delete app (referencing accounts have `app_credential_id` nulled by the FK). |
| `POST /api/projects/:projectId/overlive-app-credentials/copy-from/:sourceProjectId` | Copy all apps from another project (new ids, original labels). UX shortcut so users don't re-enter the same dev.twitch.tv app per project. |
| `GET  /api/projects/:projectId/overlive-accounts` | List accounts. |
| `POST /api/projects/:projectId/overlive-accounts` | Manual create — rarely used for Twitch (prefer OAuth flow); the only way to add SE (`{ platform: 'streamelements', label, credentials: { jwt, channelId } }`). |
| `PUT  /api/overlive-accounts/:id` | Patch label / credentials / status fields. Triggers `OverliveManager.refreshProject()`. |
| `DELETE /api/overlive-accounts/:id` | Calls `OverliveManager.beforeAccountDelete()` first (revokes Twitch tokens, removes adapter), then deletes the row, then reconciles the kit. |

### `routes/overlive-auth.ts` — OAuth

| Method + path | Purpose |
|---|---|
| `GET /api/auth/twitch/start?projectId=&appCredentialId=[&accountId=]` | Mint CSRF state, return `{ authorizeUrl }` for the popup to navigate to. `forceVerify` is set only when `accountId` is present (reconnect flow). |
| `GET /api/auth/twitch/callback?code=&state=` | Verify state, exchange code → tokens, fetch user identity, insert (or update if `accountId` was carried in state) the row, return an HTML page that posts to `window.opener` and auto-closes. |

OAuth flow shape:

- CSRF state is held in an **in-memory map** with 10-minute TTL (`pendingStates`, gc'd lazily). Multi-instance backends would need a shared store — flagged.
- Callback HTML posts `{ source: 'overlive-oauth', payload: { ok, accountId?, login?, displayName?, message? } }` to `window.opener` and `window.close()`s on success.
- **Reconnect** uses the same endpoint with an `accountId` query param. The callback updates the row in place — **id stays stable** so any signal graph referencing the account by id keeps working.

## OverliveManager — `overlive/manager.ts`

One `OverliveKit` per loaded project, lazily instantiated on first account or first project-graph reference. Account row id is the kit's adapter `instanceId`.

Lifecycle hooks:

- `startAll()` — boot-time. Loads `DISTINCT project_id FROM overlive_accounts` and calls `refreshProject(id)` for each, so the adapters register and connect at boot. (It previously only called `ensureProject`, which creates the kit and wires the event listener but never registers/connects any adapter — so on a fresh boot no adapter ever connected, no EventSub subscriptions were made, and no events arrived. Fixed by routing through `refreshProject`.)
- `refreshProject(projectId)` — reconciles registered adapters with the current account rows. Idempotent. Called after every account mutation. Tears down the kit if no accounts remain.
- `beforeAccountDelete(accountId)` — removes adapter from the kit; for Twitch rows with an app credential, calls `revokeAccessToken({ clientId, accessToken })` from `@overlive/twitch-oauth` (best-effort) before the row is dropped.
- `close()` — disconnects all kits.

State + token persistence:

- `kit.on('adapter.state', snap => ...)` translates `AdapterStateSnapshot.state` (+`reason`) into the column-shaped `status` and writes `status` / `status_reason` / `status_message` back to `overlive_accounts`. Then broadcasts `overlive_account_status` over the WS bus (`{ accountId, status, reason, message }`).
- `onTokenRefreshed` callback on `TwitchAdapter` persists rotated `{ accessToken, refreshToken, expiresAt }` back to `credentials` so refresh survives restarts.

Event routing:

- `kit.onAny(event => routeEvent(projectId, event))`.
- `routeEvent` walks `projectGraphManager.iterateNodes()`, skips graphs from other projects, matches `node.kind` against the `OVERLIVE_KIND_BY_EVENT` table (e.g. `chat.message` → `overlive_chat_message`), then filters by the node's `defaultConfig.account` (must match `event.sourceInstanceId`) and optional `defaultConfig.channel` (lowercased, empty = any). Matching nodes get the event fired into their `event` input port via `projectGraphManager.fire(graphId, nodeId, 'event', mkEvent(event))`.
- The event MUST be wrapped with `mkEvent(event)` from `@vspark/shared/signal` before firing. The node helper `_helpers.ts handleOverliveEvent` reads `inputs.event.payload` (the signal engine's `Event<T>` envelope). Firing the raw overlive event (which has no `.payload`) made every node see `undefined` and emit empty outputs — the bug that `mkEvent` fixes.
- Per-event filtering on top of this (command name, reward id, tier, etc.) happens inside the node's `execute()`.

## Signal node kinds (13)

All live under `signal/nodes/overlive/`. Every node shares the same port shape:

- **Value inputs**: `account: Account`, `channel: String`, plus event-specific filters where applicable.
- **Event input**: `event: Any` — entry point used by `OverliveManager.routeEvent`.
- **Outputs**: `event: Trigger` (fires on a matching delivery) + typed value ports for payload fields.

The shared `handleOverliveEvent(...)` helper in `signal/nodes/overlive/_helpers.ts` is the standard wrapper: on the `event` trigger path it unwraps the payload, runs the optional `matches` predicate, stores `setState(out)` and emits, on the pull path it returns the last-known state (or supplied empties).

| Kind | Source event | Filter inputs (beyond account/channel) | Notable outputs |
|---|---|---|---|
| `overlive_redemption` | Channel-point redemption | `rewardId` | `username`, `displayName`, `rewardTitle`, `cost`, `userInput` |
| `overlive_subscription` | New / resub | `tier`, `isGift` | `username`, `tier`, `months`, `isGift`, `message` |
| `overlive_gift_bomb` | Multi-gift sub | `tier` | `gifter`, `count`, `tier` |
| `overlive_raid` | Incoming raid | min viewers | `raider`, `viewers` |
| `overlive_follow` | New follow | — | `username`, `displayName` |
| `overlive_chat_message` | Chat message | (user/contains/badges via downstream nodes) | `username`, `displayName`, `text`, `isMod`, `isSub`, `isBroadcaster` |
| `overlive_chat_command` | Chat message starting with the prefix | `command` (case-insensitive, no prefix; empty = any) | `command`, `args` (space-joined), `text`, `isMod`/`isSub`/`isBroadcaster` |
| `overlive_chat_delete` | Message deletion | — | `messageId`, `username` |
| `overlive_ad_start` | Ad break started | — | `duration` |
| `overlive_ad_end` | Ad break ended | — | — |
| `overlive_ban` | User banned/timed out | — | `username`, `isPermanent`, `duration` |
| `overlive_stream_online` | EventSub `stream.online` | — | `startedAt` |
| `overlive_stream_offline` | EventSub `stream.offline` | — | — |

`overlive_*` event currency-kind / reward-id / command / tier / `isGift` filters are read from `config.<field>` on `execute()` and short-circuit before `setState`/emit. See `chat_command.ts` for the canonical pattern.

`OverliveManager` also owns a bounded per-project **chat ring-buffer** pushed on every `chat.message` event; the `overlive_chat_feed` node is a thin accumulating view over it (the durable counterpart of the latest-message-only `overlive_chat_message`). Feed → `set_data` → `feed` compose layer is the chat-overlay pipeline — see [data-channels.md](data-channels.md).

The `Account` port type is registered in `packages/shared/src/signal.ts` (`SignalTypeMap.Account: string`, colour `#9146ff` in `SIGNAL_TYPE_COLORS`). It is set today via the inline account dropdown in `SignalNodeCard` (the dropdown is data-bound to the editor store's `overliveAccounts`). The port type accepts a connected source, but there is no literal `account_value` node yet — connections from another node's `Account` output are the only non-inline source.

## Frontend — `components/editor/OverliveAccountsModal.tsx`

Opened from `TopBar`. Two sections:

1. **Twitch Apps** — list with delete; `+ Register App` opens a sub-dialog with a 4-step walkthrough to dev.twitch.tv plus a "Copy from another project" picker.
2. **Accounts** — list with status pills (`Connected` / `Connecting…` / `Reconnecting…` / `Disconnected` / `Error` / `Needs Reauth`) colour-coded; `+ Twitch` launches OAuth (auto-picks the only registered app, or opens a picker dialog when multiple exist); `+ StreamElements` opens a JWT form. Each row has a `Reconnect` button when status is `error` or `needs_reauth` (Twitch only — fires the OAuth start endpoint with the existing `accountId`).

The modal mirrors its local `accounts` state into `editorStore.overliveAccounts` so the signal-graph `Account` port dropdowns refresh without waiting for the next Editor mount. It also listens for `window` `message` events from the OAuth popup (`source: 'overlive-oauth'`) and refreshes the account list immediately on success.

## Security note

App secrets, OAuth refresh tokens, and SE JWTs are stored plaintext in SQLite under the current single-user assumption. See ARCHITECTURE.md "Future Features / Planned → Multi-user usage" — this MUST become encrypted-at-rest before any multi-user mode lands.
