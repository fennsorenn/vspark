import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
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
  alias: {
    '@vspark/shared/signal': '../shared/src/signal.ts',
    '@vspark/shared/schema': '../shared/src/schema.ts',
    '@vspark/shared/arkit':  '../shared/src/arkit_tables.ts',
    '@vspark/shared':        '../shared/src/types.ts',
  },
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
  },
});

// Copy the sqlite-wasm .wasm file next to the bundle so it can be located at runtime
const wasmSrc = join(__dirname, 'node_modules/node-sqlite3-wasm/node-sqlite3-wasm.wasm');
mkdirSync('dist', { recursive: true });
copyFileSync(wasmSrc, 'dist/node-sqlite3-wasm.wasm');

console.log('Bundle complete: dist/bundle.cjs + dist/node-sqlite3-wasm.wasm');
