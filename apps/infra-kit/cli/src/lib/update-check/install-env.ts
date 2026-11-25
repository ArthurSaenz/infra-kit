/**
 * The environment of the unattended install: the worker's own, minus what `ik env-load` put there.
 *
 * The worker inherits the shell that ran the triggering command, and after an `env-load` that shell
 * carries the project's Doppler secrets. `npm install -g` runs the lifecycle scripts of every
 * dependency it resolves, and none of them has any use for those values.
 */
import path from 'node:path'

import { ENV_LOAD_FILE, INFRA_KIT_SESSION_VAR, getCacheRoot, parseVarNamesFromEnvFile } from 'src/lib/constants'
import { packageManagerInstallEnv } from 'src/lib/pm-env'

/** Stripped whatever the session file says: the loader's own markers and Doppler's CLI credentials. */
const ALWAYS_STRIPPED_PREFIXES = ['DOPPLER_', 'INFRA_KIT_ENV'] as const

/** Never stripped, even when a project keeps a secret under the same name: without them no install runs. */
const NEVER_STRIPPED: ReadonlySet<string> = new Set(['PATH', 'HOME'])

/** The names in this session's `env-load.sh`, or none when there is no session or no loaded env. */
export const sessionEnvLoadVarNames = (env: NodeJS.ProcessEnv): string[] => {
  const session = env[INFRA_KIT_SESSION_VAR]

  if (session == null || session === '') return []

  try {
    return parseVarNamesFromEnvFile(path.join(getCacheRoot(), session, ENV_LOAD_FILE))
  } catch {
    return []
  }
}

/**
 * Not an allowlist, deliberately: a proxy, a CA bundle or a private-registry token that `~/.npmrc`
 * reads from the environment must still reach the package manager, and no fixed list names them all.
 *
 * @example
 * installChildEnv({ PATH: '/bin', DOPPLER_TOKEN: 'x', API_KEY: 'y' }, ['API_KEY']) // => { PATH: '/bin' }
 */
export const installChildEnv = (
  env: NodeJS.ProcessEnv,
  loadedNames: readonly string[] = sessionEnvLoadVarNames(env),
): NodeJS.ProcessEnv => {
  const loaded = new Set(loadedNames)

  return Object.fromEntries(
    Object.entries(packageManagerInstallEnv(env)).filter(([key]) => {
      if (NEVER_STRIPPED.has(key)) return true
      if (loaded.has(key)) return false

      return !ALWAYS_STRIPPED_PREFIXES.some((prefix) => {
        return key.startsWith(prefix)
      })
    }),
  )
}
