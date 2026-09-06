import { spawnSync } from 'node:child_process'

import { logger } from 'src/lib/logger'

import { isMarketplaceRegistered, resolvePluginInstall } from './install-state'
import { MARKETPLACE_REPO, PLUGIN_KEY } from './plugin-pointer'

/**
 * @fileoverview
 *
 * The step that makes `infra-kit init` enough on its own: it DRIVES `claude plugin …` so a teammate
 * does not have to copy two commands out of the terminal and run them by hand.
 *
 * The design constraint is that this shells out to somebody else's CLI. So every step is guarded by a
 * host-state READ first (`install-state.ts`), never by a second invocation: an already-installed
 * plugin runs nothing at all, an already-registered marketplace skips its `add`, and a machine with
 * no `claude` on PATH is a reported outcome rather than a spawn error. That is what makes re-running
 * `init` on a configured machine free, and what keeps this from turning a setup command red.
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

/** Trust the `claude` binary resolved from `PATH`; there is no configured path and none is wanted. */
const CLAUDE_BIN = 'claude'

/**
 * Ceiling for any one `claude` invocation. `plugin install` clones a marketplace repo, so it is not
 * instant — but an `init` that hangs forever on a wedged network is worse than one that reports a
 * failed install step, and the user's remaining setup steps are behind this call.
 */
const CLAUDE_TIMEOUT_MS = 120_000

/** `claude plugin marketplace add ArthurSaenz/infra-kit`, as argv. */
export const MARKETPLACE_ADD_ARGV: readonly string[] = ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]

/** `claude plugin install infra-kit@infra-kit --scope project`, as argv. Never `--scope user`. */
export const PLUGIN_INSTALL_ARGV: readonly string[] = ['plugin', 'install', PLUGIN_KEY, '--scope', 'project']

/** The PATH probe. Cheapest command that fails loudly when the binary is absent. */
export const CLAUDE_VERSION_ARGV: readonly string[] = ['--version']

/** One `claude` invocation. `cwd` matters: `--scope project` records the directory it ran in. */
export interface ClaudeCommand {
  args: readonly string[]
  cwd?: string
}

export interface ClaudeCommandResult {
  ok: boolean
  /** Diagnostic text from the command. Only read when `ok` is false. */
  output?: string
}

/** The injectable seam. Tests pass a fake so a suite never installs a plugin on the developer's machine. */
export type ClaudeRunner = (command: ClaudeCommand) => ClaudeCommandResult

/**
 * Run one `claude` command, capturing its output instead of inheriting the terminal.
 *
 * Captured, not inherited, because `init` renders its own progress: a raw `plugin install` transcript
 * dumped between two `INFO:` lines reads as a crash. The captured text is not discarded — its first
 * line is what the failure warning quotes.
 *
 * @example
 * defaultClaudeRunner({ args: ['--version'] }) // => { ok: true, output: '2.0.0 (Claude Code)' }
 */
export const defaultClaudeRunner: ClaudeRunner = (command) => {
  // PATH lookup is the point: `claude` is installed by its own installer to a location this CLI does
  // not know and must not guess, and "is it on PATH" is exactly the question step (b) asks.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync(CLAUDE_BIN, [...command.args], {
    cwd: command.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLAUDE_TIMEOUT_MS,
  })

  if (result.error !== undefined) return { ok: false, output: result.error.message }

  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()

  return { ok: result.status === 0, output }
}

/** What `installPluginForProject` did. Every branch is a REPORTED outcome; none of them throws. */
export type PluginInstallOutcome =
  | { status: 'already-installed' }
  | { status: 'claude-missing' }
  | { status: 'installed' }
  | { status: 'unverified' }
  | { status: 'failed'; step: 'marketplace' | 'install'; error: string }

export interface InstallPluginOptions {
  /** The repo the plugin is installed FOR — both the `cwd` of the install and the verified root. */
  projectRoot: string
  /** Command runner. Defaults to spawning the `claude` binary from `PATH`. */
  run?: ClaudeRunner
  /** Override `$HOME` for the host-state reads (tests, and nothing else). */
  home?: string
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
 * Install the `infra-kit` Claude Code plugin for `projectRoot`, at PROJECT scope, idempotently.
 *
 * Reads host state before each step, so a configured machine runs no commands at all; a `claude`
 * binary that is absent, a marketplace that will not register, an install that fails, and an install
 * that reports success without leaving a record are four DISTINCT outcomes, because the fix differs
 * for each and the caller prints them differently.
 *
 * @example
 * installPluginForProject({ projectRoot: '/repo' })
 * // first run:  { status: 'installed' }
 * // second run: { status: 'already-installed' }  — nothing spawned
 */
export const installPluginForProject = (options: InstallPluginOptions): PluginInstallOutcome => {
  const { projectRoot, home } = options
  const run = options.run ?? defaultClaudeRunner

  if (isInstalledFor(projectRoot, home)) return { status: 'already-installed' }

  if (!run({ args: CLAUDE_VERSION_ARGV }).ok) return { status: 'claude-missing' }

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
