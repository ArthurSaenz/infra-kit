// `@slip-stream-kit/config/internal` — the surface the `infra-kit` CLI consumes, and NOT public API.
//
// Why it exists rather than being folded into `.`: the CLI needs the validation schemas and the
// slug helpers, but a consumer authoring an `infra-kit.config.ts` does not. Exporting them from `.`
// would make every internal schema a public contract we then have to keep.
//
// The slug helpers in particular MUST be imported from here rather than copied back into the CLI.
// The dev-server records a `<release>` slug into each dev-context fragment and the vite helper
// derives the same slug when interpolating a `templates.local` URL; two implementations across two
// packages is exactly the drift this module was originally extracted to prevent, and now that the
// two sides ship as separate npm packages the drift would be silent and version-dependent.
//
// No stability guarantee: `infra-kit` and `@slip-stream-kit/config` are released in lockstep, so
// this surface may change in any release.
export { packageConfigSchema } from '../lib/package-config/package-config-schema'
export { DEFAULT_RELEASE_SLUG, slugifyHostLabel, slugifyRelease } from '../lib/release-slug/release-slug'
export {
  defineVendorConfig,
  VENDOR_CONFIG_FILE,
  vendorConfigSchema,
  vendorCopyItemSchema,
} from '../lib/vendor/config-schema'
export type { VendorConfig, VendorCopyItem } from '../lib/vendor/config-schema'
// Dev-context readers + the `dev` config loader. The CLI's dev-server and audit read the SAME
// fragment files this package's vite helper reads, through the SAME parser — the two sides now ship
// as separate npm packages, so a second reader here would be a silently version-skewed one.
export { DEV_CONTEXT_WIRE_VERSION, loadDev, readLocalContext, readLocalSet } from '../lib/vite/vite'
