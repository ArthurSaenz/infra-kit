import { Provider, useAtomValue, useSetAtom } from 'jotai'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { createDeferredAtom } from './create-deferred-atom'

interface OpenArgs {
  id: string
}

interface ResolveValue {
  ok: boolean
  payload?: string
}

const renderHarness = (
  deferred: ReturnType<typeof createDeferredAtom<ResolveValue, OpenArgs>>,
  onResolved?: (v: ResolveValue) => void,
  resolveValue: ResolveValue = { ok: true },
) => {
  const Harness = () => {
    const data = useAtomValue(deferred.$data)
    const callOpen = useSetAtom(deferred.openFx)
    const callResolve = useSetAtom(deferred.resolveFx)
    const callDismiss = useSetAtom(deferred.dismissFx)

    const handleOpen = async () => {
      const result = await callOpen({ id: 'x' })

      onResolved?.(result)
    }

    return (
      <>
        <button type="button" onClick={handleOpen}>
          open
        </button>
        <button
          type="button"
          onClick={() => {
            return callResolve(resolveValue)
          }}
        >
          resolve
        </button>
        <button
          type="button"
          onClick={() => {
            return callDismiss()
          }}
        >
          dismiss
        </button>
        <span data-testid="data">{data ? data.id : 'null'}</span>
      </>
    )
  }

  return render(
    <Provider>
      <Harness />
    </Provider>,
  )
}

describe('createDeferredAtom — happy path', () => {
  it('clicking "open" sets $data to the supplied args, and clicking "resolve" resolves the awaiting caller with the resolve value', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved, { ok: true, payload: 'hello' })

    await expect.element(screen.getByTestId('data')).toHaveTextContent('null')

    await screen.getByRole('button', { name: 'open' }).click()
    await expect.element(screen.getByTestId('data')).toHaveTextContent('x')

    await screen.getByRole('button', { name: 'resolve' }).click()

    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect(onResolved).toHaveBeenCalledWith({ ok: true, payload: 'hello' })
  })

  it('after a successful resolve, $data is cleared back to null', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved)

    await screen.getByRole('button', { name: 'open' }).click()
    await screen.getByRole('button', { name: 'resolve' }).click()

    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(1)
    })

    await expect.element(screen.getByTestId('data')).toHaveTextContent('null')
  })
})

describe('createDeferredAtom — dismiss semantics', () => {
  it('clicking "dismiss" clears $data but does NOT resolve the awaiting caller', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved)

    await screen.getByRole('button', { name: 'open' }).click()
    await expect.element(screen.getByTestId('data')).toHaveTextContent('x')

    await screen.getByRole('button', { name: 'dismiss' }).click()
    await expect.element(screen.getByTestId('data')).toHaveTextContent('null')

    await new Promise<void>((resolve) => {
      return setTimeout(resolve, 50)
    })

    expect(onResolved).not.toHaveBeenCalled()
  })

  it('dismiss + reopen + resolve resolves ONLY the new caller — the dismissed caller from the previous cycle never resolves', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved, { ok: true, payload: 'reopen' })

    await screen.getByRole('button', { name: 'open' }).click()
    await screen.getByRole('button', { name: 'dismiss' }).click()

    await screen.getByRole('button', { name: 'open' }).click()
    await screen.getByRole('button', { name: 'resolve' }).click()

    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect(onResolved).toHaveBeenCalledWith({ ok: true, payload: 'reopen' })

    await new Promise<void>((resolve) => {
      return setTimeout(resolve, 50)
    })

    expect(onResolved).toHaveBeenCalledTimes(1)
  })
})

describe('createDeferredAtom — multiple cycles', () => {
  it('a second open → resolve cycle resolves with its own value, independently of the first', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()

    let currentResolve: ResolveValue = { ok: true, payload: 'first' }

    const Harness = () => {
      const callOpen = useSetAtom(deferred.openFx)
      const callResolve = useSetAtom(deferred.resolveFx)

      const handleOpen = async () => {
        const result = await callOpen({ id: 'x' })

        onResolved(result)
      }

      return (
        <>
          <button type="button" onClick={handleOpen}>
            open
          </button>
          <button
            type="button"
            onClick={() => {
              return callResolve(currentResolve)
            }}
          >
            resolve
          </button>
        </>
      )
    }

    const screen = await render(
      <Provider>
        <Harness />
      </Provider>,
    )

    await screen.getByRole('button', { name: 'open' }).click()
    await screen.getByRole('button', { name: 'resolve' }).click()
    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect(onResolved).toHaveBeenNthCalledWith(1, { ok: true, payload: 'first' })

    currentResolve = { ok: false, payload: 'second' }

    await screen.getByRole('button', { name: 'open' }).click()
    await screen.getByRole('button', { name: 'resolve' }).click()
    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(2)
    })
    expect(onResolved).toHaveBeenNthCalledWith(2, { ok: false, payload: 'second' })
  })
})

describe('createDeferredAtom — concurrent waiters', () => {
  it('two callers that both opened the deferred before resolve each receive the same resolved value', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved, { ok: true, payload: 'shared' })

    const openBtn = screen.getByRole('button', { name: 'open' })

    await openBtn.click()
    await openBtn.click()

    await screen.getByRole('button', { name: 'resolve' }).click()

    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(2)
    })
    expect(onResolved).toHaveBeenNthCalledWith(1, { ok: true, payload: 'shared' })
    expect(onResolved).toHaveBeenNthCalledWith(2, { ok: true, payload: 'shared' })
  })
})

describe('createDeferredAtom — resolve before open is a no-op for future opens', () => {
  it('calling "resolve" with no awaiting caller does not queue the value: the next open waits for a fresh resolve', async () => {
    const deferred = createDeferredAtom<ResolveValue, OpenArgs>()
    const onResolved = vi.fn<(v: ResolveValue) => void>()
    const screen = await renderHarness(deferred, onResolved, { ok: true, payload: 'fresh' })

    await screen.getByRole('button', { name: 'resolve' }).click()

    await new Promise<void>((resolve) => {
      return setTimeout(resolve, 50)
    })
    expect(onResolved).not.toHaveBeenCalled()

    await screen.getByRole('button', { name: 'open' }).click()

    await new Promise<void>((resolve) => {
      return setTimeout(resolve, 50)
    })
    expect(onResolved).not.toHaveBeenCalled()

    await screen.getByRole('button', { name: 'resolve' }).click()
    await vi.waitFor(() => {
      return expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect(onResolved).toHaveBeenCalledWith({ ok: true, payload: 'fresh' })
  })
})

describe('createDeferredAtom — instance isolation', () => {
  it('two independent deferred atoms do not share waiters: resolving one does not resolve the other', async () => {
    const deferredA = createDeferredAtom<ResolveValue, OpenArgs>()
    const deferredB = createDeferredAtom<ResolveValue, OpenArgs>()

    const onResolvedA = vi.fn<(v: ResolveValue) => void>()
    const onResolvedB = vi.fn<(v: ResolveValue) => void>()

    const Harness = () => {
      const callOpenA = useSetAtom(deferredA.openFx)
      const callResolveA = useSetAtom(deferredA.resolveFx)
      const callOpenB = useSetAtom(deferredB.openFx)

      const handleOpenA = async () => {
        const result = await callOpenA({ id: 'a' })

        onResolvedA(result)
      }

      const handleOpenB = async () => {
        const result = await callOpenB({ id: 'b' })

        onResolvedB(result)
      }

      return (
        <>
          <button type="button" onClick={handleOpenA}>
            open-a
          </button>
          <button type="button" onClick={handleOpenB}>
            open-b
          </button>
          <button
            type="button"
            onClick={() => {
              return callResolveA({ ok: true, payload: 'a-only' })
            }}
          >
            resolve-a
          </button>
        </>
      )
    }

    const screen = await render(
      <Provider>
        <Harness />
      </Provider>,
    )

    await screen.getByRole('button', { name: 'open-a' }).click()
    await screen.getByRole('button', { name: 'open-b' }).click()
    await screen.getByRole('button', { name: 'resolve-a' }).click()

    await vi.waitFor(() => {
      return expect(onResolvedA).toHaveBeenCalledTimes(1)
    })
    expect(onResolvedA).toHaveBeenCalledWith({ ok: true, payload: 'a-only' })
    expect(onResolvedB).not.toHaveBeenCalled()
  })
})
