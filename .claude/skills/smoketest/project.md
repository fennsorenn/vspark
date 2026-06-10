# Smoketest — project configuration (vspark)

All vspark-specific facts the smoketest skill needs. **This is the only file to
change when porting the skill to another project.** `SKILL.md` is generic and
refers to everything here by name.

## Repo & git

- **Repo slug:** `fennsorenn/vspark` (used for GitHub MCP PR lookup and blob URLs).
- **Base branch:** `dev` (diff and report against `origin/dev`). PRs target `dev`.
- **Committed-screenshot blob URL shape** (for inline images in a PR comment):
  `https://github.com/fennsorenn/vspark/blob/<branch>/<report-dir>/shots/<file>.png?raw=true`

## Layout & path → test-type map

Monorepo under `packages/`. Classify each changed path:

| Changed path | Test type |
|--------------|-----------|
| `packages/backend/**` | API |
| `packages/shared/**` (routes, signal nodes, managers, Zod schemas, migrations) | API |
| `packages/frontend/**` | Browser (Playwright) |
| `packages/frontend/src/i18n/**`, `packages/frontend/src/help/content/**` | Browser — see i18n hook below |
| `packages/backend/src/db/migrations/**` | API — a clean backend boot exercises them |
| `dev-notes/**`, `*.md`, CI/config only | none — report as docs/config-only, skip runtime tests |

## Install / run / readiness

Package manager: **pnpm**. Install only if `node_modules` is missing.

```bash
pnpm install                 # only if needed
pnpm dev:backend             # run_in_background — Express, http://localhost:3001
pnpm dev:frontend            # run_in_background — Vite, http://localhost:5173 (only if UI in scope)
```

Readiness probes (poll, don't sleep):

```bash
until curl -sf http://localhost:3001/api-docs.json >/dev/null; do sleep 1; done   # backend
until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done                 # frontend
```

Type-check (correctness gate; no test runner is configured): `pnpm lint`.
**`pnpm lint` only covers backend / shared / rendezvous — the frontend has no
`lint` script.** When the diff touches `packages/frontend/**`, also run the
frontend type-check explicitly: `pnpm --filter frontend typecheck`.

## API surface

- **Base path:** `/api/*` on `http://localhost:3001`.
- **Live spec:** OpenAPI JSON at `http://localhost:3001/api-docs.json`
  (Swagger UI at `/api-docs`). Read it to discover exact routes/shapes for
  whatever the diff touched.
- Example routes: `/api/projects`, `/api/scene-nodes/:id/behaviors`,
  `/api/behavior-kinds`. Most state is project-scoped — create your own project
  in stateful tests rather than assuming an id exists, and clean up after.

## Frontend routes (Playwright targets)

Served at `http://localhost:5173`:

- `/` — Home (project list).
- `/editor/:projectId` — Editor (R3F viewport + node-graph editor; wait for
  `canvas`). **Note:** the project must already have a *scene* — an
  API-created project with no scene renders a blank editor. Either create via
  the Home UI (which creates a default scene) or `POST
  /api/projects/:id/scenes` first. The default scene seeds Camera + Key/Fill
  Light nodes.
- `/docs/:topic` — in-app docs pages.

### Known-benign console error (do NOT fail on it)

In the sandboxed/offline environment, drei's `<Environment preset="city">`
cannot fetch its HDRI (`…potsdamer_platz_1k.hdr` →
`Failed to fetch` / `ERR_CERT_AUTHORITY_INVALID`). This is caught by
`SafeEnvironment`'s ErrorBoundary and the app continues normally — it is a
network artifact, not a regression. Filter it out of the console-error check
(only the scene lighting is absent; everything else renders).

## Playwright

Playwright is **preinstalled globally** in this environment — do **not** install
it or add it to the project. The CLI works directly. To `import`/`require` it
from a Node script, put the global modules dir on Node's path:

```bash
NODE_PATH=$(npm root -g) node /tmp/smoketest/smoke.mjs
```

## Two-peer mesh harness (multiplayer / Phase 5+6)

When the diff touches multiplayer (`packages/backend/src/multiplayer/**`,
`packages/rendezvous/**`, `packages/frontend/src/{sync,mesh}/**`,
`connectionsStore`, share/subscribe paths), a single instance can't exercise
the cross-server write tier. Bring up a **two-peer mesh** on one box:

**Servers** — one rendezvous + two backends + two frontends. Each peer gets its
own DB + port via env vars; both backends point at the same rendezvous:

```bash
PORT=8787 pnpm --filter @vspark/rendezvous dev                               # rendezvous
VSPARK_DB_PATH=/tmp/smoketest/a.db PORT=3001 MULTIPLAYER_RENDEZVOUS_URL=ws://localhost:8787 MULTIPLAYER_DISPLAY_NAME=ServerA pnpm dev:backend
VSPARK_DB_PATH=/tmp/smoketest/b.db PORT=3002 MULTIPLAYER_RENDEZVOUS_URL=ws://localhost:8787 MULTIPLAYER_DISPLAY_NAME=ServerB pnpm dev:backend
pnpm dev:frontend                                                            # frontend A → 3001 (default vite config)
```

Frontend B needs its own Vite proxying to backend B. The committed
`vite.config.ts` hardcodes `localhost:3001`, so write a scratch config (NOT
committed) that proxies `/api`,`/ws`,`/uploads` → `localhost:3002` and serves
on **5174**, then `cd packages/frontend && npx vite --config <scratch>.ts`.
Readiness: poll `:3002/api-docs.json` and `:5174` too. Confirm each backend is
on the mesh: `GET /api/connections/status` → `{enabled:true,status:"ready",
peerId:…}`.

**Loopback WebRTC needs no STUN/TURN.** The server mesh uses `werift`; with an
empty `iceServers` list it connects via host candidates over loopback. Don't
configure TURN.

**Pair → connect → accept (drive via REST on each backend):**

```bash
A=<peerId from :3001 /connections/identity or /status>   # writer
B=<peerId from :3002 status>                              # owner
CODE=$(curl -s -X POST :3001/api/connections/pair/create | jq -r .data.code)
curl -s -X POST :3002/api/connections/pair/join -d "{\"code\":\"$CODE\"}"     # B stores A
curl -s -X POST :3001/api/connections/peers/$B/connect                       # A → B (offer)
curl -s -X POST :3002/api/connections/peers/$A/accept                        # B accepts (no prior grant ⇒ manual)
# poll /connections/peers until both show connected:true
```

First connection always needs the **owner to accept** (auto-accept only with a
prior active grant). After accept, both `/connections/peers` rows show
`connected:true, sessionGranted:true`.

**Share (owner B) + subscribe (writer A):**
- Share with edit: owner UI = SceneGraph right-click object → *Share with* →
  toggle **Allow editing** (`shareCanEdit`, only visible once a peer is
  connected) → click the peer. Or REST: `POST
  /api/connections/objects/:objectId/share {granteePeerId, canWrite:true}`
  (`canWrite` maps to update+create+delete grant rights; returns **503
  MULTIPLAYER_DISABLED** on a single instance with no rendezvous).
- Subscribe: writer's *Connections* window (`ConnectionsWindow.tsx`) → peer's
  "Shared with you" section → **Place** button. The shared subtree projects
  under a `remote_object` node; a **writable** object's subtree is un-hidden so
  its nodes are selectable and edits route via the `remoteEdit` seam.

**Verify the write tier:** writer A edits the projected node (Properties-panel
transform / SceneGraph add-child / delete) → assert the change persists in
**owner B's DB** (`GET :3002/api/projects/:pid/scenes`, read the node row) and
echoes to every subscriber. A **read-only** share (no edit) must leave B's DB
unchanged. Throughout, capture console errors in both browser contexts and
assert no crash.

## Report output

- **Report directory:** `smoketest-reports/` at repo root; each run goes in
  `smoketest-reports/<branch>-<UTC-timestamp>/` (report.md + shots/).
- Commit message for the report: `chore: add smoketest report`.

## Project-specific test hooks

- **i18n / help changes** (`packages/frontend/src/i18n/**`, `help/content/**`):
  the app ships English + German via `react-i18next`. When the diff touches these,
  switch language in the UI and assert strings render in **both EN and DE**, and
  that `?` HelpButtons open the right doc anchor.
