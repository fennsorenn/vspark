/**
 * Builds the feed-preview bundle: the REAL feed renderer (frontend
 * lib/feedTemplate) compiled for a headless browser. The backend
 * render_feed_template tool loads dist/feed-preview.js to rasterize a template
 * with the same renderer the live feed layer uses. Shipped in the release so
 * rendering needs no frontend source at runtime.
 *
 * Run from both build paths (tsc `build` and the single-file `bundle`) so the
 * artifact is present in either deploy shape.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['../frontend/src/preview/feedPreviewEntry.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  target: 'es2020',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'dist/feed-preview.js',
});

console.log('Built dist/feed-preview.js (real feed renderer for headless preview)');
