import type { ProjectEnv, ProjectEnvSource } from 'src/lib/project-envs'

/** One row of the token column: an env, where we learned it exists, and whether a token resolves. */
export interface EnvTokenStatus {
  env: string
  /** `gh-workflow` — declared in a workflow's dispatch options. `token-only` — we hold a token, no workflow names it. */
  source: ProjectEnvSource
  hasToken: boolean
}

/**
 * Build the token column: one row per known environment, reporting only WHETHER a token resolves —
 * never the token itself. Mirrors `resolveEnvToken`'s precedence (`INFRA_KIT_ENV_TOKEN` shadows the
 * store for every env) without importing it, so this stays a pure, no-I/O function the same way
 * `buildEnvTokenRows` in `env-token-list` is.
 *
 * @example
 * buildEnvTokenStatus([{ env: 'dev', source: 'gh-workflow' }], { dev: 'dp.st.dev.xxxx' }, undefined)
 * // => [{ env: 'dev', source: 'gh-workflow', hasToken: true }]
 */
export const buildEnvTokenStatus = (
  envs: ProjectEnv[],
  storeTokens: Record<string, string>,
  envToken: string | undefined,
): EnvTokenStatus[] => {
  return envs.map(({ env, source }) => {
    return { env, source, hasToken: Boolean(envToken || storeTokens[env]) }
  })
}
