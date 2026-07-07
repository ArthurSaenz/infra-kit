import { z } from 'zod'

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
  dev: z
    .strictObject({
      proxy: z
        .strictObject({
          templates: z.strictObject({
            local: z.string().min(1),
            cloud: z.string().min(1),
          }),
          routes: z.record(
            z.string().min(1),
            z
              .strictObject({
                packageName: z.string().min(1),
                from: z.array(z.enum(['local', 'cloud'])).min(1),
                default: z.enum(['local', 'cloud']).optional(),
              })
              .refine(
                (route) => {
                  return route.from.length <= 1 || route.default !== undefined
                },
                {
                  message: 'default is required when `from` has more than one source',
                },
              )
              .refine(
                (route) => {
                  return route.default === undefined || route.from.includes(route.default)
                },
                {
                  message: 'default must be listed in `from`',
                },
              ),
          ),
        })
        .optional(),
    })
    .optional(),
})
