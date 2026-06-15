import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Functional UI regression suite. Boots the real backend + Vite frontend and
 * drives them in a headless browser. Asserts state changes (DOM + REST
 * read-back), never appearance — there is deliberately no screenshot diffing.
 *
 * Each `playwright test` run gets a brand-new SQLite DB (path stamped with the
 * run's start time), so tests start from a known-empty backend without any
 * cross-run leakage. The frontend dev server proxies /api + /ws to the backend
 * (see packages/frontend/vite.config.ts), so the browser only talks to :5173.
 */
const FRONTEND_PORT = 5173;
const BACKEND_PORT = 3001;
const E2E_DB = join(tmpdir(), `vspark-e2e-${Date.now()}.db`);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['html', { open: 'never' }],
        ['list'],
        ['./reporters/control-coverage.ts'],
      ]
    : [['list'], ['./reporters/control-coverage.ts']],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Force deterministic software WebGL (SwiftShader via ANGLE) so the
        // 3D editor viewport renders identically headless/CI regardless of the
        // host GPU. `--enable-unsafe-swiftshader` is required on recent Chromium
        // to allow software WebGL in headless mode.
        launchOptions: {
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      // Backend: non-watch tsx run against a throwaway DB, multiplayer disabled
      // (empty rendezvous URL) so no outbound signaling during tests.
      command: 'pnpm --filter @vspark/backend exec tsx src/index.ts',
      port: BACKEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VSPARK_DB_PATH: E2E_DB,
        MULTIPLAYER_RENDEZVOUS_URL: '',
        PORT: String(BACKEND_PORT),
      },
    },
    {
      command: 'pnpm --filter @vspark/frontend exec vite',
      port: FRONTEND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_DEV_PORT: String(FRONTEND_PORT),
        VITE_BACKEND_PORT: String(BACKEND_PORT),
        // Propagate the coverage flag so vite instruments with istanbul.
        ...(process.env.COVERAGE ? { COVERAGE: '1' } : {}),
      },
    },
  ],
});
