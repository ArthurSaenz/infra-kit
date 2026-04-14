import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react() as any],
  resolve: {
    alias: {
      '#root': path.resolve(__dirname, './src'),
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
    setupFiles: ['./vitest.setup.ts'],
  },
})
