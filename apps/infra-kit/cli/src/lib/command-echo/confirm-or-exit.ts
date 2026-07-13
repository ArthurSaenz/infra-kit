import confirm from '@inquirer/confirm'
import process from 'node:process'

import { logger } from 'src/lib/logger'

import { commandEcho } from './command-echo'

/**
 * Shared interactive-confirmation gate for mutating commands.
 *
 * When `confirmedCommand` is truthy (CLI `--yes` or an MCP call, which always
 * injects `confirmedCommand: true`) the prompt is skipped and execution
 * proceeds. Otherwise it prompts the user, marks the echo as interactive, and
 * exits cleanly if the user declines.
 *
 * The `process.exit(0)` only runs on the interactive-decline path, which is
 * unreachable under MCP — so this stays safe for the long-lived MCP server.
 *
 * Callers remain responsible for their own `commandEcho.addOption('--yes', …)`
 * bookkeeping, which varies between commands.
 */
export const confirmOrExit = async (confirmedCommand: boolean | undefined, message: string): Promise<void> => {
  const answer = confirmedCommand ? true : await confirm({ message })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }
}
