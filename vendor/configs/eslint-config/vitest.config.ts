import { defineNodeConfig } from '@wl/vitest-config'

// Pure Node tests that run ESLint programmatically against fixtures — no browser, no React.
// The narrower `include` keeps the runner off the fixture files themselves.
export default defineNodeConfig(import.meta.dirname, {
  test: {
    include: ['__tests__/**/*.test.{js,ts,mjs}'],
  },
})
