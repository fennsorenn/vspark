import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Engine/API tests boot real subsystems (WASM SQLite, signal graphs);
    // keep them in a single process to avoid cross-worker DB/socket contention.
    pool: 'forks',
  },
});
