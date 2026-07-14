// Public `@slip-stream-kit/config` entry: `import { defineConfig } from '@slip-stream-kit/config'`.
//
// This is the surface a consumer's `infra-kit.config.ts` imports. It exists as its own npm package —
// separate from the `infra-kit` CLI — for one structural reason: npm cannot install a package's
// `exports` without also installing its `bin`, and a local `node_modules/.bin/infra-kit` SHADOWS a
// globally-installed one. So as long as configs imported from `infra-kit`, the CLI could never
// actually be global. Splitting the config surface out is what makes `npm i -g infra-kit` real.
//
// Keep this entry minimal, and use relative imports so the emitted .d.ts stays portable.
export { defineConfig } from '../lib/package-config/package-config'
export type {
  InfraKitDev,
  InfraKitDevProxy,
  InfraKitDevProxyRoute,
  InfraKitDevProxySource,
  InfraKitPackageConfig,
  InfraKitPackageConfigInput,
} from '../lib/package-config/package-config'
// Vendor sync config authoring (`import { defineVendorConfig } from '@slip-stream-kit/config'`).
export { defineVendorConfig } from '../lib/vendor/config-schema'
export type { VendorConfig, VendorCopyItem } from '../lib/vendor/config-schema'
