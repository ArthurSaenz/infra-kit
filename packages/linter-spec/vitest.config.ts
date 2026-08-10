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
    },
  }
})
