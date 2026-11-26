# Plan: Plugin system

> **Status:** design-only
> Branch: `feature/plugin-system`
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.
> First consumer: [spotify-plugin.md](spotify-plugin.md).

## Goal

Let vspark be extended without shipping a new release: a plugin adds signal-graph
nodes, Action kinds and response types, composites (compound layers), account
providers, i18n strings and help pages. Plugins are discovered, installed, updated and
removed from inside the editor, from a list fed by a registry manifest that lives in a
git repository.

## Constraints

- **[decided]** (user, 2026-11-26) Plugins are installed and managed from within the
  editor; the list comes from a manifest file in a git repository.
- **[decided]** (user, 2026-11-26) The Spotify plugin is the first plugin and drives the
  scope of the extension points below.
- **[observed]** The released app is `node.exe`/`node` + a single esbuild CJS bundle
  (`packages/backend/bundle.mjs` → `dist/bundle.cjs`) + the built frontend. There is no
  package manager on a user's machine, so plugins must arrive **prebuilt**.
- **[observed]** Self-update extracts the release zip over the install dir
  (`modules/updates.md`); files it does not ship (the DB, `config.json`) survive. A
  `plugins/` dir next to `vspark.db` survives updates the same way.
- **[observed]** Node display + port metadata live in **module-level WeakMaps** in
  `@vspark/shared/signal` / `node_decorators`. A plugin that bundled its own copy of
  those modules would register into a different WeakMap and its nodes would have no
  ports. So the plugin must use the host's copy at runtime (see "SDK injection").
- **[observed]** The extension points are closed constants today: `NODE_REGISTRY`
  (`backend/src/signal/registry.ts`), `RESPONSE_TYPES` / `ACTION_KINDS`
  (`@vspark/shared/actions`), `COMPOSITE_TYPES` (`@vspark/shared/composites`),
  `BUILTIN_COMPOSITES` (`presets/builtin_presets/composites.ts`), `COMPOSITE_DEFS`
  (frontend `compositeModel.ts`), `SIGNAL_TYPE_COLORS` / `SignalTypeName`.
- **[observed]** The frontend's node palette is fed by the backend
  (`getAllNodeKindMeta()`), so backend-registered plugin nodes appear in the graph
  editor without frontend code.
- **[observed]** Compose `feed` layers render a template against data channels
  (`modules/data-channels.md`) in the editor, the output window and remote peers alike.
  Plugins that render through feed layers need **no frontend code to display**.
- **[observed]** Accounts are Overlive-specific today (`overlive_accounts`, the
  `Account` port type, `OverliveAccountsModal`).
- **[decided]** (existing, composites batch 2) No per-second updates from the backend;
  timers count down in the page.

## Proposed design (Claude's proposal, not decided — see "Open questions")

### Plugin package (what is in a release zip)

```
plugin.json            id, version, apiVersion, vspark (semver range), name/description
                       per locale, author, homepage, icon, entry points, contributes
                       summary, network hosts it talks to (shown at install)
backend.mjs            export default function (sdk) { return { activate(ctx) {…} } }
shared.mjs   (opt.)    export default function (sdk) { return { actionKinds, responseTypes,
                       compositeTypes } }  — pure; loaded by backend AND browser
ui.mjs       (opt.)    export default function (sdk) { return { actionForms, panels } }
                       React components; React/i18n come from sdk, never bundled
locales/{en,de}/*.json registered as i18n namespace `plugin-<id>`
help/{en,de}/*.md      served under the help system as topic `plugin-<id>/<page>`
presets/*.json         composite payloads (same shape as BUILTIN_COMPOSITES)
assets/                icons etc., served at /plugins/<id>/assets/
```

### SDK injection (factory modules)

Every entry module default-exports a **factory that receives the SDK object** instead of
importing it. The host passes its own `@vspark/shared/*` modules (signal decorators,
`Node`, `mkEvent`, action `Tpl` helpers, composite helpers), so plugin node classes
register in the host's WeakMaps. In the browser the SDK also carries `React`,
`useTranslation`, and a small set of host UI primitives (the `DraftText`/`DraftNumber`/
`SettingCheck` inputs, account picker, `HelpButton`).

A new `packages/plugin-sdk` workspace package is **types + build config only**
(`.d.ts` of the injected SDK, an esbuild preset that emits the three ESM files). No
runtime code ships from it, so version skew is detected by `apiVersion`, not by
duplicated modules.

### Backend `ctx` (handed to `activate`)

| API | Purpose |
|---|---|
| `ctx.nodes.register(...classes)` | Adds node kinds. Kinds must be prefixed `<pluginId>_`. |
| `ctx.accounts.defineProvider({...})` | Account provider: label, icon, auth kind (`oauth_pkce`, `oauth_code`, `token_form`), scopes, token endpoints, `fetchIdentity`, `onRefreshed`. Host runs the OAuth popup + callback and stores the row. |
| `ctx.accounts.get(id)` / `default(projectId)` / `withToken(id, fn)` | Read accounts; `withToken` refreshes when expired and persists rotated tokens. |
| `ctx.accounts.setStatus(id, status, reason?)` | Same status vocabulary as Overlive accounts. |
| `ctx.logic.routeEvent(kind, filter, payload)` | Fires an event into every running node of `kind` in a project (the Overlive `routeEvent` pattern, generalized), with `account` resolution via `pullInput`. |
| `ctx.logic.hasConsumers(kind, projectId)` | Lets a plugin poll only while something uses it. |
| `ctx.data.publish(projectId, channel, value)` | Writes a data channel (what `set_data` does) — feeds layers with no graph. |
| `ctx.http.router()` | Express router mounted at `/api/plugins/<id>/`. |
| `ctx.storage` | JSON key-value store in `plugins/<id>/data/` (global) + per-project helper. |
| `ctx.projects.onLoaded / onUnloaded` | Project lifecycle. |
| `ctx.log`, `ctx.config` | Prefixed logger; the plugin's section of `config.json`. |
| `ctx.onDispose(fn)` | Cleanup on disable/shutdown. |

### Extension points made open

- `NODE_REGISTRY` → mutable registry with `registerNodeKinds(pluginId, classes)`;
  `getAllNodeKindMeta()` adds `plugin: <id>` so the palette can badge/group plugin nodes.
- `RESPONSE_TYPES` → `registerResponseType(id, def)`. Every Action kind with a response
  (Hotkey, Chat keyword, Keyword combo, Redemption, and the new Named trigger kind below)
  then offers plugin responses for free. Their editor fields come from a **declarative
  field list** on the def (same control vocabulary as composite settings), so no plugin
  React is needed for a response.
- `ACTION_KINDS` → `registerActionKind(def)`. The form is either generated from the
  kind's `fields` metadata (new generic `SchemaForm`) or a React component from `ui.mjs`.
- `COMPOSITE_TYPES` / `COMPOSITE_DEFS` / builtin composite payloads → registered from
  `shared.mjs` + `presets/`. Palette shows a plugin tag.
- i18n: `i18next.addResourceBundle(lang, 'plugin-<id>', …)` at load.
- Help: plugin pages merged into the `/docs` index under a "Plugins" section.
- Account port: keep the `Account` type and add a `provider` hint on the port's display
  metadata, so the inline dropdown lists that provider's accounts (Overlive = default).

### New core pieces the plugin system needs

- **Named trigger Action kind** (`on_trigger` → response). Not plugin-specific; it is how
  "generic trigger" fires a plugin response. Composites already consume named triggers.
- **Generic account store**: `plugin_accounts` table (`id`, `project_id`, `plugin_id`,
  `provider`, `label`, `credentials` JSON, `identity` JSON, `status`, `status_reason`,
  `status_message`, timestamps), REST under `/api/projects/:id/plugin-accounts`, OAuth
  routes `/api/plugin-auth/:pluginId/:provider/{start,callback}` (PKCE + state map, like
  `overlive-auth.ts`), and an **Accounts** window that shows Overlive and plugin
  providers side by side (replaces / extends `OverliveAccountsModal`).
- **Missing-plugin placeholders**: a graph node / composite / Action whose plugin is not
  installed must load as an inert "missing: spotify_skip (plugin spotify)" instead of
  breaking the graph. The worker must check what `engine.ts` / `validateDescriptor` /
  the canvas do with an unknown kind today and fix it.

### Install locations and state

- `<data dir>/plugins/<id>/<version>/` — unpacked package; `<data dir>` = the dir of
  `vspark.db` (overridable with `VSPARK_PLUGINS_DIR`).
- `<data dir>/plugins/state.json` — `{ installed: { <id>: { version, enabled,
  registry, sha256 } } }`. Install state is per **installation**, not per project, so
  it lives outside the project-scoped DB.
- Dev: `config.json` `plugins.dev: ["/abs/path/to/plugin/dist"]` loads unpacked plugins
  without installing; a file watcher reloads the browser side.

### Registry manifest (in git)

```jsonc
// registry.json — fetched from a raw git URL; config.json plugins.registries is a list
{
  "schema": 1,
  "plugins": [{
    "id": "spotify",
    "name": { "en": "Spotify", "de": "Spotify" },
    "description": { "en": "…", "de": "…" },
    "author": "…", "homepage": "https://github.com/…", "icon": "https://…/icon.svg",
    "tags": ["music", "chat"],
    "versions": [{
      "version": "1.0.0", "apiVersion": 1, "vspark": ">=0.13.0",
      "channel": "stable",                       // same channels as self-update
      "url": "https://github.com/…/releases/download/spotify-v1.0.0/spotify-1.0.0.zip",
      "sha256": "…", "notes": { "en": "…", "de": "…" }
    }]
  }]
}
```

The newest version whose `apiVersion` and `vspark` range match the running build, on the
user's update channel, is offered. Downloads reuse the redirect-following `httpsGet` from
`routes/update.ts`; the zip's SHA-256 must equal the registry's before it is unpacked.

### Lifecycle

| Operation | Effect |
|---|---|
| Install | download → verify → unpack → `state.json` → **load live** (register kinds, mount router, browser re-imports via a `plugins_changed` WS message). |
| Enable | load live. |
| Disable / Update / Uninstall | marked in `state.json`; **restart required** (ESM modules cannot be unloaded, registered classes may be referenced by running graphs). The manager shows a "Restart vspark" button. |
| Boot | load every enabled plugin whose `apiVersion` / `vspark` range match; a failing `activate` disables that plugin for this run and shows an error in the manager, it never blocks boot. |

Restart: reuse the supervisor loop — the start scripts get a second sentinel exit code
(e.g. 43 = "relaunch, nothing to apply"). Both `update.ts`-side and `release.yml` start
scripts must change together (see `modules/updates.md`). In dev (`tsx watch`) the button
just says "restart the dev server".

### Editor UI

- TopBar → **Plugins** window (`vs-topbar-plugins`): tabs *Installed* / *Browse*;
  rows with icon, name, version, author, enabled toggle, Update / Uninstall, and a
  details pane (description, release notes, contributed nodes/actions/layers, network
  hosts, homepage link). Registry errors shown inline; "Add registry URL" under an
  advanced section with a third-party warning.
- Badge on the TopBar button when updates are available (checked with the self-update
  check).
- MCP: `list_plugins` (read-only) — installing stays a user action.

## Files in scope

- `packages/plugin-sdk/` (new) — SDK typings, esbuild preset, a `hello` example plugin
  used as a test fixture.
- `packages/backend/src/plugins/` (new) — `loader.ts`, `registry.ts` (manifest fetch +
  version pick), `installer.ts`, `state.ts`, `context.ts` (the `ctx` API), `accounts/`
  (provider registry, OAuth helper, account REST).
- `packages/backend/src/routes/plugins.ts` (new) — list/browse/install/enable/disable/
  update/uninstall/restart; static serving of `/plugins/<id>/<version>/*`.
- `packages/backend/src/db/migrations/0xx_plugin_accounts.sql` (new).
- `packages/backend/src/signal/registry.ts`, `logic/manager.ts`, `index.ts` — mutable
  registry, generic event routing, boot order (plugins before `logicManager.startAllEnabled()`).
- `packages/shared/src/actions.ts`, `composites.ts`, `signal.ts` — registration APIs,
  Named trigger kind, account provider hint.
- `packages/frontend/src/plugins/` (new) — loader (`import(/* @vite-ignore */ url)`),
  SDK object, i18n/help registration; mount before `Editor` renders.
- `packages/frontend/src/components/editor/plugins/` (new) — Plugins window.
- `packages/frontend/src/components/editor/AccountsWindow.tsx` (generalized accounts).
- `components/editor/actions/` — `SchemaForm`, plugin response fields.
- `.github/workflows/release.yml` — restart sentinel in start scripts.
- i18n `plugins` namespace (en/de), help page `plugins.md` (en/de), `vs-` handles + bless.

## Out of scope

- Sandboxing plugin code (plugins run with full Node/browser privileges — see questions).
- Paid/licensed plugins, signing beyond SHA-256-from-registry.
- Plugins adding new 3D scene-node kinds, new compose-layer **renderers**, new signal
  port types, or DB migrations of their own (they get `ctx.storage` + the account store).
- Plugins in project export/presets (follow-up; record a `requiredPlugins` list later).

## Approach (phases, each mergeable)

1. **Open the extension points** — mutable registries, Named trigger Action kind,
   declarative response fields, `SchemaForm`, unknown-kind placeholders. No loader yet;
   tested by registering a fake kind in-process.
2. **Loader + SDK + dev-linking** — `plugin-sdk`, factory loading on both sides, `ctx`
   minus accounts, `hello` fixture plugin (one node, one response type, one composite).
3. **Generic accounts** — `plugin_accounts`, provider registry, OAuth PKCE helper,
   Accounts window.
4. **Registry + manager UI** — manifest fetch, install/verify/unpack, enable/disable/
   update/uninstall, restart sentinel, Plugins window, help + i18n.
5. **Registry repo + CI** — repo with `registry.json` and a workflow that builds plugin
   zips on `<id>-v*` tags, uploads them as release assets, and opens a PR bumping the
   manifest (url + sha256).

## Acceptance / verification

- `pnpm lint`, `pnpm test`; backend tests load the `hello` fixture from a temp plugins
  dir and run its node through `buildGraph`; installer test verifies SHA mismatch is
  refused and a bad `apiVersion` is skipped.
- Frontend test: plugin i18n namespace + response type show up in the Hotkey form.
- e2e `cov-plugins.spec.ts`: serve a local registry + zip, install from the Plugins
  window, see the plugin node in the palette and the composite in the layer palette;
  `controls.mjs bless`.
- A graph using a plugin node survives the plugin being uninstalled (placeholder).

## Open questions (for the user)

1. **Trust model.** Plugins run unsandboxed. Proposal: official registry only by
   default, third-party registries behind an explicit "I trust this source" toggle,
   install dialog lists the hosts the plugin declares.
2. **Where first-party plugins live.** Proposal: `plugins/<id>/` inside this monorepo
   (excluded from the app bundle; shares types; CI builds zips) and `plugins/registry.json`
   in the same repo, read from `main` via raw URL. Alternative: separate
   `vspark-plugins` repo.
3. **Per-project enablement?** Proposal: install + enable per installation only; nodes
   are available in every project.
4. **Accounts per project or per installation?** Overlive's are per project; following
   that is consistent but means connecting Spotify per project (a "copy from project"
   shortcut exists for Twitch apps).
5. **Live loading** on install/enable vs. always restart (simpler, slower UX).

## Output

Open a PR into `dev` per phase, or one PR with a commit per phase.
