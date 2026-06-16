import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Force an in-memory SQLite DB for the whole suite. `DB_PATH` in
    // src/db/index.ts is read once at module load, so a test file that imports
    // the db module statically (before its beforeEach sets the env) would
    // otherwise bind to the real on-disk vspark.db and leak rows across tests.
    // Setting it here guarantees ':memory:' regardless of import order.
    env: { VSPARK_DB_PATH: ':memory:' },
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
