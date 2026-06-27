import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig(() => {
  return {
    plugins: [],
    resolve: {
      alias: {
        '#root': resolve(__dirname, './src'),
        src: resolve(__dirname, './src'),
      },
    },
    test: {
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
      server: {
        deps: {
          // ink-testing-library imports `ink` without declaring it as a dep, so
          // pnpm's strict isolation hides it. Inlining lets vite resolve `ink`
          // from this package's node_modules.
          inline: ['ink-testing-library'],
        },
      },
    },
  }
})
