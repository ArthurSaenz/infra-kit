import { isAgentMode } from 'src/lib/agent-mode'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
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
  /** Used for the thrown error's message, e.g. `remove worktrees`. */
  operation: string
}

/**
 * Turn a batch removal into the command's return value, surfacing failures on whichever surface the
 * command runs on:
 *
 * - **agent** (MCP, `--agent`, env): a `StructuredRefusalError` with `status: 'partial_failure'` and
 *   the schema-valid `removedWorktrees`/`failedWorktrees` payload, exit 1 — the tool handler renders
 *   it as an `isError` result with that `structuredContent`, `entry/cli.ts` emits it under `--json`.
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

  const context = {
    operation,
    remediation: `not removed: ${structuredContent.failedWorktrees.join(', ')} — fix the cause above and re-run`,
    stderrExcerpt: result.failed
      .map((failure) => {
        return `${failure.branch}: ${failure.reason}`
      })
      .join('; '),
  }

  // Exit 1, not 2: something DID happen (`removedWorktrees` is non-empty or the attempt ran), and the
  // agent has to read the payload to know which half.
  if (isAgentMode()) throw new StructuredRefusalError({ status: 'partial_failure', ...structuredContent }, 1, context)

  throw new OperationError(undefined, context)
}
