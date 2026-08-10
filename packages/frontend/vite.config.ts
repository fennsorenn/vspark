import react from '@vitejs/plugin-react';
import istanbul from 'vite-plugin-istanbul';
import { defineConfig, type ProxyOptions, type PluginOption } from 'vite';
import type { ServerResponse } from 'http';
import type { Socket } from 'net';
import { fileURLToPath, URL } from 'url';

function shared(file: string) {
  return fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url));
}

// Port overrides let a second frontend instance proxy to a second backend for
// two-peer multiplayer testing (see .vscode/launch.json "Multiplayer …" configs).
const devPort = Number(process.env.VITE_DEV_PORT) || 5173;
const backendPort = Number(process.env.VITE_BACKEND_PORT) || 3001;

// Keep `vite` alive when the proxy target hiccups: the backend restarting
// (ECONNREFUSED) or a client/socket dropping mid-request or mid-WS-stream
// (ECONNRESET / EPIPE / "socket has been ended") surfaces as a proxy `error`
// event. Without a handler that swallows it, the error bubbles up as an uncaught
// exception and kills the whole dev server. Log it once, best-effort close the
// client side, and carry on.
const resilientProxy: ProxyOptions['configure'] = (proxy) => {
  proxy.on('error', (err: NodeJS.ErrnoException, _req, target) => {
    console.warn(`[vite proxy] ${err.code ?? err.message} → :${backendPort}`);
    try {
      if (target && 'writeHead' in target) {
        const res = target as ServerResponse;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('proxy error');
      } else if (target && 'destroy' in target) {
        (target as Socket).destroy();
      }
    } catch {
      /* socket already gone — nothing to clean up */
    }
  });
};

export default defineConfig({
  // Istanbul instrumentation for e2e code coverage. Gated on COVERAGE so it
  // NEVER touches the production build — only the e2e coverage run sets it
  // (see e2e/playwright.config.ts). Coverage shows up on window.__coverage__.
  plugins: [
    react(),
    ...(process.env.COVERAGE
      ? [
          istanbul({
            include: 'src/*',
            extension: ['.ts', '.tsx'],
            requireEnv: false,
          }) as PluginOption,
        ]
      : []),
  ],
  server: {
    port: devPort,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        configure: resilientProxy,
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
        configure: resilientProxy,
      },
      '/mesh': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
        configure: resilientProxy,
      },
      '/uploads': {
        target: `http://localhost:${backendPort}`,
        configure: resilientProxy,
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
      { find: '@vspark/shared/face_heuristic', replacement: shared('face_heuristic.ts') },
      { find: '@vspark/shared/mfcc', replacement: shared('mfcc.ts') },
      { find: '@vspark/shared/paramPaths', replacement: shared('paramPaths.ts') },
      { find: '@vspark/shared/sync', replacement: shared('sync.ts') },
      { find: '@vspark/shared', replacement: shared('types.ts') },
    ],
  },
});
