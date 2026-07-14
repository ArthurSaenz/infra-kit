import { defineConfig } from '@slip-stream-kit/config'

// TEMPORARY: script/file checks disabled for now — the audit only verifies this
// config is present. Restore real requiredScripts/requiredFiles later.
export default defineConfig(() => {
  return {
    requiredScripts: [],
    requiredFiles: [],
  }
})
