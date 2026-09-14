import { logger } from 'src/lib/logger'

import { CLAUDE_BIN, CLAUDE_VERSION_ARGV, PLUGIN_UPDATE_ARGV, defaultClaudeRunner } from './claude-cli'
import type { ClaudeRunner } from './claude-cli'
import { isMarketplaceRegistered, resolvePluginInstall } from './install-state'
import { MARKETPLACE_REPO, PLUGIN_KEY } from './names'

/**
 * @fileoverview
 *
 * The step that makes `infra-kit setup` enough on its own: it DRIVES `claude plugin …` so a teammate
 * does not have to copy two commands out of the terminal and run them by hand.
 *
 * The design constraint is that this shells out to somebody else's CLI. So every step is guarded by a
 * host-state READ first (`install-state.ts`), never by a second invocation: an already-installed
 * plugin skips the marketplace and install steps and runs only the idempotent `plugin update`, an
 * already-registered marketplace skips its `add`, and a machine with no `claude` on PATH is a
 * reported outcome rather than a spawn error. That is what keeps re-running `initCore` on a
 * configured machine cheap (one ≈1 s command), and what keeps this from turning a setup command red.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE.
 *
 * `--scope project`, always. The `claude` default is `user`, which would activate the plugin's skills
 * in every repository the person opens; every skill description costs context on every turn, and
 * these are written against one family's conventions. Project scope also writes `enabledPlugins` into
 * the same `.claude/settings.json` the pointer step manages, so the two agree by construction.
 *
 * Nothing here WRITES to `~/.claude/`. `installed_plugins.json` is Claude Code's bookkeeping; forging
 * a record there would make `doctor` green while the plugin was absent. When the command reports
 * success and the record still does not appear, that is `unverified` — a soft failure, reported as
 * one — precisely because the only honest source for "is it installed" is the file Claude Code owns.
 */

/** `claude plugin marketplace add ArthurSaenz/infra-kit`, as argv. */
export const MARKETPLACE_ADD_ARGV: readonly string[] = ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]

/** `claude plugin install infra-kit@infra-kit --scope project`, as argv. Never the `user` scope. */
export const PLUGIN_INSTALL_ARGV: readonly string[] = ['plugin', 'install', PLUGIN_KEY, '--scope', 'project']

/**
 * What `installPluginForProject` did. Every branch is a REPORTED outcome; none of them throws.
 *
 * `updated` covers "already at the latest version" too: the update command exits 0 either way, and the
 * caller's question is "is the served copy current", which both answer yes.
 */
export type PluginInstallOutcome =
  | { status: 'claude-missing' }
  | { status: 'installed' }
  | { status: 'updated' }
  | { status: 'update-failed'; error: string }
  | { status: 'unverified' }
  | { status: 'failed'; step: 'marketplace' | 'install'; error: string }
  /** Installed, and deliberately NOT updated: `cliIsStale` said the CLI has to move first. */
  | { status: 'skipped-cli-stale' }

export interface InstallPluginOptions {
  /** The repo the plugin is installed FOR — both the `cwd` of the install and the verified root. */
  projectRoot: string
  /** Command runner. Defaults to spawning the `claude` binary from `PATH`. */
  run?: ClaudeRunner
  /** Override `$HOME` for the host-state reads (tests, and nothing else). */
  home?: string
  /**
   * Consulted only on the already-installed path, right before `claude plugin update`: `true` withholds
   * the update and reports `skipped-cli-stale`. Injected rather than computed here because the answer
   * lives in the update cache, and `lib/update-check` already imports this directory
   * (`update-plugin.ts` → `install-state`), so reading it from here would close an import cycle. The
   * caller (`commands/init`) reads the cache; this file stays a `claude` driver.
   */
  cliIsStale?: () => boolean
}

/** The single question that decides "already installed" and "verified installed" alike. */
const isInstalledFor = (projectRoot: string, home?: string): boolean => {
  return resolvePluginInstall({ projectPath: projectRoot, home }).kind === 'installed'
}

/** First non-empty line of a command's output — a warning quotes one line, never a transcript. */
const firstLine = (text: string | undefined): string => {
  const line = (text ?? '').split('\n').find((candidate) => {
    return candidate.trim().length > 0
  })

  return (line ?? '').trim()
}

/**
 * Register the marketplace when it is not already known to this machine.
 *
 * Returns the failure to report, or `null` when the marketplace is usable — including the common case
 * where it was already registered and nothing ran.
 */
const ensureMarketplace = (run: ClaudeRunner, home?: string): { step: 'marketplace'; error: string } | null => {
  if (isMarketplaceRegistered(home)) return null

  logger.debug({ msg: `Running: ${CLAUDE_BIN} ${MARKETPLACE_ADD_ARGV.join(' ')}` })

  const result = run({ args: MARKETPLACE_ADD_ARGV })

  return result.ok ? null : { step: 'marketplace', error: firstLine(result.output) }
}

/**
 * Advance an installed plugin to what the marketplace serves. `cwd` is the project root because the
 * cwd — not a flag — is what decides which project-scope record the command updates.
 */
const updateInstalledPlugin = (run: ClaudeRunner, projectRoot: string): PluginInstallOutcome => {
  logger.debug({ msg: `Running: ${CLAUDE_BIN} ${PLUGIN_UPDATE_ARGV.join(' ')}` })

  const updated = run({ args: PLUGIN_UPDATE_ARGV, cwd: projectRoot })

  return updated.ok ? { status: 'updated' } : { status: 'update-failed', error: firstLine(updated.output) }
}

/**
 * Install the `infra-kit` Claude Code plugin for `projectRoot`, at PROJECT scope, idempotently — and
 * once it is installed, keep it current.
 *
 * Reads host state before each step, so a configured machine runs only the update; a `claude` binary
 * that is absent, a marketplace that will not register, an install that fails, an install that reports
 * success without leaving a record, and an update that fails are DISTINCT outcomes, because the fix
 * differs for each and the caller prints them differently.
 *
 * The update is what makes `setup` the manual delivery path for plugin bumps: the marketplace advances
 * on `main` and nothing on the machine notices until something runs `claude plugin update`.
 *
 * @example
 * installPluginForProject({ projectRoot: '/repo' })
 * // first run:  { status: 'installed' }
 * // second run: { status: 'updated' }  — only `claude plugin update` ran
 */
export const installPluginForProject = (options: InstallPluginOptions): PluginInstallOutcome => {
  const { projectRoot, home } = options
  const run = options.run ?? defaultClaudeRunner

  if (!run({ args: CLAUDE_VERSION_ARGV }).ok) return { status: 'claude-missing' }

  // The update, not the install, is what can run the plugin ahead of the CLI: a plugin whose skills
  // cite tool names a stale CLI's server does not serve. Withheld here, the plugin follows on the
  // first update check after the CLI has moved.
  if (isInstalledFor(projectRoot, home)) {
    if (options.cliIsStale?.() === true) return { status: 'skipped-cli-stale' }

    return updateInstalledPlugin(run, projectRoot)
  }

  const marketplaceFailure = ensureMarketplace(run, home)

  if (marketplaceFailure !== null) return { status: 'failed', ...marketplaceFailure }

  logger.debug({ msg: `Running: ${CLAUDE_BIN} ${PLUGIN_INSTALL_ARGV.join(' ')}` })

  const installed = run({ args: PLUGIN_INSTALL_ARGV, cwd: projectRoot })

  if (!installed.ok) return { status: 'failed', step: 'install', error: firstLine(installed.output) }

  // The command exited 0, which is NOT proof. Claude Code records the install in
  // `~/.claude/plugins/installed_plugins.json`; when that record is absent the plugin is not active
  // for this project, and reporting success would hand the user a green line and a broken session.
  return isInstalledFor(projectRoot, home) ? { status: 'installed' } : { status: 'unverified' }
}
