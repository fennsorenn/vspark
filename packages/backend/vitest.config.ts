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
    // Istanbul coverage instrumentation adds significant overhead; give
    // beforeEach hooks (especially makeTestApp mesh bootstrap) extra headroom.
    hookTimeout: 30_000,
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      // Generated migration bundle + the process entrypoint aren't unit-tested
      // (the entrypoint binds sockets; that's the e2e tier's territory).
      exclude: ['src/db/migrations/**', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Ratchet gate (Phase 9): set just below the achieved numbers so coverage
      // can't silently regress. Raise these as coverage grows.
      // Achieved on 2026-06-16: statements 56.07%, branches 42.44%,
      // functions 52.97%, lines 56.47%.
      // Branches are lower than statements/lines because multiplayer/WebSocket
      // paths (socket teardown, error branches, OAuth callbacks) need
      // live-socket or e2e coverage — those are covered by the e2e tier instead.
      thresholds: {
        statements: 50,
        branches: 38,
        functions: 48,
        lines: 50,
      },
    },
  },
});
