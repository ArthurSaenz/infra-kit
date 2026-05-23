import { defineConfig } from 'infra-kit'

// Pure config package — no build/test pipeline. Only the shared serverless YAML
// is required, so opt out of the default script/file rules.
export default defineConfig(() => {
  return {
    requiredScripts: [],
    requiredFiles: ['serverless.common.yml'],
  }
})
