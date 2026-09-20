/**
 * Exhaustiveness guard for discriminated unions. Place in the `default` branch of
 * a `switch` over a union: once every case is handled the argument narrows to
 * `never`, so adding a new variant later turns this into a compile error.
 *
 * @example
 * switch (source) {
 *   case 'local': return resolveLocal()
 *   case 'cloud': return resolveCloud()
 *   default: return assertNever(source) // compile error if a source is unhandled
 * }
 */
export const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
