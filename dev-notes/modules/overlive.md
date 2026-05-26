# Overlive Integration

**Status: WIP.** Branch `feature/overlive-integration`.

Integrates the [`overlive`](https://github.com/) SDK (`~/projects/overlive`) into vspark so signal graphs can react to live-stream events from Twitch and StreamElements (subs, bits, chat, redemptions, raids, follows, ads, ban, stream online/offline, etc.).

Depends on [project-graphs.md](project-graphs.md): Overlive event nodes are intended primarily for project-scoped standalone graphs (they don't need a component context), and consume the new `Account` port type.

## Overlive packages consumed

- `@overlive/core` — shared kit / event bus
- `@overlive/twitch` — Twitch EventSub / IRC adapters
- `@overlive/twitch-oauth` (new) — OAuth code flow + refresh-token handling
- `@overlive/se` — StreamElements adapter (JWT-authenticated)
- `@overlive/emotes` — emote resolution

## Concepts

| Concept | Description |
|---------|-------------|
| App credentials | Per-project Twitch app `client_id` + `client_secret`. Stored plaintext (single-user assumption — see ARCHITECTURE Future Features). |
| Account | A logged-in identity (Twitch channel via OAuth, or SE connection via JWT). Owned by a project. |
| OverliveManager | Backend singleton-per-loaded-project. Runs one shared `OverliveKit` and fans events into all subscribed signal graphs. |
| `Account` port | New signal-graph port type. Resolves to an account reference at runtime; consumed by every Overlive event node. |

## Backend (planned layout)

- `packages/backend/src/overlive/manager.ts` — `OverliveManager`: kit lifecycle, account login/logout, event fan-out.
- `packages/backend/src/overlive/oauth.ts` — Twitch OAuth code flow + refresh.
- `packages/backend/src/routes/overlive.ts` — REST: app credentials CRUD, accounts CRUD, OAuth callback, SE JWT add/remove.
- DB migrations (planned):
  - `app_credentials` — per-project Twitch `client_id` / `client_secret`.
  - `overlive_accounts` — per-project accounts: provider (`twitch` | `se`), channel/login, refresh token or JWT, scopes, expires_at.
- `packages/backend/src/signal/nodes/overlive_*.ts` — 13 event node kinds (see below).

## Frontend (planned)

- Accounts modal opened from the editor top bar (`components/editor/TopBar.tsx`).
  - Manage app credentials.
  - List accounts; "Add Twitch account" launches OAuth; "Add StreamElements account" takes a JWT.
- Node palette adds an "Overlive" category for the 13 event nodes.
- New `Account` port type in `packages/shared/src/signal.ts`; rendered with an account picker in the signal-graph canvas.

## Signal node kinds (planned, 13)

All event nodes share the same shape:

- Inputs: `account: Account`, `channel?: string` (filter), plus event-specific filter inputs.
- Outputs: one `event` output carrying the typed payload, plus typed value outputs unpacking common fields.

| Kind | Source event |
|------|--------------|
| `overlive_redemption` | Channel-point redemption (filter by reward id/title) |
| `overlive_subscription` | New / resub (filter by tier) |
| `overlive_gift_bomb` | Multi-gift sub event |
| `overlive_raid` | Incoming raid (filter by min viewers) |
| `overlive_follow` | New follow |
| `overlive_chat_message` | Chat message (filter by user, contains, badges) |
| `overlive_chat_command` | Chat message starting with `!command` (configurable prefix) |
| `overlive_chat_delete` | Message deletion |
| `overlive_ad_start` | Ad break started |
| `overlive_ad_end` | Ad break ended |
| `overlive_ban` | User banned/timed out |
| `overlive_stream_online` | EventSub stream.online |
| `overlive_stream_offline` | EventSub stream.offline |

## Open questions / TBD

- Whether emote resolution (`@overlive/emotes`) is exposed as a separate utility node or folded into `overlive_chat_message`.
- Persistence of last-seen event for replay-on-graph-restart (probably not).
- Multi-account-per-graph: confirmed allowed (each event node picks its own account input).

## Security note

App secrets, OAuth refresh tokens, and SE JWTs are stored plaintext in SQLite under the current single-user assumption. See ARCHITECTURE.md "Future Features / Planned → Multi-user usage" — this MUST become encrypted-at-rest before any multi-user mode lands.
