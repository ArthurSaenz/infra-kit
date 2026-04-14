import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig(() => ({
  plugins: [],
  resolve: {
    alias: {
      '#root': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
}))
