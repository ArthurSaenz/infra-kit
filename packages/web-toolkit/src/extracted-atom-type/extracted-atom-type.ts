import type { Atom, WritableAtom } from 'jotai'

/**
 * Extracts the value type from a Jotai Atom.
 *
 * Returns `never` if the type is not an Atom.
 *
 * @template T - The Atom type to extract the value from
 *
 * @example
 * ```typescript
 * import { atom } from 'jotai'
 * import type { ExtractedAtomType } from '@pkg/web-toolkit'
 *
 * interface User {
 *   id: string
 *   name: string
 * }
 *
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
 *
 * @example
 * ```typescript
 * import { atom } from 'jotai'
 * import type { ExtractAtomActionArgs } from '@pkg/web-toolkit'
 *
 * type CounterAtomArgs = { type: 'increment' } | { type: 'decrement' } | { type: 'set'; value: number }
 *
 * const $counterValue = atom(0)
 *
 * const counterAtom = atom(
 *   null,
 *   (get, set, args: CounterAtomArgs) => {
 *     switch (args.type) {
 *       case 'increment':
 *         set($counterValue, get($counterValue) + 1)
 *         break
 *       case 'decrement':
 *         set($counterValue, get($counterValue) - 1)
 *         break
 *       case 'set':
 *         set($counterValue, args.value)
 *         break
 *     }
 *   }
 * )
 *
 * // Extracts: CounterAtomArgs
 * type Action = ExtractAtomActionArgs<typeof counterAtom>
 *
 * // Usage examples:
 * const incrementAction: Action = { type: 'increment' }
 * const decrementAction: Action = { type: 'decrement' }
 * const setAction: Action = { type: 'set', value: 42 }
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
 *
 * @example
 * ```typescript
 * import { atom, useSetAtom } from 'jotai'
 * import type { ExtractAtomSetter } from '@pkg/web-toolkit'
 *
 * const $counter = atom(0)
 *
 * // Extracts: (prev: number) => number
 * type SetCounter = ExtractAtomSetter<typeof $counter>
 *
 * const useCounter = () => {
 *   const setCounter = useSetAtom($counter)
 *
 *   const increment: SetCounter = (prev) => prev + 1
 *   const decrement: SetCounter = (prev) => prev - 1
 *
 *   return {
 *     increment: () => setCounter(increment),
 *     decrement: () => setCounter(decrement),
 *   }
 * }
 * ```
 */
export type ExtractAtomSetter<T> = T extends WritableAtom<infer Value, any, any> ? (prev: Value) => Value : never
