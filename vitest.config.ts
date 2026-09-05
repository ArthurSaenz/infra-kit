import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Match the config files, not the directories that contain them. A bare `apps/*/*` also matches
    // loose files and asset folders, which Vitest 5 refuses to resolve as projects, and it sweeps
    // the Playwright e2e packages (apps/*/tests) into the Vitest run.
    projects: [
      'apps/*/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'vendor/packages/*/vitest.config.ts',
      'vendor/configs/*/vitest.config.ts',
    ],
  },
})
