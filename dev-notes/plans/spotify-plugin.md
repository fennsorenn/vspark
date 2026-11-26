# Plan: Spotify plugin

> **Status:** design-only
> Branch: `feature/spotify-plugin`
> Depends on [plugin-system.md](plugin-system.md) phases 1–3 (4 for distribution).
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Goal

A first plugin that lets a streamer connect their Spotify account, control playback and
song requests from Actions (hotkey, chat command, named trigger) and graphs, and show the
current song on stream as a compound layer or as individual cover / title layers.

## Constraints

- **[decided]** (user, 2026-11-26) Contributions: a Spotify account connection; workflow
  nodes and Actions triggered by hotkey, chat command or a generic trigger for
  controlling the queue (adding, skipping, removing, …); a compound layer for the
  current song plus individual layers for just the cover or the name.
- **[observed]** (Spotify Web API, to re-verify at implementation time)
  - Authorization Code **with PKCE** works without a client secret.
  - Redirect URIs must be HTTPS or a **loopback IP literal** (`http://127.0.0.1:<port>/…`);
    `localhost` is rejected.
  - Apps in development mode only work for allow-listed users; every streamer registers
    their own app (like the Twitch app credentials in Overlive) and is its owner.
  - Player **control** endpoints (play/pause/next/previous/volume/add-to-queue) need
    **Spotify Premium**; reading the current track does not.
  - The queue is **read-only** apart from "add": there is no endpoint to remove or
    reorder queue items. Playlists *can* be edited.
  - No push/webhook for playback changes — the current track must be **polled**; rate
    limits answer 429 with `Retry-After`.
- **[decided]** (user, 2026-11-26) Song-request moderation in v1: per-user request
  limit, max track length, explicit filter, blocklist (tracks/artists), and cooldowns
  both **per user** and **global**.
- **[decided]** (user, 2026-11-26) The plugin's source lives in a separate repository,
  `vspark_spotify`.
- **[decided]** (user, 2026-11-26) Song requests use the **managed queue** (below).
- **[decided]** (user, 2026-11-26) One Spotify account per project is enough; accounts are
  per project (like Twitch). Nodes keep an `account` port (empty = the project's
  account) so more could be supported later without a graph change.
- **[decided]** (existing) No per-second updates from the backend; progress counts in the
  page (feed template helpers).

## Design (Claude's proposal, not decided)

### Account

Provider `spotify`, auth `oauth_pkce` through the plugin-system account store. Setup
wizard in the Accounts window: "create an app at developer.spotify.com → paste Client
ID → add this redirect URI: `http://127.0.0.1:<port>/api/plugin-auth/spotify/spotify/callback`".
Scopes: `user-read-playback-state`, `user-read-currently-playing`,
`user-modify-playback-state`, `playlist-read-private`, `playlist-modify-private`,
`playlist-modify-public`, `user-library-modify`. Identity: display name + product
(`premium` / `free`) — a free account shows a "control needs Premium" warning. Status
`needs_reauth` on a revoked refresh token, as for Twitch.

### Playback monitor (backend service)

Per account in use (`ctx.logic.hasConsumers` or a layer bound to its channel): poll
`GET /me/player` every ~3 s, ~1 s in the last 10 s of a track when the managed queue is
on, back off on 429 / idle. Diffs produce events:

- `track_changed`, `playback_state` (playing / paused / stopped), `device_changed`.
- Data channel `spotify.now_playing` (per account; default account also on the bare
  name): `{ title, artists, album, coverUrl, coverUrlSmall, trackUrl, durationMs,
  progressMs, startedAt, isPlaying, requestedBy }`. `startedAt` + `isPlaying` let the
  page draw progress without backend ticks.
- Data channel `spotify.requests`: the managed request queue (below).

### Song requests and "removing" — the managed queue

Because Spotify cannot remove from its queue, requests are held **by vspark**:
`requests[] { id, trackUri, title, artist, durationMs, requestedBy, requestedAt }`,
persisted in `ctx.storage` per project/account. Shortly before the current track ends
(~5–10 s, configurable) the next request is pushed with `POST /me/player/queue`. Until
then it can be removed, reordered, or vetoed. This makes `!wrongsong`, mod removal, a
per-user limit and an on-stream request list possible.

Not built in v1 (Claude's proposal, not decided): a **direct** mode (add straight to
Spotify's queue; no remove) as a fallback setting, and a **playlist** mode (requests go
into a chosen playlist; removal edits the playlist) if the hand-off timing proves
unreliable.

### Signal nodes (`spotify_*`, tag `spotify`)

| Kind | Type | Ports |
|---|---|---|
| `spotify_now_playing` | value + events | in `account`; out `title`, `artist`, `album`, `coverUrl`, `trackUrl`, `durationMs`, `progressMs`, `isPlaying`, `requestedBy`, `data`; events `changed`, `stateChanged` |
| `spotify_play` / `_pause` / `_toggle` / `_next` / `_previous` | sink | in `fire`, `account`; out `done`, `failed`, `error` |
| `spotify_set_volume` | sink | `fire`, `account`, `volume` (0–100 or ±step) |
| `spotify_search` | transform | `fire`, `query` → `trackUri`, `title`, `artist`, `found`/`notFound` |
| `spotify_request_add` | sink | `fire`, `query` (text, track URL or URI), `user`, `account` → `queued` (title, artist, position), `rejected` (reason: not found / limit / too long / explicit / duplicate / blocked) |
| `spotify_request_remove` | sink | `fire`, `which` (`last_of_user` / `position` / `id`), `user`/`position` → `removed`, `notFound` |
| `spotify_request_skip` | sink | skip the current track (Spotify next) and, in managed mode, push the next request first |
| `spotify_request_clear` | sink | clear the request queue |
| `spotify_queue` | value | `requests` list, `count`, `next` |
| `spotify_playlist_add` / `_remove` | sink | current or given track ↔ a playlist |
| `spotify_like` | sink | save the current track to Liked Songs |

All sinks follow the Overlive outbound-node pattern (empty `account` = project default).

### Actions

- **Response types** (usable from Hotkey, Chat keyword, Keyword combo, Redemption and the
  new Named trigger kind): `spotify_toggle`, `spotify_next`, `spotify_previous`,
  `spotify_volume` (`volume`/`step`), `spotify_like`, `spotify_playlist_add`
  (`playlistId`), `spotify_request_skip`, `spotify_request_clear`.
- **Action kind `spotify_song_request`** — "Song request". Shape setting `source`:
  `chat_command` (command + aliases, the query is the args) | `redemption` (reward title,
  the query is the message) | `trigger` (named trigger, the query is the payload).
  Value settings: `account`, `minRank`, global cooldown, per-user cooldown, max requests
  per user (pending in the queue), max track length, block explicit, blocklist
  (track / artist URIs or names), allow only from a playlist (optional), reply templates for
  queued / rejected (`${title}`, `${artist}`, `${position}`, `${reason}`, `${user}`).
  Built from the shared chat helpers (`addRankGate`, `addCooldown`, `Tpl`). Per-user
  cooldown: a second `cooldown` node whose `group` is rendered by `text_format`
  from the username (the `derived.comboKey` trick); observed 2026-11-26 the `cooldown`
  node has no per-key input, so this needs no node change. Track-dependent rules
  (length, explicit, blocklist, duplicate) are checked in `spotify_request_add` after
  the search and reported as `rejected` reasons.
- **Action kind `spotify_chat_command`** — one chat command with an `operation`
  (shape): `current_song` (reply with title/artist/link), `wrong_song` (remove the
  user's last request), `remove` (mod: by position), `queue` (reply with the next N),
  `skip` (mod). Defaults: `!song`, `!wrongsong`, `!queue`.
- **Starter set** button in the Actions panel: creates `!sr`, `!song`, `!wrongsong`,
  `!queue` disabled, for the user to review and enable.

### Layers (composites, all built on core `feed` layers)

| Composite | Parts | Settings |
|---|---|---|
| `spotify_now_playing` | `panel` (feed layer root), `flow` (logic, optional show-on-change) | account, layout (cover left / cover top / text only), show progress bar, show requester, visibility (always / while playing / for N s after a change), font, colours, corner radius |
| `spotify_cover` | `panel` | account, size, radius, shadow, placeholder when nothing plays |
| `spotify_title` | `panel` | account, format (`${title} — ${artist}`), scrolling marquee for long titles, font, colour |
| `spotify_requests` | `panel` | account, number of entries, show requester |

Because these render through feed layers and data channels, they work in the output
window, OBS capture and for remote peers without plugin frontend code. Needs one core
addition: a feed-template `<Progress>` / `<Elapsed>` helper (alongside `<Countdown>`)
driven by `startedAt` / `durationMs` / `isPlaying`.

## Files in scope

In the `vspark_spotify` repository (decided):

- `plugins/spotify/plugin.json`, `src/backend/` (client with token refresh + 429 backoff,
  monitor, request queue, nodes, account provider), `src/shared/` (action kinds,
  response types, composite types), `presets/` (composite payloads), `locales/{en,de}/`,
  `help/{en,de}/spotify.md`, `test/`.
- `packages/frontend/src/lib/feedTemplate.tsx` — `<Progress>` helper (core).

## Out of scope

- Song requests from other platforms' links (YouTube, Apple Music, …) — not ruled out,
  but out of scope for now (user, 2026-11-26). v1 accepts Spotify links / URIs and text
  search.
- 3D variants of the layers; lyrics; audio analysis (endpoint deprecated for new apps);
  Spotify Connect device picker UI beyond a node input; other music services (the
  plugin keeps service-specific naming so a later "music" abstraction can sit on top).

## Approach

1. Account provider + client (refresh, 429 handling, Premium detection).
2. Monitor + `spotify_now_playing` + data channel; composites `spotify_cover`,
   `spotify_title`, `spotify_now_playing` (core `<Progress>` helper).
3. Control nodes + response types.
4. Managed request queue + request nodes + `spotify_song_request` /
   `spotify_chat_command` kinds + `spotify_requests` layer + starter set.
5. Help pages (en/de) with the app-registration walkthrough; e2e against a fake Spotify
   API.

## Acceptance / verification

- Unit tests against a stubbed Spotify API: token refresh persists rotated tokens,
  429 respects `Retry-After`, monitor emits `track_changed` once per change, managed
  queue hands off at the right moment and never double-queues, `!wrongsong` removes only
  the caller's last request.
- Action templates build and run through the engine (like `actions.kinds.test.ts`).
- e2e: install the plugin from a local registry, connect a fake account, add the Now
  Playing composite, push a fake track change, see title + cover in the layer.
- Manual: real account, Premium and free, hotkey skip, `!sr <url>` / `!sr <search>`,
  `!wrongsong`, layer in OBS.

