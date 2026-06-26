import { z } from 'zod'

/**
 * Pure (node-free) vendor config schema + authoring helper. Kept separate from
 * `config.ts` (which imports node builtins for the runtime loader) so the public
 * lib entry can re-export `defineVendorConfig` without dragging node types into
 * the emitted `.d.ts`.
 */

/**
 * Filename a source repo provides at its root to declare WHAT `vendor sync`
 * copies (`copy[]`). Lives ONLY on the write path — `vendor check` never loads it.
 * WHERE/WHICH to stamp (`workspaceDir` + `targets`) is machine-local and lives in
 * the user-global factory config (`~/.infra-kit/vendor.json`).
 */
export const VENDOR_CONFIG_FILE = 'vendor.config.ts'

/**
 * One item to sync from the source repo into each target. `vendored: true` marks
 * workspace packages that must land under `vendor/` (the single-source-of-truth
 * code); everything else is root-level tooling that stays at the repo root.
 */
export const vendorCopyItemSchema = z.object({
  name: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.enum(['file', 'directory']),
  vendored: z.boolean().optional(),
})

export const vendorConfigSchema = z
  .object({
    /** Files/dirs to copy. Items with `vendored: true` land under `vendor/`. */
    copy: z.array(vendorCopyItemSchema),
  })
  // Reject stray keys so a leftover `targets` (now machine-local, in
  // ~/.infra-kit/vendor.json) yields a clear "unrecognized key" error rather
  // than being silently ignored.
  .strict()

export type VendorCopyItem = z.infer<typeof vendorCopyItemSchema>
export type VendorConfig = z.infer<typeof vendorConfigSchema>

/**
 * Identity helper for authoring a type-safe `vendor.config.ts` in a source repo.
 * Re-exported from the public lib entry so a source repo can
 * `import { defineVendorConfig } from 'infra-kit'`.
 *
 * NOTE: a `vendor.config.ts` must be type-strippable — Node's native type
 * stripping (Node >= 24) loads it without a build step, which forbids `enum`,
 * `namespace`, and parameter properties.
 *
 * @example
 * export default defineVendorConfig({
 *   copy: [{ name: 'Configs', source: 'vendor/configs', target: 'vendor/configs', type: 'directory', vendored: true }],
 * })
 */
export const defineVendorConfig = (config: VendorConfig): VendorConfig => {
  return config
}
