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
- `/:projectId` — Editor (R3F viewport + node-graph editor; wait for `canvas`).
- `/docs/:topic` — in-app docs pages.

## Playwright

Playwright is **preinstalled globally** in this environment — do **not** install
it or add it to the project. The CLI works directly. To `import`/`require` it
from a Node script, put the global modules dir on Node's path:

```bash
NODE_PATH=$(npm root -g) node /tmp/smoketest/smoke.mjs
```

## Report output

- **Report directory:** `smoketest-reports/` at repo root; each run goes in
  `smoketest-reports/<branch>-<UTC-timestamp>/` (report.md + shots/).
- Commit message for the report: `chore: add smoketest report`.

## Project-specific test hooks

- **i18n / help changes** (`packages/frontend/src/i18n/**`, `help/content/**`):
  the app ships English + German via `react-i18next`. When the diff touches these,
  switch language in the UI and assert strings render in **both EN and DE**, and
  that `?` HelpButtons open the right doc anchor.
