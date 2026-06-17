import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['apps/*/*', 'packages/*', 'vendor/packages/*', 'vendor/configs/*'],
  },
})
