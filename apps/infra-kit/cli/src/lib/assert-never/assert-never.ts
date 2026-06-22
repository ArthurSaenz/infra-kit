/**
 * Exhaustiveness guard for discriminated unions. Place in the `default` branch of
 * a `switch` over a union: once every case is handled the argument narrows to
 * `never`, so adding a new variant later turns this into a compile error.
 *
 * @example
 * switch (provider) {
 *   case 'cursor': return openCursor()
 *   case 'zed': return openZed()
 *   default: return assertNever(provider) // compile error if a provider is unhandled
 * }
 */
export const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
