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
 * guard fired — a test that only sees `true` cannot tell a working `mcp` guard from a working `CI` one.
 */
export type SkipReason = 'opt-out' | 'json' | 'own-command' | 'not-a-tty' | 'local-install'

/**
 * Commands that must never trigger the background updater.
 *
 * `mcp` hands its stdio to a child speaking JSON-RPC. `self-update` already performs the update itself:
 * without this, `ik self-update` would install interactively AND leave behind a detached worker that
 * waits for it to exit and then installs the very same `@latest` a second time.
 */
const SELF_MANAGING_COMMANDS = new Set(['mcp', 'self-update'])

/**
 * Positional `argv[2]` mirrors the existing `warnIfLocalInstall` guard and is correct today because the
 * program registers no global options before the subcommand. It is defence-in-depth regardless: the
 * notice goes to stderr, and the `isTty` guard already rejects the MCP server (its stdout is a pipe).
 *
 * NOTE: adding a global `program.option()` would let a flag occupy argv[2] and silently defeat this arm.
 * The stderr + isTty arms are what actually guarantee framing safety.
 */
const isSelfManagingCommand = (argv: string[]): boolean => {
  return argv[2] != null && SELF_MANAGING_COMMANDS.has(argv[2])
}

/**
 * Why this invocation must not auto-update, or null when it may.
 *
 * `local-install` is the subtle one: a repo that pins infra-kit in its `devDependencies` has deliberately
 * chosen a version. Silently upgrading the user's GLOBAL install because their project-local copy is old
 * would be both useless (the project keeps using its pinned copy) and rude.
 *
 * @example
 * autoUpdateSkipReason({ argv: ['node', 'cli.js', 'mcp'], env: {}, isTty: true, selfRealPath: '/g/cli.js', cwd: '/p', realpath: (p) => p })
 * // => 'own-command'
 */
export const autoUpdateSkipReason = (input: AutoUpdateGuardInput): SkipReason | null => {
  const { argv, env, isTty, selfRealPath, cwd, realpath } = input

  const optedOut = OPT_OUT_ENV_VARS.some((name) => {
    const value = env[name]

    return value != null && value !== ''
  })

  if (optedOut) return 'opt-out'
  if (argv.includes('--json')) return 'json'
  if (isSelfManagingCommand(argv)) return 'own-command'
  // Never nag or mutate for piped/scripted runs; a human must be present to see the outcome.
  if (!isTty) return 'not-a-tty'
  if (isLocalNodeModulesInstall(selfRealPath, cwd, realpath)) return 'local-install'

  return null
}
