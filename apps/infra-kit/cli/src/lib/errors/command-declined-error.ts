/**
 * The operator answered "no" at a confirmation prompt.
 *
 * Deliberately NOT an {@link OperationError}: nothing failed. It exists so a
 * command that acquired a resource before prompting — a scratch worktree, a temp
 * directory, a lock — can unwind through its own `finally` blocks and release it,
 * instead of `confirmOrExit` calling `process.exit(0)` and skipping every one of
 * them.
 *
 * That distinction is load-bearing rather than stylistic. In a plan → confirm →
 * apply design, declining is a *first-class expected outcome*, not an edge case,
 * so the most ordinary non-happy path is exactly the one that would leak.
 *
 * It is also not a prompt cancellation: Esc means "I never answered" and already
 * has its own handling. This means "I answered, and the answer was no."
 *
 * Callers that opt in via `throwOnDecline` are responsible for catching it and
 * exiting 0 — a decline is a successful outcome of the command, not a failure.
 */
export class CommandDeclinedError extends Error {
  constructor(message = 'Operation cancelled by the operator') {
    super(message)
    this.name = 'CommandDeclinedError'
  }
}

/** Narrow an unknown catch binding to a decline. */
export const isCommandDeclined = (error: unknown): error is CommandDeclinedError => {
  return error instanceof CommandDeclinedError
}
