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
  // No `.default()` here: `.partial()` elsewhere in the config-loading pipeline preserves ZodDefault,
  // so a default on an optional key would make an EMPTY override layer parse to that default and
  // shallow-merge over a real setting from an earlier layer. Defaults belong at the read site.
  type: z.enum(['frontend', 'backend', 'lib', 'e2e', 'mobile']).optional(),
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
            // Accepted-but-warned this release regardless of scheme (the portless daemon this template
            // targets serves TLS only, so a non-`https://` value is almost certainly a mistake — see the
            // warning emitted from `loadDev` in `../vite/vite.ts`). Make `https://` a hard schema
            // requirement next release, once both consumer repos have had a release to pick up the warning.
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
