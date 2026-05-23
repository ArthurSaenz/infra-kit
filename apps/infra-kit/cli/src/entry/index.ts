// Public library entry for `import { defineConfig } from 'infra-kit'`. Uses
// relative imports (no `src/*` alias) so the emitted .d.ts stays portable for
// external consumers. Keep this surface minimal — only the package-config API.
export { defineConfig } from '../lib/package-config/package-config'
export type { InfraKitPackageConfig, InfraKitPackageConfigInput } from '../lib/package-config/package-config'
