import { OperationError } from 'src/lib/errors/operation-error'
import { isMcpMode } from 'src/lib/mcp-mode'
import { textContent } from 'src/types'
import type { ToolsExecutionResult } from 'src/types'

import type { RemoveWorktreesResult } from './remove-worktrees'

export interface RemovalStructuredContent {
  removedWorktrees: string[]
  failedWorktrees: string[]
  count: number
}

interface ToRemovalToolResultArgs {
  result: RemoveWorktreesResult
  /** Used for the CLI-path OperationError, e.g. `remove worktrees`. */
  operation: string
}

/**
 * Turn a batch removal into the command's return value, surfacing failures on whichever surface the
 * command runs on:
 *
 * - **MCP**: a thrown error is flattened by the SDK to text-only `isError` content and loses
 *   `structuredContent` entirely, so a failure is *returned* with `isError: true` and a
 *   schema-valid `failedWorktrees` (same pattern as the confirm gate in `tool-handler.ts`).
 * - **CLI**: an `OperationError` so the process exits non-zero and names what was not removed.
 *
 * Callers run their IDE cleanup and `commandEcho.print()` BEFORE calling this, so the successful
 * part of a batch is still reported and echoed.
 */
export const toRemovalToolResult = (args: ToRemovalToolResultArgs): ToolsExecutionResult<RemovalStructuredContent> => {
  const { result, operation } = args

  const structuredContent: RemovalStructuredContent = {
    removedWorktrees: result.removed,
    failedWorktrees: result.failed.map((failure) => {
      return failure.branch
    }),
    count: result.removed.length,
  }

  const content = textContent(JSON.stringify(structuredContent, null, 2))

  if (result.failed.length === 0) return { content, structuredContent }

  if (isMcpMode()) return { content, structuredContent, isError: true }

  const failures = result.failed
    .map((failure) => {
      return `${failure.branch}: ${failure.reason}`
    })
    .join('; ')

  throw new OperationError(undefined, {
    operation,
    remediation: `not removed: ${structuredContent.failedWorktrees.join(', ')} — fix the cause above and re-run`,
    stderrExcerpt: failures,
  })
}
