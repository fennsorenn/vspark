# Plugins

**Status: Implemented — plugin-system phases 1–4** (plan:
[plans/plugin-system.md](../plans/plugin-system.md); first plugin:
[plans/spotify-plugin.md](../plans/spotify-plugin.md)). Phase 5 (the plugin repo's
CI, the npm publish of the SDK) lives outside this repo.

A plugin extends vspark without a release: signal-graph nodes, Action kinds and
response types, composites (layer widgets), account providers, i18n strings and help
pages. Plugins are installed from a registry manifest in git, from inside the editor.

## Decisions

- **Decided (user, 2026-11-26):** installed and managed in the editor; the list comes
  from a manifest in a git repository — for now `plugins/registry.json` in this repo,
  URL configurable in the app.
- **Decided (user, 2026-11-26):** only the official registry is trusted by default; a
  third-party registry needs an explicit "trusted" opt-in. Plugins run unsandboxed.
- **Decided (user, 2026-11-26):** first-party plugin source lives in separate repos
  (`vspark_spotify`; new plugins start from `vspark_plugin_template`).
- **Decided (user, 2026-11-26):** SDK typings are published to npm (`@vspark/plugin-sdk`).
- **Decided (user, 2026-11-26):** plugins are per installation; plugin accounts are per
  project (like Twitch).
- **Decided (user, 2026-11-26):** a restart is acceptable where live activation would
  be hacky.
- **Decided (user, 2026-11-27):** plugin code reaches the editor as static files; the
  list, status, locales, help and all management travel over the mesh (principle 7).
- **Decided (user, 2026-11-27):** installed plugins are shared with peers by **name
  only**, so a peer can say which plugin a node it cannot run needs.

## Package format

A release zip, unpacked to `<install dir>/plugins/<id>/<version>/`
(`VSPARK_PLUGINS_DIR` overrides; `paths.ts`):

```
plugin.json   id, version, apiVersion (1), vspark (semver range), name, description,
              author, homepage, entries { backend, shared, ui }, network (hosts)
backend.mjs   export default (sdk) => ({ activate(ctx) { … } })
shared.mjs    export default (sdk) => ({ responseTypes, actionKinds, compositeTypes,
              compositePresets })          — loaded by backend AND editor
locales/<lng>/*.json   merged into i18n namespace `plugin-<id>`
help/<lng>/*.md        help topics `plugin-<id>` (index.md) / `plugin-<id>-<page>`
```

**The SDK is injected, never bundled.** Node display and port metadata live in
module-level WeakMaps in `@vspark/shared/*`; a plugin that bundled its own copy would
register into maps the engine never reads. So every entry is a factory receiving the
host's SDK, and node classes are defined inside it. `registerNodeKinds` refuses a class
without the host's `@SignalNode` metadata (that mistake surfaces at load, not in a
graph). Types: `packages/plugin-sdk` (types only; `apiVersion` 1).

Backend SDK (`loader.ts` `BACKEND_SDK`): `apiVersion`, `actions`
(`PLUGIN_ACTIONS_SDK` from `@vspark/shared/actions`: `Tpl`, `addRankGate`,
`addCooldown`, `commandNames`, `commandPattern`, `escapeRegExp`, `rewardPattern`,
`normalizeRank`, `normalizeCooldown`, `sources`), `signal` (`Node`, `SignalNode`,
`eventIn/Out`, `valueIn/Out`, `listIn`, `mkEvent`), `fetch`. The editor's shared
factory gets `apiVersion` + `actions`. `ui.mjs` is reserved (not loaded yet).

## Contribution ids and labels

Every id starts with `<pluginId>_` (`checkContributionId`). Labels are i18n keys in the
plugin namespace (`plugin-<id>:<key>`; qualified at registration by `pluginKey`):

| Contribution | Registry | Labels |
|---|---|---|
| Node kind | `registerNodeKinds` (backend `signal/registry.ts`) | `@SignalNode` label (English; node labels are not translated in vspark) |
| Response type | `registerResponseType` (`@vspark/shared/actions`) | `label`, `form[].label/hint` |
| Action kind | `registerActionKind` | `kinds.<kind>.label/description`, preview `msg` keys, `form[]` |
| Composite type | `registerCompositeType` (`@vspark/shared/composites`) | `type.<type>`, `group.<g>`, `setting.<key>`, `option.<key>.<o>` |
| Composite payload | `registerBuiltinComposite` (backend), from `compositePresets` via `compositePreset.ts` | preset id `plugin:<id>:<type>` |
| Palette entry | `registerCompositeDef` (editor), from `compositePresets` | as composite type |

Generated forms (`SchemaForm.tsx`) render `FormField`s: text, textarea, number,
slider, select (option labels `option.<path>.<value>`), toggle, color, duration,
account (`overlive` or a plugin provider), rank, cooldown, list; `when` hides a field.

## Backend host (`packages/backend/src/plugins/`)

- `loader.ts` — `PluginHost`: `loadAll` (enabled installed plugins from `state.json` +
  config `plugins.dev` folders), `load` (validate `plugin.json` → API / version check →
  shared factory → register → backend factory → `activate(ctx)`); **all-or-nothing**:
  a throwing activate runs the plugin's disposers and unregisters everything it added;
  the plugin shows `failed`, boot continues. `closeAll`, `browserFile` (what
  `/plugin-files/<id>/*` may serve — never the backend entry, nothing outside the
  folder).
- `context.ts` — `ctx`: `nodes.register`, `accounts` (below), `logic.routeEvent`
  (fires into running nodes of a kind in a project; `account` input matched like
  Overlive routing, empty = any) and `hasConsumers`, `data.publish` (data fields, global
  scope) and `isReferenced`, `storage` (JSON file in `<plugins>/<id>/data/`, plus
  per-project prefix), `projects` (from `projectEvents`, emitted by the project routes),
  `http.router()` (mounted at `/api/plugin/<id>/` — for outside callers only), `log`,
  `config` (config.json `plugins.settings[<id>]`), `onDispose`.
- `manifest.ts` — `plugin.json` validation, `compareVersions`, `satisfies`.
- `state.ts` — `state.json` (installed version, enabled, registry, sha256, pending).
- Boot (`index.ts`): `applyPendingChanges` → `loadAll` → `publishPlugins` → manager →
  background registry refresh — all before `actionLifecycle.bootSync` /
  `logicManager.startAllEnabled`, so plugin kinds exist when graphs are built.

## Mesh documents

| rtype | Channel | Written by | Read by | Notes |
|---|---|---|---|---|
| `plugin` | runtime | server | own tabs (all); peers we share with (`name` only) | id `<serverPeerId>:<pluginId>`; status, contributions, merged locales, help, providers, code base URL (`mesh/plugins.ts`) |
| `plugin_account` | committed (`plugin_accounts`) | server creates; tabs rename / default / delete | own tabs | no tokens (server-only column) |
| `plugin_app` | committed (`plugin_apps`) | tabs | own tabs | id `<projectId>:<provider>`; declared app fields only |
| `plugin_catalog` | runtime | server | own tabs | Plugins window rows (`mesh/pluginCatalog.ts`) |
| `plugin_command` | control | tabs (requests) | server (replies) | `{ ok, error? }` |
| `server_status` `plugins:main` | runtime | server | own tabs | registries, `restartRequired`, `canRestart` |
| `server_status` `plugin_account:<id>` | runtime | server | own tabs | account status |

The name-only grant (`pathPrefix: 'name'`) is held while a collab scene or object
share with that peer exists (`holdPluginNameGrant` / `releasePluginNameGrant`, called
from `mesh/collab.ts` and `mesh/shares.ts`). A missing-kind node shows the plugin name
from any `plugin` document whose id matches the kind prefix (`pluginForKind`).

REST that remains: `GET /api/plugins` (outside callers: MCP, scripts), the OAuth popup
routes, plugin routers, `/plugin-files`. **The editor uses none of these for data.**

## Editor (`packages/frontend/src/plugins/loader.ts`)

Before the first render (`main.tsx`), wait (≤ 3 s) for the `plugin` subscription, then
for each active plugin of our server: add the locale bundles, register help topics,
import `shared.mjs` (static file) and register its contributions; keep observing and
load plugins that become active later (live install). Idempotent.

## Accounts {#accounts}

`accounts/` — providers (`defineProvider`: `oauth_pkce` only in API 1; app fields are
non-secret), `store.ts` (`list` / `get` / `defaultFor` / `withToken` with refresh and
rotation, `needs_reauth` on a refused refresh / `invalidate` / `setStatus` /
`onChanged`; one default per project + provider), `oauth.ts` (`/api/plugin-auth/start`
→ provider → `/api/plugin-auth/callback`; PKCE S256; state map in memory, 10 min;
redirect URI `http://127.0.0.1:<PORT>/api/plugin-auth/callback`,
`VSPARK_OAUTH_REDIRECT_BASE` overrides), `guards.ts`. Editor:
`PluginAccountsSection.tsx` inside the Accounts window, account picker in SchemaForm.

## Managing {#managing}

`manager.ts` (`PluginManager`) + `registry.ts` + `installer.ts`: registries from config
`plugins.registries` (default: the official URL, trusted); entries validated
(https URL, sha256), newest compatible version on the user's update channel
(`stable` → stable; `recent` → + recent; `experimental` → all). Commands:

| Command | Running plugin | Not running |
|---|---|---|
| install | — | download → SHA-256 check → unpack → `state.json` → **load live** → restart graphs using its node kinds |
| update | download now, swap at next start (`pending.update`) | as install |
| enable | — | load live |
| disable / uninstall | at next start (`pending`) | now |
| cancel_pending, refresh, set_registries | | |
| restart | packaged builds only: exit **42** after 500 ms | `not_packaged` |

**Restart reuses exit code 42** (the self-update code): the release start scripts
relaunch on it; with no update zip present `unzip` / `Expand-Archive` prints an error
and the loop continues. *(Claude's choice — a clean separate code needs a
`release.yml` change that could not be pushed from the cloud session; see
[plans/plugin-system.md](../plans/plugin-system.md#open-follow-ups).)*

## Registry {#registry}

`plugins/registry.json` (repo root), schema 1 — see `plugins/README.md`.

## Tests

Backend: `plugins.registry.test.ts` (phase 1), `plugins.loader.test.ts`,
`plugins.accounts.test.ts`, `plugins.manager.test.ts` — fixture plugins in
`test/fixtures/plugins/` (`hello`, `broken`) are **built with esbuild per test**
(`test/helpers/plugins.ts`, also `zipPlugin`). Frontend: `plugins.registry.test.tsx`,
`plugins.loader.test.ts`, `plugins.accounts.test.tsx`, `plugins.window.test.tsx`,
`signal.missingKind.test.tsx`. e2e: the stack loads `hello` from a dev folder
(`e2e/fixtures/pluginFixture.ts`, registries pointed at a refusing address);
`cov-plugins.spec.ts`.

## Known gaps (observed, not decided)

- Data fields a plugin publishes are global (scope `''`): two projects on one server
  publishing the same field share it.
- Plugin node kinds' inline `Account` dropdown on the canvas lists Overlive accounts;
  composite `account` settings do not take a plugin provider yet (empty = default works).
- Behavior graphs using a newly installed plugin's nodes are not restarted live (Logic
  and Action graphs are).
- `ui.mjs` (custom React forms) is not loaded.
- A remote peer sees plugin names only while a share exists; the existing Twitch /
  StreamElements accounts in the same window still use REST (pre-existing).

## Cross-references

- [actions.md](actions.md#plugin-contributions), [composites.md](composites.md#plugin-composites),
  [signal-graph.md](signal-graph.md) (node registry, unknown kinds),
  [mesh.md](mesh.md), [i18n-help.md](i18n-help.md), [updates.md](updates.md) (exit 42).
