/**
 * Thrown by the Ink branch pickers (via the `release-picker` shim) when the user
 * presses Esc or Ctrl-C.
 *
 * The name is honest — `PromptCancelledError`, not a borrowed `@inquirer/core`
 * class name. It is registered in `CANCELLATION_ERROR_NAMES` so
 * {@link ./is-prompt-cancellation.isPromptCancellation} recognises it through the
 * same by-name mechanism it already uses for the `@inquirer` cancel errors. That
 * keeps the contract honest if `@inquirer` is ever dropped, and survives anyone
 * adding an `instanceof` fast-path for the real inquirer classes.
 *
 * @example
 * try {
 *   await pickReleaseBranch(items)
 * } catch (err) {
 *   if (isPromptCancellation(err)) process.exit(0) // user backed out
 *   throw err
 * }
 */
export class PromptCancelledError extends Error {
  override name = 'PromptCancelledError'

  constructor() {
    super('Prompt cancelled')
  }
}
