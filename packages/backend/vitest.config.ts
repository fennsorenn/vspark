import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Engine/API tests boot real subsystems (WASM SQLite, signal graphs);
    // keep them in a single process to avoid cross-worker DB/socket contention.
    pool: 'forks',
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // Generated migration bundle + the process entrypoint aren't unit-tested
      // (the entrypoint binds sockets; that's the e2e tier's territory).
      exclude: ['src/db/migrations/**', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Threshold gate is enabled at the END of Phase 6 (ratcheted to achieved),
      // once nodes + engine + managers + routes are covered.
    },
  },
});
