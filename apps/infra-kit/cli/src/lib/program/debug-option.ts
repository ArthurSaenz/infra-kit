/**
 * @fileoverview
 * Registration of the global `--debug` flag on the Commander tree.
 *
 * Registration is the whole job. The flag is *read* straight off `process.argv` by `initLoggerCLI`
 * (src/lib/logger) at module load, long before Commander parses anything, so nothing here changes
 * logging behaviour. It exists because Commander rejects an unknown option first: without it
 * `infra-kit worktrees list --debug` exits 1 with `error: unknown option '--debug'`, which left the
 * CLI with no way at all to raise its own log level.
 *
 * Deliberately NOT co-located with the logger, despite reading as a logging concern. 46 test files
 * mock `src/lib/logger`, and a partial mock omits any export it does not name — so putting this
 * there made `buildProgram()` throw "No 'addDebugOption' export is defined on the mock" in every
 * test that both mocks the logger and builds the program. This is a Commander-surface concern, so
 * it lives beside the program that installs it and those mocks stay untouched.
 */
import type { Command } from 'commander'

/**
 * Register `--debug` on `cmd` and every subcommand beneath it.
 *
 * Recursive for the same reason `addJsonOption` is: an option registered only on the root is not
 * accepted after a subcommand name, and every real invocation names one. Unlike `addJsonOption` —
 * which callers apply via `program.commands.forEach` — this is meant to be called on the root
 * itself, so bare `infra-kit --debug` parses too.
 */
export const addDebugOption = (cmd: Command): void => {
  const alreadyHasDebug = cmd.options.some((option) => {
    return option.long === '--debug'
  })

  if (!alreadyHasDebug) {
    cmd.option('--debug', 'Raise the log level to debug (logs stay on stderr)')
  }

  cmd.commands.forEach(addDebugOption)
}
