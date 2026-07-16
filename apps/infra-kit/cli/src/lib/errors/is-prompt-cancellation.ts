/**
 * Names of the error classes thrown when an interactive prompt ends without a
 * value. From `@inquirer/core`: `ExitPromptError` (Ctrl-C — and ONLY Ctrl-C:
 * inquirer binds no escape key, so it raises this from readline's SIGINT) and
 * `AbortPromptError` (the prompt was aborted via an `AbortSignal`, which is how
 * Esc arrives — see lib/prompts/escapable-context). From our own Ink pickers:
 * `PromptCancelledError` (see ./prompt-cancelled-error), which is registered here
 * rather than impersonating an inquirer class name. All are intentional
 * cancellations, not failures.
 */
const CANCELLATION_ERROR_NAMES = new Set(['ExitPromptError', 'AbortPromptError', 'PromptCancelledError'])

const hasCancellationName = (value: unknown): boolean => {
  return value instanceof Error && CANCELLATION_ERROR_NAMES.has(value.name)
}

/**
 * True when `error` represents a user (or signal) cancellation of an interactive
 * prompt — Ctrl-C anywhere, or Esc, which reaches an `@inquirer` prompt as an
 * abort and an Ink picker as a `PromptCancelledError`. Matched by `name` rather
 * than `instanceof` so it stays correct
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
