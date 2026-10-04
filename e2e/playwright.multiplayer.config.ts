import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Two-server suite: a local rendezvous, two backends (A and B, separate
 * databases and identities) and one frontend per backend. Exercises what the
 * single-backend suite can't — pairing, collab scenes and everything that
 * crosses a server↔server mesh link over real WebRTC (werift).
 *
 * Kept separate from the main suite (testDir `tests-mp`): it boots five
 * processes and depends on WebRTC between the backends. Run it with
 *   pnpm --filter @vspark/e2e e2e:mp
 *
 * Ports are fixed and distinct from the main suite's, so both can run at the
 * same time: rendezvous 8799, backends 3301/3302, frontends 5301/5302.
 */
const RDV_PORT = 8799;
export const SERVERS = {
  a: { backend: 3301, frontend: 5301 },
  b: { backend: 3302, frontend: 5302 },
} as const;
const stamp = `${Date.now()}-${process.pid}`;

const backend = (name: 'a' | 'b') => ({
  command: 'pnpm --filter @vspark/backend exec tsx src/index.ts',
  port: SERVERS[name].backend,
  reuseExistingServer: false,
  timeout: 120_000,
  env: {
    VSPARK_DB_PATH: join(tmpdir(), `vspark-e2e-mp-${name}-${stamp}.db`),
    VSPARK_CONFIG_PATH: join(tmpdir(), `vspark-e2e-mp-${name}-${stamp}.json`),
    MULTIPLAYER_RENDEZVOUS_URL: `ws://localhost:${RDV_PORT}`,
    PORT: String(SERVERS[name].backend),
  },
});

const frontend = (name: 'a' | 'b') => ({
  command: 'pnpm --filter @vspark/frontend exec vite',
  port: SERVERS[name].frontend,
  reuseExistingServer: false,
  timeout: 120_000,
  env: {
    VITE_DEV_PORT: String(SERVERS[name].frontend),
    VITE_BACKEND_PORT: String(SERVERS[name].backend),
  },
});

export default defineConfig({
  testDir: './tests-mp',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
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
      command: 'pnpm --filter @vspark/rendezvous exec tsx src/index.ts',
      port: RDV_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: String(RDV_PORT) },
    },
    backend('a'),
    backend('b'),
    frontend('a'),
    frontend('b'),
  ],
});
