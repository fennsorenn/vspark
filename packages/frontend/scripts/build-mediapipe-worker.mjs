// Bundles src/media/mediapipeWorker.ts into public/mediapipeWorker.js as a classic IIFE.
//
// MediaPipe's tasks-vision WASM loader uses importScripts under the hood, which is only
// available in classic (non-module) workers. Vite's dev server serves bundled workers as
// ES modules (ignores the `worker.format: 'iife'` config in dev), so we pre-bundle the
// worker here and check the output into the repo. The output is served as a static asset
// from public/ and loaded via `new Worker('/mediapipeWorker.js')` (classic).
//
// Re-run after editing src/media/mediapipeWorker.ts:
//   pnpm --filter @vspark/frontend build:worker

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

await build({
  entryPoints: [resolve(root, 'src/media/mediapipeWorker.ts')],
  outfile:     resolve(root, 'public/mediapipeWorker.js'),
  bundle:      true,
  format:      'iife',
  platform:    'browser',
  target:      'es2020',
  minify:      true,
  sourcemap:   false,
  // tasks-vision is bundled in fully so the worker has no external imports.
  legalComments: 'none',
})

console.log('[build-mediapipe-worker] wrote public/mediapipeWorker.js')
