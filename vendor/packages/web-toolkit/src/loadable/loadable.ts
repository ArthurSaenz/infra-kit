import type { Atom } from 'jotai'
import { atom } from 'jotai'
import { unwrap } from 'jotai/utils'

export type Loadable<Value> =
  { state: 'loading' } | { state: 'hasError'; error: unknown } | { state: 'hasData'; data: Awaited<Value> }

const LOADING: Loadable<never> = { state: 'loading' }

// Same source atom -> same loadable atom, as in jotai v2 (callers use it in render and effect deps).
const cache = new WeakMap<Atom<unknown>, Atom<Loadable<unknown>>>()

/**
 * Userland port of jotai v2's `loadable`, removed in v3: reads an async atom as a synchronous
 * `{ state, data | error }` snapshot without suspending.
 */
export const loadable = <Value>(anAtom: Atom<Value>): Atom<Loadable<Value>> => {
  const cached = cache.get(anAtom)

  if (cached) return cached as Atom<Loadable<Value>>

  const $unwrapped = unwrap(anAtom, () => {
    return LOADING
  })

  const $loadable = atom<Loadable<Value>>((get) => {
    try {
      const data = get($unwrapped)

      if (data === LOADING) return LOADING

      return { state: 'hasData', data: data as Awaited<Value> }
    } catch (error) {
      return { state: 'hasError', error }
    }
  })

  cache.set(anAtom, $loadable)

  return $loadable
}
