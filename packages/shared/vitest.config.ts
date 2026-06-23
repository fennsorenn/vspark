import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Ratchet gate (Phase 5): set just below the achieved numbers so coverage
      // can't silently regress. Raise these as coverage grows. Enforced only when
      // coverage is collected (`pnpm test:coverage` / CI), not on plain `pnpm test`.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
