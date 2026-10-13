import { defineReactBrowserConfig } from '@wl/vitest-config'

export default defineReactBrowserConfig(import.meta.dirname, {
  test: {
    // The client and store tests fake the API by replacing the one global `fetch`; keep the files
    // serial so one file's restore can never land on another file's install.
    fileParallelism: false,
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/__tests__/**', 'src/**/index.ts', 'src/typings/**'],
    },
  },
})
