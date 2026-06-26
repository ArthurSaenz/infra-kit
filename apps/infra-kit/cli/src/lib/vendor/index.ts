export { sha256 } from './hash'
export {
  buildFilesMap,
  compareToManifest,
  CURRENT_SCHEMA_VERSION,
  isUnknownSchema,
  MANIFEST_FILE,
  readManifest,
  writeManifest,
} from './manifest'
export type { ManifestDiff, VendorManifest } from './manifest'
/**
 * Read-path barrel for the vendor integrity primitives. This is the SINGLE
 * source of truth for walk/hash/manifest logic, consumed by `vendor check` and
 * (via the same functions) the write-path commands.
 *
 * IMPORTANT: this barrel intentionally re-exports ONLY the read path. The config
 * loader (`./config`) and rsync/`zx` (`./sync-ops`) live with the write commands;
 * `vendor check` never imports them, so its runtime path stays free of them. The
 * skip-set constants are an internal detail (`./skip-sets`) used by `walk`.
 */
export { VENDOR_DIR } from './skip-sets'
export { walkVendorTree } from './walk'
