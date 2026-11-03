import { defineConfig } from '@slip-stream-kit/config'

// A YAML-only package: no TypeScript toolchain, so the defaults name scripts and files it cannot have.
export default defineConfig(() => {
  return {
    requiredScripts: ['infra-kit-check'],
    requiredFiles: ['serverless.common.yml'],
  }
})
