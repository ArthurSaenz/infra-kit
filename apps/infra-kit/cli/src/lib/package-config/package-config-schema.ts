import { z } from 'zod/v4'

/**
 * Schema for the resolved (post-factory) package config object. `strictObject`
 * rejects unknown keys so typos in `infra-kit.config.ts` surface as validation
 * errors instead of being silently ignored.
 *
 * Kept in its own module — separate from the public `defineConfig`/types entry —
 * so the published `infra-kit` type surface stays free of a `zod` import.
 */
export const packageConfigSchema = z.strictObject({
  requiredScripts: z.array(z.string().min(1)).optional(),
  requiredFiles: z.array(z.string().min(1)).optional(),
  turbo: z
    .strictObject({
      requiredTasks: z.array(z.string().min(1)).optional(),
    })
    .optional(),
})
