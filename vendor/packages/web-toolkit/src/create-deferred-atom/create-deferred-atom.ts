import type { Atom, WritableAtom } from 'jotai'
import { atom } from 'jotai'

export interface DeferredAtom<Value, Args> {
  $data: Atom<Args | null>
  openFx: WritableAtom<null, [Args], Promise<Value>>
  resolveFx: WritableAtom<null, [Value], void>
  dismissFx: WritableAtom<null, [], void>
}

// Implements "open an async waiting state, get the value back when an external
// trigger fulfills it" without relying on `atom<Promise<T>>` +
// `set(atom, Promise.resolve(v))`. That pattern has been broken since jotai
// 2.1 (see pmndrs/jotai discussions #2682, #2461). The waiter list lives in
// module-local closure state — jotai is only used for the UI-bound `$data` atom.
//
// dismissFx() drops the current waiters silently (their `await` never
// clears `$data`. It does NOT reject, so callers don't need a try/catch.
/**
 * Creates a deferred atom that opens an async waiting state and resolves it from an external trigger.
 *
 * @example
 *     const modal = createDeferredAtom<string, { title: string }>()
 *     // Open: const result = await store.set(modal.openFx, { title: 'Confirm?' })
 *     // Resolve: store.set(modal.resolveFx, 'confirmed')
 *
 */
export const createDeferredAtom = <Value, Args>(): DeferredAtom<Value, Args> => {
  const $data = atom<Args | null>(null)

  let waiters: ((value: Value) => void)[] = []

  const openFx: WritableAtom<null, [Args], Promise<Value>> = atom(null, (_get, set, args: Args) => {
    set($data, args)

    return new Promise<Value>((resolve) => {
      waiters.push(resolve)
    })
  })

  const resolveFx: WritableAtom<null, [Value], void> = atom(null, (_get, set, value: Value) => {
    const current = waiters

    waiters = []

    set($data, null)

    current.forEach((resolve) => {
      return resolve(value)
    })
  })

  const dismissFx: WritableAtom<null, [], void> = atom(null, (_get, set) => {
    waiters = []

    set($data, null)
  })

  return { $data, openFx, resolveFx, dismissFx }
}
