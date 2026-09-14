import { spawnSync } from 'node:child_process'

import { PLUGIN_KEY } from './names'

/**
 * @fileoverview
 *
 * The `claude` binary as a dependency: the argv this CLI hands it and the one seam through which it is
 * spawned. Kept apart from `install-plugin.ts` (and its logger import) because the detached update
 * worker runs `claude plugin update` too, and that worker must stay a bundle of `node:child_process`
 * plus the cache writer — nothing that constructs a logger at import time.
 */

/** Trust the `claude` binary resolved from `PATH`; there is no configured path and none is wanted. */
export const CLAUDE_BIN = 'claude'

/**
 * Ceiling for any one `claude` invocation. `plugin install` clones a marketplace repo, so it is not
 * instant — but an `initCore` that hangs forever on a wedged network is worse than one that reports a
 * failed install step, and the user's remaining setup steps are behind this call.
 */
export const CLAUDE_TIMEOUT_MS = 120_000

/** The PATH probe. Cheapest command that fails loudly when the binary is absent. */
export const CLAUDE_VERSION_ARGV: readonly string[] = ['--version']

/**
 * `claude plugin update infra-kit@infra-kit --scope project -y`, as argv.
 *
 * Every flag is load-bearing (measured on Claude Code 2.1.270). Without `--scope project` the command
 * resolves USER scope from every cwd and fails "not installed at scope user" — while still refreshing
 * the marketplace clone as a side effect, so the failure looks like progress. `-y` is required when
 * stdio is not a TTY, which is every spawn from this CLI. WHICH project record the update advances is
 * decided by the command's cwd, not by any flag: callers pass `cwd: <recorded projectPath>`.
 */
export const PLUGIN_UPDATE_ARGV: readonly string[] = ['plugin', 'update', PLUGIN_KEY, '--scope', 'project', '-y']

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
 * Captured, not inherited, because `initCore` renders its own progress: a raw `plugin install` transcript
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
