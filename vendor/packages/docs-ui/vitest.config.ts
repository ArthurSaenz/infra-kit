import { defineConfig } from 'vitest/config'

// Node-mode (not browser/playwright): this source package currently ships no tests of its
// own. passWithNoTests keeps `test`/`qa` green; consumers test the pure slug logic.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
})
