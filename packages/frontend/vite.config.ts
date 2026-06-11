import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';

function shared(file: string) {
  return fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));
}

// Port overrides let a second frontend instance proxy to a second backend for
// two-peer multiplayer testing (see .vscode/launch.json "Multiplayer …" configs).
const devPort = Number(process.env.VITE_DEV_PORT) || 5173;
const backendPort = Number(process.env.VITE_BACKEND_PORT) || 3001;

// When frontend + backend launch together (e.g. the MP compound), Vite's proxy
// can hit the backend before it's listening → ECONNREFUSED. Swallow that and
// reply 503 instead of crashing the request; the app's fetch/WS layers retry
// once the backend is up. Only ECONNREFUSED is suppressed — other errors throw.
type ProxyOptions = NonNullable<
  NonNullable<import('vite').ServerOptions['proxy']>[string]
>;
const tolerateBackendStartup: ProxyOptions['configure'] = (proxy) => {
  proxy.on('error', (err, _req, res) => {
    if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw err;
    console.warn(`[proxy] backend :${backendPort} not up yet — retrying once ready`);
    // res is a ServerResponse for HTTP, or a Socket for WS upgrades.
    if ('writeHead' in res && !res.headersSent) {
      res.writeHead(503).end('backend starting');
    } else if ('destroy' in res) {
      res.destroy();
    }
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: devPort,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        configure: tolerateBackendStartup,
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
        configure: tolerateBackendStartup,
      },
      '/uploads': {
        target: `http://localhost:${backendPort}`,
        configure: tolerateBackendStartup,
      },
    },
  },
  build: {
    outDir: '../../packages/backend/dist/public',
    emptyOutDir: true,
  },
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
});
