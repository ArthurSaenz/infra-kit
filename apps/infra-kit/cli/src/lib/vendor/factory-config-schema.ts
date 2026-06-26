import { z } from 'zod'

/**
 * Pure (node-free) factory config schema. Kept separate from `factory-config.ts`
 * (which imports node builtins for the runtime loader) so the public lib entry can
 * re-export the `FactoryConfig` type without dragging node types into the emitted
 * `.d.ts` — same split as `config-schema.ts` / `config.ts`.
 */

/**
 * Basename of the machine-local factory config, which lives at
 * `~/.infra-kit/vendor.json`. It is static JSON (no longer an executable `.ts`
 * module): the loader reads it with `JSON.parse`. The committed SOURCE-repo config
 * keeps the `vendor.config.ts` basename — always refer to this one as "the
 * user-global factory config".
 */
export const FACTORY_CONFIG_FILE = 'vendor.json'

/**
 * The machine-local factory registry. Answers "where do my project repos live"
 * (`workspaceDir`) and "which ones does the factory stamp" (`targets`). The
 * portable "what to vendor" definition (`copy[]`) lives in the committed SOURCE
 * `vendor.config.ts`, never here. `.strict()` rejects a stray `copy` key so a
 * misplaced source config produces a clear error.
 */
export const factoryConfigSchema = z
  .object({
    /** Absolute (or `~`-prefixed) dir where the target project repos are cloned. */
    workspaceDir: z.string().min(1),
    /** Target repo directory names, resolved under `workspaceDir`. */
    targets: z.array(z.string()).min(1),
  })
  .strict()

export type FactoryConfig = z.infer<typeof factoryConfigSchema>
