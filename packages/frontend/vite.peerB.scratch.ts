// SCRATCH — not committed. Frontend B for two-peer multiplayer testing.
// Mirrors vite.config.ts but serves on 5174 and proxies to backend B (3002).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';

function shared(file: string) {
  return fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3002',
      '/ws': { target: 'ws://localhost:3002', ws: true },
      '/uploads': 'http://localhost:3002',
    },
  },
  resolve: {
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
});
