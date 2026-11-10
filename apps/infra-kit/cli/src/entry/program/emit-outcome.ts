import process from 'node:process'

import { emit } from 'src/lib/json-output'

/**
 * Emit a batch command's result and carry "part of it failed" the ONE way every batch command does:
 * `status: 'partial_failure'` beside the command's own payload, and exit 1 — the wire shape
 * `worktrees remove|sync` already produce through `toRemovalToolResult`. A machine reader then needs
 * one key and one exit code for every batch, instead of knowing each command's failure counter.
 *
 * @example
 * emitOutcome(result, result.structuredContent.failureCount > 0)
 */
export const emitOutcome = <T extends { structuredContent: object }>(result: T, partiallyFailed: boolean): void => {
  if (!partiallyFailed) {
    emit(result)

    return
  }

  emit({ structuredContent: { status: 'partial_failure', ...result.structuredContent } })
  process.exitCode = 1
}
