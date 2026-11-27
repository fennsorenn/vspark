# Plan: Plugin system

> **Status:** phases 1–4 shipped (2026-11-27, branch `claude/sharp-davinci-ig0xws`); phase 5 (plugin repo CI) open. As built: [../modules/plugins.md](../modules/plugins.md)
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
- **[decided]** (user, 2026-11-26) For now the registry manifest lives in this repository;
  the registry URL is configurable in the app.
- **[decided]** (user, 2026-11-26) Only the official registry is active by default;
  a third-party registry needs an explicit "I trust this source" opt-in, and the install
  dialog lists the network hosts the plugin declares. Plugins themselves run unsandboxed.
- **[decided]** (user, 2026-11-26) First-party plugin source lives in a **separate
  repository**, not in this monorepo. (The registry manifest stays here for now.)
- **[decided]** (user, 2026-11-26) Accounts extend the existing accounts window
  (`OverliveAccountsModal`) — made generic enough for plugin providers — rather than a
  new window.
- **[decided]** (user, 2026-11-26) Plugin accounts are **per project**, like Overlive
  accounts (provider app credentials too, with a "copy from another project" shortcut).
- **[decided]** (user, 2026-11-26) The first plugin repository is `vspark_spotify`
  (one repo per plugin for now).
- **[decided]** (user, 2026-11-26) The SDK types are **published to npm** as
  `@vspark/plugin-sdk`.
- **[decided]** (user, 2026-11-26) A `vspark_plugin_template` repository is the starting
  point for new plugins.
- **[decided]** (user, 2026-11-26) Plugins are installed and enabled **per
  installation**; their contributions are available in every project.
- **[decided]** (user, 2026-11-27) Plugin **code** (`shared.mjs`, `ui.mjs`) reaches the
  editor as static files from the plugin's own server (like the app bundle). Everything
  else the editor needs about a plugin — list, status, locales, help — travels as mesh
  documents (mesh principle 7); installing / enabling / removing are tab writes the
  server validates and carries out, not REST calls.
- **[decided]** (user, 2026-11-27) Installed plugins are shared with remote peers **by
  name only** (id + name), so a peer missing a plugin can show a "plugin missing" note
  for its nodes / objects instead of a bare unknown kind. Code, locales, help and status
  are not shared.
- **[decided]** (user, 2026-11-26) Requiring a restart is acceptable if live
  activation turns out too hacky. (Claude's proposal stays: load live on install /
  enable when it is clean; restart for disable / update / uninstall.)
- **[observed]** (2026-11-26) Drafts of `vspark_plugin_template` and `vspark_spotify`
  exist as zips (handed to the user to turn into repos). Their `sdk-preview/index.d.ts`
  is the **draft SDK contract** this plan's phase 2 should start from (and move into
  `packages/plugin-sdk`). A smoke test loaded both built plugins with a fake SDK:
  standard decorators compiled by esbuild inside a factory register ports through
  the injected decorators as intended.
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
                       (composite presets are declared in shared.mjs as
                       `compositePresets` — a feed-layer template + css + box,
                       optional `flow` graph — which the host turns into a
                       BUILTIN_COMPOSITES-shaped payload; no presets/*.json)
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
published to npm as `@vspark/plugin-sdk` (decided) — a release workflow here publishes
it on `plugin-sdk-v*` tags; its major version tracks `apiVersion`
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

- **Named trigger Action kind** — a *receiver*: its trigger is an `on_trigger` node
  (name ← settings), followed by the shared single-response block. Emitting named
  triggers already works (`send_trigger`, the Actions' `trigger` setting, composites);
  what is missing is an **Action** that starts on one — every current kind starts on a
  hotkey, chat message or redemption. (Observed 2026-11-26: no kind in `ACTION_KINDS`
  uses `on_trigger`.) Without it, "trigger X → Spotify skip" still works as a hand-wired
  Logic graph, just not from the Actions panel. Not plugin-specific.
- **Generic account store** (extends the existing accounts window): `plugin_accounts` table (`id`, `project_id`, `plugin_id`,
  `provider`, `label`, `credentials` JSON, `identity` JSON, `status`, `status_reason`,
  `status_message`, timestamps), REST under `/api/projects/:id/plugin-accounts`, OAuth
  routes `/api/plugin-auth/:pluginId/:provider/{start,callback}` (PKCE + state map, like
  `overlive-auth.ts`). `OverliveAccountsModal` is refactored into a provider-driven
  window: Twitch / StreamElements become built-in providers next to plugin ones, each
  contributing its add flow, row status and reconnect; the `vs-` handles stay.
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

Default: `plugins/registry.json` in this repository, read from `main` via its raw URL.
The Plugins window has a registry setting (persisted in `config.json`
`plugins.registries`, a list so a third-party registry can be added later; defaults to
the official URL, with a "reset to default" action).

```jsonc
// registry.json
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

### Why release zips (and not git)

Comparable systems, for reference: Jellyfin (a manifest JSON with zip URL + checksum per
version — closest to this design), Obsidian (a list in a git repo pointing at plugin
repos; the app downloads the built `main.js` / `manifest.json` from each repo's GitHub
Release), VS Code / Stream Deck / Grafana (a zip-format package from a catalog).
Git-clone installs (Vim/Neovim plugin managers, HACS partly) fit plugins that run from
source with no build. vspark plugins are TypeScript bundled with their dependencies, and
the released app ships no `git` binary — cloning would mean bundling git or
isomorphic-git *and* committing build output to plugin repos. So: build in CI, publish a
release asset, pin it by SHA-256 in the manifest.

Considered variant (Obsidian-style): the manifest only names a repo and the app reads
versions from its GitHub Releases. Less manifest upkeep, but it hits the unauthenticated
GitHub API rate limit (60/h) and loses the registry-pinned checksum. Not chosen; CI bumps
the manifest instead.

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
  Named trigger kind, account provider hint. Export the template helpers the SDK
  exposes as `sdk.actions` (`Tpl`, `addRankGate`, `addCooldown`, `commandNames`,
  `commandPattern`, rank / cooldown normalizers) — module-private today.
- `packages/frontend/src/plugins/` (new) — loader (`import(/* @vite-ignore */ url)`),
  SDK object, i18n/help registration; mount before `Editor` renders.
- `packages/frontend/src/components/editor/plugins/` (new) — Plugins window.
- `packages/frontend/src/components/editor/OverliveAccountsModal.tsx` — generalized into a provider-driven accounts window (rename optional).
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
5. **Plugin repo + CI** — the separate plugin repository gets a workflow that builds
   plugin zips on `v*` tags (one repo per plugin) and uploads them as release assets; bumping
   `plugins/registry.json` here (url + sha256) is a PR to this repo (manual or
   automated from the plugin repo's workflow).
6. **`vspark_plugin_template` repo** (decided) — created as a GitHub *template
   repository* ("Use this template"), not something to fork: a fork keeps the upstream
   link, cannot be made private and shares the git history (Claude's recommendation;
   forking still works if preferred). Contents: `plugin.json` with placeholders,
   `src/{backend,shared,ui}` factory entries with one example node, response type and
   composite, `locales/{en,de}`, `help/{en,de}`, `@vspark/plugin-sdk` +
   build script, a Vitest harness, a `dev` script that points `config.json`
   `plugins.dev` at `dist/`, and the release workflow from step 5 (zip + sha256 as
   release assets, printing the registry entry to paste). `vspark_spotify` is created
   from it.

## Phase 1 as shipped

Implemented on `claude/sharp-davinci-ig0xws` (commits c57bd9c … 53ebbae):

- Named trigger Action kind (`named_trigger`); template helpers exported.
- Shared: `registerResponseType` / `registerActionKind` / `registerCompositeType`
  + unregister counterparts; `FormField`; `responseTypeIds()`; plugin i18n keys
  qualified as `plugin-<id>:<key>`.
- Backend: `registerNodeKinds` (refuses undecorated classes), node meta `plugin`;
  `registerBuiltinComposite` (ids `plugin:<id>:<name>`).
- Editor: `SchemaForm` for plugin kinds, plugin response types in every picker,
  `registerCompositeDef`, plugin composite labels from the plugin namespace.
- Unknown node kinds: inert placeholders in the engine, kept on behavior-graph
  writes, shown as "Missing: <kind>" on the canvas.

Deviations from the draft SDK in the plugin zips (Claude's calls, to align with
the host's existing conventions — the drafts need these changes):

- Composite labels use the host keys in the plugin namespace: `type.<type>`,
  `group.<group>`, `setting.<key>`, `option.<key>.<option>` (the drafts used
  `composite.<type>.name`).
- Select options of generated forms read `option.<path>.<value>` (the drafts'
  `option.<last segment>.<value>` matches only for top-level paths).
- Registration functions take the plugin id first (`registerActionKind(pluginId,
  def)`); the SDK's `sdk.actions` maps to the exported helpers
  (`normalizeRank` = `rankOf`).
- Plugin Action kinds have no help button yet (plugin help pages come with the
  loader).
- `SchemaForm.tsx` is excluded from e2e control coverage until a fixture plugin
  can be installed in e2e (`e2e/coverage-ignore.json`).

## Acceptance / verification

- `pnpm lint`, `pnpm test`; backend tests load the `hello` fixture from a temp plugins
  dir and run its node through `buildGraph`; installer test verifies SHA mismatch is
  refused and a bad `apiVersion` is skipped.
- Frontend test: plugin i18n namespace + response type show up in the Hotkey form.
- e2e `cov-plugins.spec.ts`: serve a local registry + zip, install from the Plugins
  window, see the plugin node in the palette and the composite in the layer palette;
  `controls.mjs bless`.
- A graph using a plugin node survives the plugin being uninstalled (placeholder).

## Phases 2–4 as shipped

See [../modules/plugins.md](../modules/plugins.md) for the as-built description.
Deviations from the design above (Claude's calls unless marked):

- **Mesh instead of REST for the editor (decided: user, 2026-11-27).** The design's
  `GET /api/plugins/active`, REST install / enable / uninstall routes and REST account
  routes were replaced by mesh documents (`plugin`, `plugin_catalog`, `plugin_account`,
  `plugin_app`) and `plugin_command` requests. Only `GET /api/plugins` (outside
  callers), the OAuth popup routes and `/plugin-files` (code) remain HTTP.
- Plugin routers mount at `/api/plugin/<id>/` (singular), not `/api/plugins/<id>/`, to
  keep them apart from management.
- Restart reuses exit code **42** (works with today's start scripts). A clean separate
  code needs `release.yml` — see Open follow-ups.
- Install / enable are live; disable / uninstall / update of a running plugin wait for
  a restart (as designed; the user accepted restarts, 2026-11-26).
- App credentials allow only non-secret fields (PKCE), because secrets would need the
  write-only secret grant pattern (mesh principle 9), not built yet.
- The registry is the official URL on `main`; the plugin repos use `v*` tags (one repo
  per plugin), not `<id>-v*`.

## Open follow-ups

- **`.github/workflows` changes could not be pushed** (the GitHub app lacks the
  `workflow` scope): move `packages/plugin-sdk/publish-workflow.example.yml` to
  `.github/workflows/plugin-sdk.yml`; optionally make the start scripts skip the unzip
  when no update zip exists (`[ -f "$ZIP" ] && …` / `if exist`), so a plugin restart
  does not print an unzip error.
- The `vspark_plugin_template` / `vspark_spotify` drafts were updated to the shipped
  API (2026-11-27; real SDK typings in `sdk-preview/`, host label keys) and loaded into
  the real host; they still need repos, and Spotify a run against the live API.

## Open questions (for the user)

1. (none open — remaining choices are implementation details for the worker)

## Output

Open a PR into `dev` per phase, or one PR with a commit per phase.
