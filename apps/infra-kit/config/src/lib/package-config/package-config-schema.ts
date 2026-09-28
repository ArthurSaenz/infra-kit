import { z } from 'zod'

/**
 * Schema for the resolved (post-factory) package config object. `strictObject`
 * rejects unknown keys so typos in `infra-kit.config.ts` surface as validation
 * errors instead of being silently ignored.
 *
 * Kept in its own module — separate from the public `defineConfig`/types entry —
 * so the published `infra-kit` type surface stays free of a `zod` import.
 */
const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/

/**
 * A key the schema used to accept. Refused with the replacement named, rather than as an anonymous
 * unknown key: the config is TypeScript, so there is no migration to rewrite it — the message is the fix.
 */
const retired = (replacement: string) => {
  return z.never({ error: replacement }).optional()
}

export const packageConfigSchema = z
  .strictObject({
    requiredScripts: z.array(z.string().min(1)).optional(),
    requiredFiles: z.array(z.string().min(1)).optional(),
    // No `.default()` here: `.partial()` elsewhere in the config-loading pipeline preserves ZodDefault,
    // so a default on an optional key would make an EMPTY override layer parse to that default and
    // shallow-merge over a real setting from an earlier layer. Defaults belong at the read site.
    type: z.enum(['frontend', 'backend', 'lib', 'e2e', 'mobile']).optional(),
    // The deployed origin differs per environment (prod is not `<env>`-shaped), so the config names the
    // variable and Doppler holds the value — the one source both the dev proxy and e2e read.
    deployedUrlEnv: z
      .string()
      .regex(ENV_VAR_NAME, 'deployedUrlEnv must be an env var name (e.g. `CLIENT_URL`)')
      .optional(),
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
              cloud: retired(
                "`templates.cloud` was replaced by `deployedUrlEnv`: set `deployedUrlEnv: '<APP>_URL'` at the top of this config and keep the URL per environment in Doppler",
              ),
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
    e2e: z
      .strictObject({
        target: z
          .string()
          .regex(/^[^/\s]+\/(?:ui|api)$/, 'target must be `<app>/ui` or `<app>/api` (e.g. `client/ui`)'),
        baseUrlEnv: retired(
          "`e2e.baseUrlEnv` was removed: the deployed URL is the target package's own `deployedUrlEnv`",
        ),
        cloud: retired("`e2e.cloud` was removed: the deployed URL is the target package's own `deployedUrlEnv`"),
      })
      .optional(),
  })
  .refine(
    (config) => {
      const routes = Object.values(config.dev?.proxy?.routes ?? {})

      return (
        config.deployedUrlEnv !== undefined ||
        !routes.some((route) => {
          return route.from.includes('cloud')
        })
      )
    },
    {
      message:
        "a `dev.proxy` route that can go to cloud needs `deployedUrlEnv` — the variable holding this app's deployed URL",
      path: ['deployedUrlEnv'],
    },
  )
