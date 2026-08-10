import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig(() => {
  return {
    plugins: [],
    resolve: {
      alias: {
        '#root': resolve(import.meta.dirname, './src'),
        src: resolve(import.meta.dirname, './src'),
      },
    },
    test: {
      exclude: ['**/node_modules/**', '**/dist/**'],
      environment: 'node',
      // PINNED, not incidental. `forks` is vitest's default today, and it is what puts tests on the
      // MAIN THREAD's `process.stdin` — the only stream carrying node's bootstrap `'pause'` listener
      // (internal/bootstrap/switches/is_main_thread.js:263), which is the mechanism
      // src/tui/__tests__/stdin-pause-semantics.test.ts asserts. Under `threads` that listener count
      // is ZERO and those assertions would pass vacuously. That file guards the guard, so a switch
      // here fails loudly rather than silently hollowing the fence out.
      pool: 'forks',
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
