// Public library entry for `import { defineConfig } from 'infra-kit'`. Uses
// relative imports (no `src/*` alias) so the emitted .d.ts stays portable for
// external consumers. Keep this surface minimal.
export { defineConfig } from '../lib/package-config/package-config'
export type { InfraKitPackageConfig, InfraKitPackageConfigInput } from '../lib/package-config/package-config'
// Vendor sync config authoring (`import { defineVendorConfig } from 'infra-kit'`).
// Imported from the node-free schema module so the emitted .d.ts needs no node types.
export { defineVendorConfig } from '../lib/vendor/config-schema'
export type { VendorConfig, VendorCopyItem } from '../lib/vendor/config-schema'
// The machine-local factory registry is now static JSON (~/.infra-kit/vendor.json),
// not authored in TypeScript — so there is no `defineFactoryConfig` to export.
