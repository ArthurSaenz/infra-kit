/**
 * Names of the `@inquirer/core` error classes thrown when an interactive prompt
 * ends without a value: `ExitPromptError` (user pressed Ctrl-C / Esc) and
 * `AbortPromptError` (the prompt was aborted via an `AbortSignal`). Both are
 * intentional cancellations, not failures.
 */
const CANCELLATION_ERROR_NAMES = new Set(['ExitPromptError', 'AbortPromptError'])

const hasCancellationName = (value: unknown): boolean => {
  return value instanceof Error && CANCELLATION_ERROR_NAMES.has(value.name)
}

/**
 * True when `error` represents a user (or signal) cancellation of an
 * `@inquirer/*` prompt — i.e. pressing Ctrl-C / Esc in the branch picker or a
 * confirm step. Matched by `name` rather than `instanceof` so it stays correct
 * even when pnpm dedupes more than one copy of `@inquirer/core` into the tree
 * (an `instanceof` check fails across realms/duplicate classes).
 *
 * Also unwraps one level of `cause`, so a cancellation re-wrapped in an
 * {@link ./operation-error.OperationError} is still recognised at the top-level
 * error boundary.
 *
 * @example
 * try {
 *   await checkbox({ message: 'Select release branches', choices })
 * } catch (err) {
 *   if (isPromptCancellation(err)) process.exit(0) // clean back-out, not an error
 *   throw err
 * }
 */
export const isPromptCancellation = (error: unknown): boolean => {
  if (hasCancellationName(error)) return true

  const cause = (error as { cause?: unknown } | null | undefined)?.cause

  return hasCancellationName(cause)
}
