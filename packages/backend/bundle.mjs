import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bundle all TS/JS into a single CJS file. sqlite-wasm is pure JS — no native addons to externalize.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  tsconfig: 'tsconfig.json',
  // Must mirror the exports map in ../shared/package.json one-for-one.
  // esbuild's alias matching is prefix-based, so a missing subpath entry
  // gets greedily caught by the bare `@vspark/shared` alias below and
  // appended onto types.ts — esbuild then tries to read types.ts as a
  // directory and the build fails.
  alias: {
    '@vspark/shared/signal_types':    '../shared/src/signal_types.ts',
    '@vspark/shared/signal':          '../shared/src/signal.ts',
    '@vspark/shared/node_decorators': '../shared/src/node_decorators.ts',
    '@vspark/shared/node':            '../shared/src/node.ts',
    '@vspark/shared/inference':       '../shared/src/inference.ts',
    '@vspark/shared/infer_nodes':     '../shared/src/infer_nodes.ts',
    '@vspark/shared/schema':          '../shared/src/schema.ts',
    '@vspark/shared/arkit':           '../shared/src/arkit_tables.ts',
    '@vspark/shared/paramPaths':      '../shared/src/paramPaths.ts',
    '@vspark/shared':                 '../shared/src/types.ts',
  },
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
  },
});

// Copy the sqlite-wasm .wasm file next to the bundle.
// Location varies: package root in local installs, dist/ subdir in pnpm store.
const wasmCandidates = [
  join(__dirname, 'node_modules/node-sqlite3-wasm/node-sqlite3-wasm.wasm'),
  join(__dirname, 'node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm'),
];
const wasmSrc = wasmCandidates.find(existsSync);
if (!wasmSrc) throw new Error('Could not locate node-sqlite3-wasm.wasm in node_modules');
mkdirSync('dist', { recursive: true });
copyFileSync(wasmSrc, 'dist/node-sqlite3-wasm.wasm');

console.log('Bundle complete: dist/bundle.cjs + dist/node-sqlite3-wasm.wasm');
