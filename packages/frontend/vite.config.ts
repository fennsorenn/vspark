import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'url'

function shared(file: string) {
  return fileURLToPath(new URL(`../shared/src/${file}`, import.meta.url))
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
  },
  resolve: {
    // More-specific aliases must come before less-specific ones.
    alias: [
      { find: '@vspark/shared/signal', replacement: shared('signal.ts')       },
      { find: '@vspark/shared/schema', replacement: shared('schema.ts')       },
      { find: '@vspark/shared/arkit',  replacement: shared('arkit_tables.ts') },
      { find: '@vspark/shared',        replacement: shared('types.ts')        },
    ],
  },
})
