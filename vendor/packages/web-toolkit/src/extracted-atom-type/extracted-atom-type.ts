import type { Atom, WritableAtom } from 'jotai'

/**
 * Extracts the value type from a Jotai Atom.
 *
 * Returns `never` if the type is not an Atom.
 *
 * @template T - The Atom type to extract the value from
 * @example
 * ```typescript
 * const userAtom = atom<User | null>(null)
 *
 * // Extracts: User | null
 * type UserType = ExtractedAtomType<typeof userAtom>
 * ```
 */
export type ExtractedAtomType<T> = T extends Atom<infer U> ? U : never

/**
 * Extracts the first argument type from a WritableAtom's write function.
 * Useful for typing action payloads or update parameters.
 *
 * Returns `never` if the type is not a WritableAtom.
 *
 * @template T - The WritableAtom type to extract the action argument from
 * @example
 * ```typescript
 * type CounterAtomArgs = { type: 'increment' } | { type: 'set'; value: number }
 *
 * const counterAtom = atom(null, (get, set, args: CounterAtomArgs) => {})
 * // Extracts: CounterAtomArgs
 * type Action = ExtractAtomActionArgs<typeof counterAtom>
 * ```
 */
export type ExtractAtomActionArgs<T> = T extends WritableAtom<any, [infer Args, ...any[]], any> ? Args : never

/**
 * Extracts the updater function signature from a WritableAtom.
 * Useful for typing functional updates to atom values.
 *
 * Returns `never` if the type is not a WritableAtom.
 *
 * @template T - The WritableAtom type to extract the updater function from
 * @example
 * ```typescript
 * const $counter = atom(0)
 *
 * // Extracts: (prev: number) => number
 * type SetCounter = ExtractAtomSetter<typeof $counter>
 *
 * const increment: SetCounter = (prev) => prev + 1
 * ```
 */
export type ExtractAtomSetter<T> = T extends WritableAtom<infer Value, any, any> ? (prev: Value) => Value : never
