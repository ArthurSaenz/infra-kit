import { OperationError } from './operation-error'
import type { OperationErrorContext } from './operation-error'

/**
 * Why the command stopped, for a machine reader. `exitCode` 2 means nothing happened — re-run with
 * more; 1 means something happened and part of it failed.
 */
export type RefusalStatus = 'confirmation_required' | 'argument_required' | 'partial_failure' | 'refused'

export interface RefusalStructuredContent {
  status: RefusalStatus
  [k: string]: unknown
}

/**
 * A refusal that carries a payload for whichever agent surface is listening: `entry/cli.ts` emits
 * `structuredContent` under `--json` and exits with `exitCode`; the MCP tool handler renders it as an
 * `isError` result with the same `structuredContent`. The message is the ordinary `OperationError`
 * one (operation / stderr / remediation), so the human-readable line loses nothing.
 *
 * @example
 * throw new StructuredRefusalError(
 *   { status: 'argument_required', argument: 'version', agentMode: 'flag' },
 *   2,
 *   { operation: 'interactive prompt', remediation: 'pass --version' },
 * )
 */
// Extends `OperationError`, not `Error`, ON PURPOSE. Seven of the eight confirm sites sit under a
// handler-level `catch` that passes through only `isPromptCancellation`, `isCommandDeclined` and
// `instanceof OperationError` and REWRAPS everything else into a generic `OperationError`
// (`release-remove.ts` near the `gh auth status` remediation, `worktrees-add.ts`, `worktrees-sync.ts`,
// `release-create.ts`). A plain `Error` subclass would lose the payload and the exit code at exactly
// the sites this exists for.
export class StructuredRefusalError extends OperationError {
  readonly structuredContent: RefusalStructuredContent
  readonly exitCode: 1 | 2

  constructor(structuredContent: RefusalStructuredContent, exitCode: 1 | 2, context: OperationErrorContext) {
    super(undefined, context)
    this.name = 'StructuredRefusalError'
    this.structuredContent = structuredContent
    this.exitCode = exitCode
  }
}
