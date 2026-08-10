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
      { find: '@vspark/shared/style_rig', replacement: shared('style_rig.ts') },
      {
        find: '@vspark/shared/blendshapeLimits',
        replacement: shared('blendshapeLimits.ts'),
      },
      { find: '@vspark/shared/sync', replacement: shared('sync.ts') },
      { find: '@vspark/shared', replacement: shared('types.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.{ts,tsx}'],
      // Exclude R3F/WebGL render paths — these are exercised by the e2e tier
      // (Playwright/WebGL) and cannot be meaningfully instrumented under jsdom.
      // Also exclude the process entrypoint (main.tsx) and ambient type declarations.
      exclude: [
        'src/main.tsx',
        '**/*.d.ts',
        // R3F canvas and scene components
        'src/components/editor/Viewport.tsx',
        'src/components/Avatar.tsx',
        'src/components/Scene.tsx',
        'src/components/SafeEnvironment.tsx',
        'src/components/editor/CameraCanvas.tsx',
        'src/components/editor/FittedOrthoCamera.tsx',
        'src/components/editor/ComposeSceneInteractions.tsx',
        'src/pages/ViewerPage.tsx',
        // Three.js / WebGL render utilities
        'src/components/editor/DepthEdgeEffect.ts',
        'src/components/editor/GodRaysEffectFixed.ts',
        'src/components/editor/videoFx.ts',
        'src/components/editor/materialOverrides.ts',
        'src/animPreview.ts',
        'src/animRegistry.ts',
        'src/calibration.ts',
        'src/modelThumb.ts',
        'src/oneEuroFilter.ts',
        'src/particleUtils.ts',
        'src/previewSmoother.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      // Ratchet gate (Phase 7): set just below achieved numbers so coverage
      // can't silently regress. Raise these as coverage grows.
      // Achieved on 2026-06-16: statements 11.69%, branches 10.16%,
      // functions 12.56%, lines 11.73%.
      thresholds: {
        statements: 10,
        branches: 9,
        functions: 11,
        lines: 10,
      },
    },
  },
});
