# @vspark/e2e — functional UI regression suite

Playwright-based end-to-end tests that boot the **real** backend + Vite frontend and drive them in
a headless browser. They assert reachability, maneuverability, and **state changes** (DOM + REST
read-back) — never appearance. There is deliberately **no screenshot/visual diffing**.

See [dev-notes/plans/automated-testing-strategy.md](../dev-notes/plans/automated-testing-strategy.md)
for the overall testing strategy (this is the Phase 3 tier).

## Running locally

```bash
# One-time: download the browser (Chromium only is enough for this suite)
pnpm --filter @vspark/e2e exec playwright install chromium

# Run the suite (boots backend + frontend automatically via webServer config)
pnpm --filter @vspark/e2e e2e

# View the last HTML report
pnpm --filter @vspark/e2e e2e:report
```

The config (`playwright.config.ts`) starts two servers:

- **backend** — `tsx src/index.ts` on a stamped throwaway SQLite DB (`vspark-e2e-<timestamp>.db`
  in the OS temp dir) with `MULTIPLAYER_RENDEZVOUS_URL=''` (multiplayer/signaling disabled).
- **frontend** — `vite` dev server on :5173, which proxies `/api` + `/ws` to the backend.

Each run gets a fresh DB, so tests start from a known-empty backend.

## Conventions

- **Select controls by `data-testid`**, not visible text — the UI is i18n'd (EN/DE), so text
  assertions would break under a locale switch. Add a `data-testid` to any control a test needs.
- **Assert state, not looks.** Prefer DOM outcomes plus a REST read-back (`request.get('/api/…')`)
  to prove a mutation actually reached the backend.
- Tests should be **independent** — seed their own data via the API rather than relying on
  another test's side effects.

## CI job (apply manually)

This job is not yet in `.github/workflows/ci.yml` because the originating session's token lacked
GitHub `workflow` scope. Add it as a separate job (it's minutes, not seconds — keep it off the
fast `build` job):

```yaml
  e2e:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.61.0-noble
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @vspark/e2e e2e
        env:
          CI: 'true'
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7
```
