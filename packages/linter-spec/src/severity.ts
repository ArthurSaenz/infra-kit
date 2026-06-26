/**
 * Default severity a detector reports at. Maps cleanly onto ESLint's numeric
 * levels (`off`→0, `warn`→1, `error`→2); `info` is a non-ESLint advisory level
 * for tools that support it.
 *
 * Declared as a `const` object + derived union (not a TS `enum`) so it stays
 * erasable-syntax-safe while still being iterable at runtime (used by the
 * catalog projections and the sanity test).
 */
export const Severity = {
  off: 'off',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const

// eslint-disable-next-line ts/no-redeclare -- intentional const-object + derived-union idiom
export type Severity = (typeof Severity)[keyof typeof Severity]

/** Every severity value, for iteration/validation. */
export const SEVERITIES: readonly Severity[] = Object.values(Severity)
