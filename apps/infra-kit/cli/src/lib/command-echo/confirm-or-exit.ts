/**
 * @fileoverview
 * Shared interactive-confirmation gate for mutating commands.
 *
 * When `confirmedCommand` is truthy (CLI `--yes` or an MCP call, which always
 * injects `confirmedCommand: true`) the prompt is skipped and execution
 * proceeds. Otherwise it prompts the user, marks the echo as interactive, and
 * exits cleanly if the user declines.
 *
 * Esc aborts the prompt (via `withEscape`) rather than answering it — the caller
 * sees an `AbortPromptError`, which every command's boundary already treats as a
 * clean back-out through `isPromptCancellation`. That is deliberately NOT the same
 * as declining: a decline is an answer of "no" and takes the `process.exit(0)` path
 * below, whereas Esc means "I never answered".
 *
 * Unlike every other prompt in the CLI this one renders to STDOUT, not stderr —
 * left as-is, since changing it would move confirmation text out of the stream
 * callers have always read it from.
 *
 * The `process.exit(0)` only runs on the interactive-decline path, which is
 * unreachable under MCP — so this stays safe for the long-lived MCP server.
 *
 * Callers remain responsible for their own `commandEcho.addOption('--yes', …)`
 * bookkeeping, which varies between commands.
 */
import confirm from '@inquirer/confirm'
import process from 'node:process'

import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'

import { commandEcho } from './command-echo'

export interface ConfirmOrExitOptions {
  /**
   * Throw {@link CommandDeclinedError} on a decline instead of `process.exit(0)`.
   *
   * **Defaults to false, and must stay that way.** Seven commands call this
   * helper; flipping the default would change the exit semantics of all of them
   * at once, inside a change whose tests cover none of them.
   *
   * Opt in when the command has already acquired something that needs releasing
   * by the time it prompts — `process.exit` skips every `finally`, so for those
   * commands the decline path is precisely where a resource leaks. The caller
   * owns catching it and exiting 0: a decline is a successful outcome.
   */
  throwOnDecline?: boolean
}

export const confirmOrExit = async (
  confirmedCommand: boolean | undefined,
  message: string,
  options: ConfirmOrExitOptions = {},
): Promise<void> => {
  const answer = confirmedCommand
    ? true
    : await withEscape((context) => {
        return confirm({ message }, context)
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    if (options.throwOnDecline) {
      throw new CommandDeclinedError()
    }

    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }
}
