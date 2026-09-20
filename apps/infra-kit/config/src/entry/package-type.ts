// Public `@slip-stream-kit/config/package-type` entry:
// `import { detectPackageType } from '@slip-stream-kit/config/package-type'`.
//
// One inference table for the CLI's guidance blocks and the eslint-plugin's `package-structure`
// rule, so both agree on what a package IS. The plugin bundles this at build time and its published
// dist must keep zero runtime deps — hence `node:path` only here: never import from `internal` or
// pull in zod through this entry.
export { detectPackageType, PACKAGE_TYPES } from '../lib/package-type'
export type { DetectPackageTypeArgs, PackageType, PackageTypeManifest } from '../lib/package-type'
