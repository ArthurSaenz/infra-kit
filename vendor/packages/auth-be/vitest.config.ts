import { defineNodeConfig } from '@wl/vitest-config'

export default defineNodeConfig(import.meta.dirname, {
  test: {
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'],
      thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 },
    },
  },
})
