import { defineConfig } from 'vitest/config'

// Standalone config for the eslint-config package. These are pure Node tests that run
// ESLint programmatically against fixtures — no browser, no React. We deliberately do NOT
// re-export @wl/vitest-config (it is a deps-only bundle with no shareable config/exports);
// it is depended on solely to provide the `vitest` binary, mirroring the other packages.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.{js,ts,mjs}'],
  },
})
