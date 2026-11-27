# Plan: Secrets on the mesh — check the extracted mesh repo, then decide

> **Status:** design-only (handoff to a local session, 2026-11-27)
> **Follows:** [plugin-system.md](plugin-system.md) (phases 1–4 shipped on
> `claude/sharp-davinci-ig0xws`); mesh principle 9 in
> [../modules/mesh.md](../modules/mesh.md#core-principles).
> Branch: start from `claude/sharp-davinci-ig0xws` (or `dev` once it is merged); new
> work goes on `feature/mesh-secrets` in vspark, and on whatever branch convention the
> mesh repo uses there.
> This plan is the seed context for a **local** session: it needs the mesh extraction
> repository, which exists only on the user's machine, and `gh`. It is a starting
> point, not an airtight spec — the session is interactive and should ask the user to
> refine it.

## Goal

Find out whether the mesh extraction project already implements **secrets** (mesh
principle 9: "Secrets are a grant pattern — own rtype, write-only, never granted to
remote peers, encrypted at rest"). If it does, plan how vspark adopts it for plugin
app secrets and the existing credentials. If it does not, propose the design to the
user before building anything.

## Why now

The plugin system's account providers (`packages/backend/src/plugins/accounts/`) only
accept **non-secret** app fields (`defineProvider` refuses `secret: true`), because
vspark has no way to move a secret over the mesh. PKCE providers (Spotify) work; a
provider that needs a client secret cannot be supported yet. The user asked whether a
secret type exists (2026-11-27). In this vspark checkout it does not:
`packages/mesh/src` and `packages/shared/src/models.ts` have no secret rtype, no
write-only right, no encryption.

## Constraints

- **[decided]** (user, 2026-10-04) Mesh principle 9: every participant authenticates;
  whitelist grants; nothing reachable without a grant; **secrets are a grant pattern —
  own rtype, write-only, never granted to remote peers, encrypted at rest**, not a
  separate channel.
- **[decided]** (user, 2026-10-04) Principle 7: the mesh is the only client↔server
  channel; REST stays for outside callers and writes through the mesh. A reason not to
  use the mesh is evidence of a missing mesh feature.
- **[decided]** (user, 2026-11-26) Plugin accounts are per project; tokens never leave
  the server.
- **[observed]** How vspark handles credentials today (commit dc49ce5,
  `bugfix/secrets-quick-fixes`, merged): all **write-only over REST**, stored
  **plaintext**, reads return only a `has…` flag:

  | Credential | Where | Read returns |
  |---|---|---|
  | Twitch app `client_secret` | SQLite `overlive_app_credentials` | `hasClientSecret` |
  | Twitch / SE tokens, SE JWT | SQLite `overlive_accounts.credentials` | nothing (SE `channelId` only) |
  | OBS websocket password | SQLite `obs_connections.password` | `hasPassword` |
  | Assistant API key | `config.json` (mode 0600) | `hasApiKey` |
  | Plugin account tokens | SQLite `plugin_accounts.credentials` (server-only column, not in the `plugin_account` document) | nothing |

  Migration 012 notes encryption at rest is required before multi-user support.
- **[observed]** The tab side has the building blocks a write-only path could use:
  `Collection.request` / `reply` on the `control` channel (unstamped, not retained,
  addressed — used by the Plugins window's `plugin_command`), field-level read grants
  with one egress projection (`packages/mesh/src/grants.ts`).
- **[observed]** `mesh-store-surface.md` lists "extracting the mesh packages into a
  separate repository" as out of scope there; the extraction is a later, separate
  project the user has started locally.

## Steps

1. **Locate and read the mesh repo.** Ask the user for its path if it is not obvious.
   Note its relation to `packages/mesh`, `packages/mesh-react`,
   `packages/mesh-transports` (copied? diverged? published?). Use `gh` for its
   issues / PRs / branches if it has a remote.
2. **Look for secrets**, and report what exists with file references:
   - a secret / credential rtype or collection option (e.g. `secret: true`,
     `writeOnly`, a `write` right without `read`);
   - grant rules: write-only grants, a rule that secrets are never granted to remote
     peers, egress projection that drops secret values;
   - encryption at rest (key source, KDF, where the key lives), and whether replicas
     and tombstones ever hold plaintext;
   - how a reader learns "is set" (a `has` flag / stamp only);
   - tests covering these.
   Also check for a **secure transport channel** (encrypted links between peers) and
   say whether it is the same thing or separate — the user called it "the secure
   channel".
3. **Report to the user** before writing code: what the repo has, what is missing
   against principle 9, and whether vspark can adopt it as-is.
4. **If it exists**, propose an adoption plan (as a section in this file):
   - plugin providers' secret app fields (`AppField.secret`, `defineProvider`,
     `plugin_app`, `PluginAccountsSection`, `guards.ts`);
   - the existing credentials in the table above, each as its own migration step
     (rtype, data migration from the plaintext columns, REST routes kept for outside
     callers writing through the mesh);
   - whether vspark should consume the extracted package or keep `packages/mesh` in
     sync — ask the user.
5. **If it does not exist**, propose a design (ask before building): Claude's
   suggestion from 2026-11-27 for the plugin case alone was a write-only `control`
   request that the server stores in a server-only column, with the readable document
   carrying only `hasSecret: { <field>: true }` — the same guarantees as today's REST
   credentials, but on the mesh. Present it as the stop-gap it is, next to the full
   principle-9 design.

## Out of scope

- Changing the plugin system's other parts.
- Multi-user / remote access to secrets (principle 9 forbids granting them to remote
  peers anyway).
- Publishing / extracting packages, unless the user asks.

## Acceptance / verification

- The user gets a written answer to "does the mesh repo have secrets / the secure
  channel?" with file references, and a proposed next step they approve or change.
- Any code change follows vspark's CLAUDE.md: tests (backend `makeTestApp`, mesh
  `packages/mesh/test` patterns such as `control.test.ts` / `grants.test.ts`), i18n EN +
  DE for UI, docs updated (`dev-notes/modules/mesh.md`, `plugins.md#accounts`).

## Output

A report to the user first. Code only after they decide; then commits on
`feature/mesh-secrets` (vspark) and the mesh repo's own branch, merged per each repo's
conventions.
