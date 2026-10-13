import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthHttpError, createAuthClient, isUnauthorized } from '../services/auth-client.js'
import { PATHS, USER, errorResponse, okResponse } from './fixtures.js'
import type { TestUser } from './fixtures.js'

describe('createAuthClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the magic-link request as JSON, same-origin, omitting an empty redirectUrl', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return okResponse({ message: 'ok' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const client = createAuthClient<TestUser>({ paths: PATHS })

    await client.requestMagicLink({ email: 'a@b.com' })
    await client.requestMagicLink({ email: 'a@b.com', redirectUrl: '/chat' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/auth/magic-link', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    })
    expect(fetchMock.mock.calls[1]).toMatchObject([
      '/api/v1/auth/magic-link',
      { body: JSON.stringify({ email: 'a@b.com', redirectUrl: '/chat' }) },
    ])
  })

  it('rejects the magic-link request on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return errorResponse(500, { type: 'SERVER_ERROR' })
      }),
    )

    await expect(createAuthClient({ paths: PATHS }).requestMagicLink({ email: 'a@b.com' })).rejects.toBeInstanceOf(
      AuthHttpError,
    )
  })

  it('prefixes baseUrl and uses an injected fetch and credentials', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return okResponse(USER)
    })

    const client = createAuthClient<TestUser>({
      paths: PATHS,
      baseUrl: 'https://api.example.com',
      fetch: fetchMock,
      credentials: 'include',
    })

    await expect(client.me()).resolves.toEqual(USER)
    expect(fetchMock.mock.calls[0]).toMatchObject([
      'https://api.example.com/api/v1/auth/me',
      { method: 'GET', credentials: 'include' },
    ])
  })

  it('verifies with a URL-encoded token and returns the redirect', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return okResponse({ ok: true, redirect: '/chat' })
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await createAuthClient({ paths: PATHS }).verifyMagicLink('a b&c')

    expect(result).toEqual({ ok: true, redirect: '/chat' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/magic-link/verify?token=a%20b%26c')
  })

  it('maps a non-2xx verify body type to errorCode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return errorResponse(401, { type: 'INVALID_OR_EXPIRED_TOKEN' })
      }),
    )

    expect(await createAuthClient({ paths: PATHS }).verifyMagicLink('bad')).toEqual({
      ok: false,
      errorCode: 'INVALID_OR_EXPIRED_TOKEN',
    })
  })

  it('maps a 2xx verify body without ok to its type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return okResponse({ ok: false, type: 'TOKEN_USED' })
      }),
    )

    expect(await createAuthClient({ paths: PATHS }).verifyMagicLink('used')).toEqual({
      ok: false,
      errorCode: 'TOKEN_USED',
    })
  })

  it('never rejects verify on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )

    expect(await createAuthClient({ paths: PATHS }).verifyMagicLink('x')).toEqual({ ok: false, errorCode: undefined })
  })

  it('rejects me with a 401 the store can recognise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return errorResponse(401, { type: 'UNAUTHENTICATED' })
      }),
    )

    const error = await createAuthClient({ paths: PATHS })
      .me()
      .catch((caught: unknown) => {
        return caught
      })

    expect(isUnauthorized(error)).toBe(true)
    expect(error).toMatchObject({ status: 401, type: 'UNAUTHENTICATED' })
  })

  it('refreshes through its own endpoint, resolving false on failure', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      return errorResponse(401, {})
    })

    vi.stubGlobal('fetch', fetchMock)

    expect(await createAuthClient({ paths: PATHS }).refresh()).toBe(false)
    expect(fetchMock.mock.calls[0]).toMatchObject(['/api/v1/auth/refresh', { method: 'POST' }])

    fetchMock.mockImplementation(async () => {
      return okResponse({ ok: true })
    })

    expect(await createAuthClient({ paths: PATHS }).refresh()).toBe(true)
  })

  it('uses an injected refresh instead of its own endpoint', async () => {
    const fetchMock = vi.fn()
    const refresh = vi.fn(async () => {
      return true
    })

    vi.stubGlobal('fetch', fetchMock)

    expect(await createAuthClient({ paths: PATHS, refresh }).refresh()).toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a bodiless logout response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return { ok: true, status: 204 } as Response
      }),
    )

    await expect(createAuthClient({ paths: PATHS }).logout()).resolves.toBeUndefined()
  })
})
