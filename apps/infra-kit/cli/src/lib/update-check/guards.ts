/**
 * Whether this invocation may run the background auto-update at all. Pure: every signal is injected,
 * so the whole matrix is table-tested without spawning or touching argv/env globals.
 */
import { isLocalNodeModulesInstall } from 'src/lib/install-manager'
import type { RealpathFn } from 'src/lib/install-manager'

/** Set any of these to disable the auto-update entirely. `NO_UPDATE_NOTIFIER`/`CI` are ecosystem convention. */
export const OPT_OUT_ENV_VARS = ['INFRA_KIT_NO_AUTO_UPDATE', 'NO_UPDATE_NOTIFIER', 'CI'] as const

export interface AutoUpdateGuardInput {
  /** Full `process.argv`. */
  argv: string[]
  env: NodeJS.ProcessEnv
  /** `process.stdout.isTTY`. */
  isTty: boolean
  /** Realpath of the running `dist/cli.js`. */
  selfRealPath: string
  cwd: string
  realpath: RealpathFn
}

/**
 * Reasons to skip, in the order checked. Returned (rather than a bare boolean) so tests assert WHICH
 * guard fired — a test that only sees `true` cannot tell a working `--json` guard from a working `CI` one.
 */
export type SkipReason = 'opt-out' | 'json' | 'not-a-tty' | 'local-install'

/**
 * Why this invocation must not auto-update, or null when it may.
 *
 * `local-install` is the subtle one: a repo that pins infra-kit in its `devDependencies` has deliberately
 * chosen a version. Silently upgrading the user's GLOBAL install because their project-local copy is old
 * would be both useless (the project keeps using its pinned copy) and rude.
 *
 * @example
 * autoUpdateSkipReason({ argv: ['node', 'cli.js', 'version', '--json'], env: {}, isTty: true, selfRealPath: '/g/cli.js', cwd: '/p', realpath: (p) => p })
 * // => 'json'
 */
export const autoUpdateSkipReason = (input: AutoUpdateGuardInput): SkipReason | null => {
  const { argv, env, isTty, selfRealPath, cwd, realpath } = input

  const optedOut = OPT_OUT_ENV_VARS.some((name) => {
    const value = env[name]

    return value != null && value !== ''
  })

  if (optedOut) return 'opt-out'
  if (argv.includes('--json')) return 'json'
  // Never nag or mutate for piped/scripted runs; a human must be present to see the outcome.
  if (!isTty) return 'not-a-tty'
  if (isLocalNodeModulesInstall(selfRealPath, cwd, realpath)) return 'local-install'

  return null
}
