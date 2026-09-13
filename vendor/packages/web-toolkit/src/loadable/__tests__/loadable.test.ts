import { atom, createStore } from 'jotai'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Loadable } from '../loadable'
import { loadable } from '../loadable'

const createDeferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

const flush = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('loadable', () => {
  it('returns hasData synchronously for a sync atom', () => {
    const store = createStore()
    const $value = atom(42)

    expect(store.get(loadable($value))).toEqual({ state: 'hasData', data: 42 })
  })

  it('returns loading, then hasData once the promise resolves', async () => {
    const store = createStore()
    const deferred = createDeferred<string>()
    const $value = atom(() => {
      return deferred.promise
    })
    const $snapshot = loadable($value)

    store.sub($snapshot, () => {})

    expect(store.get($snapshot)).toEqual({ state: 'loading' })

    deferred.resolve('ready')
    await flush()

    expect(store.get($snapshot)).toEqual({ state: 'hasData', data: 'ready' })
  })

  it('returns hasError with the rejection reason', async () => {
    const store = createStore()
    const deferred = createDeferred<string>()
    const error = new Error('boom')
    const $value = atom(() => {
      return deferred.promise
    })
    const $snapshot = loadable($value)

    store.sub($snapshot, () => {})

    expect(store.get($snapshot)).toEqual({ state: 'loading' })

    deferred.reject(error)
    await flush()

    expect(store.get($snapshot)).toEqual({ state: 'hasError', error })
  })

  it('returns hasError when a sync read throws', () => {
    const store = createStore()
    const error = new Error('sync boom')
    const $value = atom(() => {
      throw error
    })

    expect(store.get(loadable($value))).toEqual({ state: 'hasError', error })
  })

  it('goes back to loading on refetch and settles on the new value', async () => {
    const store = createStore()
    const $trigger = atom(0)
    const deferreds: ReturnType<typeof createDeferred<number>>[] = []
    const $value = atom((get) => {
      get($trigger)

      const deferred = createDeferred<number>()

      deferreds.push(deferred)

      return deferred.promise
    })
    const $snapshot = loadable($value)

    store.sub($snapshot, () => {})

    deferreds[0]!.resolve(1)
    await flush()

    expect(store.get($snapshot)).toEqual({ state: 'hasData', data: 1 })

    store.set($trigger, 1)

    expect(store.get($snapshot)).toEqual({ state: 'loading' })

    deferreds[1]!.resolve(2)
    await flush()

    expect(store.get($snapshot)).toEqual({ state: 'hasData', data: 2 })
  })

  it('returns the same loadable atom for the same source atom', () => {
    const $a = atom(1)
    const $b = atom(2)

    expect(loadable($a)).toBe(loadable($a))
    expect(loadable($a)).not.toBe(loadable($b))
  })

  it('types the snapshot as a jotai v2 compatible Loadable', () => {
    const $value = atom(async () => {
      return 'text'
    })
    const $snapshot = loadable($value)
    const store = createStore()
    const snapshot = store.get($snapshot)

    expectTypeOf(snapshot).toEqualTypeOf<Loadable<Promise<string>>>()
    expectTypeOf<Loadable<Promise<string>>>().toEqualTypeOf<
      { state: 'loading' } | { state: 'hasError'; error: unknown } | { state: 'hasData'; data: string }
    >()

    if (snapshot.state === 'hasData') {
      expectTypeOf(snapshot.data).toEqualTypeOf<string>()
    }
  })
})
