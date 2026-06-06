import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';

function shared(file: string) {
  return fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));
}

// Vendored Live2D Cubism Web Framework (git submodule). tsc resolves the
// `@cubism/framework/*` specifiers to ambient declarations (src/types/
// cubism-framework.d.ts); Vite resolves them to the real submodule source here
// for the actual bundle.
function cubism(sub: string) {
  return fileURLToPath(
    new URL(`./vendor/CubismWebFramework/src/${sub}`, import.meta.url)
  );
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/uploads': 'http://localhost:3001',
    },
  },
  build: {
    outDir: '../../packages/backend/dist/public',
    emptyOutDir: true,
  },
  resolve: {
    // More-specific aliases must come before less-specific ones.
    alias: [
      { find: /^@cubism\/framework\/(.*)/, replacement: cubism('$1') },
      { find: '@vspark/shared/signal_types', replacement: shared('signal_types.ts') },
      { find: '@vspark/shared/signal', replacement: shared('signal.ts') },
      { find: '@vspark/shared/node_decorators', replacement: shared('node_decorators.ts') },
      { find: '@vspark/shared/node', replacement: shared('node.ts') },
      { find: '@vspark/shared/inference', replacement: shared('inference.ts') },
      { find: '@vspark/shared/infer_nodes', replacement: shared('infer_nodes.ts') },
      { find: '@vspark/shared/schema', replacement: shared('schema.ts') },
      { find: '@vspark/shared/arkit', replacement: shared('arkit_tables.ts') },
      { find: '@vspark/shared', replacement: shared('types.ts') },
    ],
  },
});
