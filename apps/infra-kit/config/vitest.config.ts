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
      exclude: ['**/node_modules/**', '**/dist/**'],
      environment: 'node',
    },
  }
})
