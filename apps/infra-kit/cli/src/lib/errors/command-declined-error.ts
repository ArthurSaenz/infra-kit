/**
 * The operator answered "no" at a confirmation prompt.
 *
 * Deliberately NOT an {@link OperationError}: nothing failed. It is also not a prompt
 * cancellation — Esc means "I never answered" and has its own handling, while this means
 * "I answered, and the answer was no." `exitForError` maps it to exit 0; every catch in between
 * passes it through.
 */
// It exists so a command that acquired a resource before prompting — a scratch worktree, a temp
// directory, a lock — can unwind through its own `finally` blocks and release it; a `process.exit(0)`
// at the prompt would skip every one of them.
//
// That distinction is load-bearing rather than stylistic. In a plan -> confirm -> apply design,
// declining is a first-class expected outcome, not an edge case, so the most ordinary non-happy
// path is exactly the one that would leak.
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
