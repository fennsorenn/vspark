import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'url';

// Resolve `@vspark/shared/*` to the monorepo source, mirroring vite.config.ts.
// Keep this list in sync with vite.config.ts's resolve.alias — the frontend
// imports shared subpaths that aren't installed as a node_modules dependency,
// so without these aliases vitest can't resolve them (e.g. @vspark/shared/sync).
const shared = (file: string) =>
  fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // More-specific aliases must come before less-specific ones.
    alias: [
      { find: '@vspark/shared/signal_types', replacement: shared('signal_types.ts') },
      { find: '@vspark/shared/signal', replacement: shared('signal.ts') },
      { find: '@vspark/shared/node_decorators', replacement: shared('node_decorators.ts') },
      { find: '@vspark/shared/node', replacement: shared('node.ts') },
      { find: '@vspark/shared/inference', replacement: shared('inference.ts') },
      { find: '@vspark/shared/infer_nodes', replacement: shared('infer_nodes.ts') },
      { find: '@vspark/shared/schema', replacement: shared('schema.ts') },
      { find: '@vspark/shared/arkit', replacement: shared('arkit_tables.ts') },
      { find: '@vspark/shared/paramPaths', replacement: shared('paramPaths.ts') },
      { find: '@vspark/shared/sync', replacement: shared('sync.ts') },
      { find: '@vspark/shared', replacement: shared('types.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
