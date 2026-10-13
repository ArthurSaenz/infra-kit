import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAuthClient } from '../services/auth-client.js'
import { DEFAULT_REQUEST_ERROR_TEXT, createAuthStore } from '../services/auth-store.js'
import type { AuthStoreOptions } from '../types.js'
import { PATHS, USER, callsTo, errorResponse, okResponse } from './fixtures.js'
import type { TestUser } from './fixtures.js'

const newStore = (options?: AuthStoreOptions<TestUser>) => {
  return createAuthStore(createAuthClient<TestUser>({ paths: PATHS }), options)
}

describe('submitEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalises the email, sets sentToEmail and clears the error on success', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return okResponse({ message: 'ok' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore()
    const result = await store.submitEmail({ email: '  User@Example.com ' })

    expect(result).toEqual({ ok: true, email: 'user@example.com' })
    expect(store.getState()).toMatchObject({
      sentToEmail: 'user@example.com',
      requestError: null,
      requestLoading: false,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ email: 'user@example.com' })
  })

  it('sets the default request error and returns ok:false on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return errorResponse(500, { type: 'SERVER_ERROR' })
      }),
    )

    const store = newStore()
    const result = await store.submitEmail({ email: 'a@b.com' })

    expect(result.ok).toBe(false)
    expect(store.getState()).toMatchObject({
      requestError: DEFAULT_REQUEST_ERROR_TEXT,
      sentToEmail: null,
      requestLoading: false,
    })
  })

  it('uses the configured request error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )

    const store = newStore({ requestErrorText: 'Nope.' })

    await store.submitEmail({ email: 'a@b.com' })

    expect(store.getState().requestError).toBe('Nope.')
  })

  it('clears a previous error and shows loading while the request is in flight', async () => {
    let release: (response: Response) => void = () => {}

    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }),
    )

    const store = newStore({ initialState: { requestError: 'previous error' } })
    const pending = store.submitEmail({ email: 'a@b.com' })

    expect(store.getState()).toMatchObject({ requestError: null, requestLoading: true })

    release(okResponse({ message: 'ok' }))
    await pending

    expect(store.getState().requestLoading).toBe(false)
  })

  it('resetSentEmail clears sentToEmail', () => {
    const store = newStore({ initialState: { sentToEmail: 'a@b.com' } })

    store.resetSentEmail()

    expect(store.getState().sentToEmail).toBeNull()
  })
})

describe('verify', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns ok with redirect and sets authenticated on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return okResponse({ ok: true, redirect: '/chat' })
      }),
    )

    const store = newStore()

    expect(await store.verify('abc')).toEqual({ ok: true, redirect: '/chat' })
    expect(store.getState().status).toBe('authenticated')
  })

  it('returns the error code and leaves the status alone on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return errorResponse(401, { type: 'INVALID_OR_EXPIRED_TOKEN' })
      }),
    )

    const store = newStore()

    expect(await store.verify('bad')).toEqual({ ok: false, errorCode: 'INVALID_OR_EXPIRED_TOKEN' })
    expect(store.getState().status).toBe('unknown')
  })
})

describe('fetchMe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets the user and authenticated status when /me succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return okResponse(USER)
      }),
    )

    const store = newStore()

    expect(await store.fetchMe()).toEqual(USER)
    expect(store.getState()).toMatchObject({ status: 'authenticated', user: USER, isSessionLoading: false })
  })

  it('flags isSessionLoading while the request is in flight', async () => {
    let release: (response: Response) => void = () => {}

    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }),
    )

    const store = newStore()
    const pending = store.fetchMe()

    expect(store.getState().isSessionLoading).toBe(true)

    release(okResponse(USER))
    await pending

    expect(store.getState().isSessionLoading).toBe(false)
  })

  it('collapses concurrent callers onto one request, and allows a new one after it settles', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return okResponse(USER)
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore()
    const first = store.fetchMe()
    const second = store.fetchMe()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(callsTo(fetchMock, PATHS.me)).toHaveLength(1)

    await store.fetchMe()
    expect(callsTo(fetchMock, PATHS.me)).toHaveLength(2)
  })

  it('collapses concurrent 401s onto one refresh', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(PATHS.refresh)) return okResponse({ ok: true })

      return callsTo(fetchMock, PATHS.me).length > 1
        ? okResponse(USER)
        : errorResponse(401, { type: 'UNAUTHENTICATED' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore()

    await Promise.all([store.fetchMe(), store.fetchMe(), store.fetchMe()])

    expect(callsTo(fetchMock, PATHS.refresh)).toHaveLength(1)
  })

  it('silently refreshes on a 401 then retries /me and authenticates', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(PATHS.refresh)) return okResponse({ ok: true })

      // First /me is 401 (expired access token); the retry after refresh succeeds.
      return callsTo(fetchMock, PATHS.me).length > 1
        ? okResponse(USER)
        : errorResponse(401, { type: 'UNAUTHENTICATED' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore()

    expect(await store.fetchMe()).toEqual(USER)
    expect(store.getState().status).toBe('authenticated')
    expect(callsTo(fetchMock, PATHS.refresh)).toHaveLength(1)
    expect(callsTo(fetchMock, PATHS.me)).toHaveLength(2)
  })

  it('ends unauthenticated when /me is 401 and refresh also fails', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return errorResponse(401, { type: 'UNAUTHENTICATED' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore({ initialState: { status: 'authenticated', user: USER } })

    expect(await store.fetchMe()).toBeNull()
    expect(store.getState()).toMatchObject({ status: 'unauthenticated', user: null })
    expect(callsTo(fetchMock, PATHS.me)).toHaveLength(1)
  })

  it('does not refresh on a non-401 failure', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return errorResponse(500, { type: 'SERVER_ERROR' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const store = newStore()

    expect(await store.fetchMe()).toBeNull()
    expect(store.getState().status).toBe('unauthenticated')
    expect(callsTo(fetchMock, PATHS.refresh)).toHaveLength(0)
  })
})

describe('logout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the user and sets unauthenticated even if the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }),
    )

    const store = newStore({ initialState: { status: 'authenticated', user: USER } })

    await store.logout()

    expect(store.getState()).toMatchObject({ status: 'unauthenticated', user: null })
  })
})

describe('refresh and subscribe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refresh delegates to the client', async () => {
    const refresh = vi.fn(async () => {
      return true
    })

    const store = createAuthStore(createAuthClient<TestUser>({ paths: PATHS, refresh }))

    expect(await store.refresh()).toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('notifies subscribers on change until they unsubscribe', () => {
    const store = newStore({ initialState: { sentToEmail: 'a@b.com' } })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.resetSentEmail()
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    store.resetSentEmail()
    expect(listener).toHaveBeenCalledOnce()
  })
})
