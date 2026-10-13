import type { AuthClient, AuthClientOptions, MagicLinkRequest, VerifyMagicLinkResult } from '../types.js'

/** A non-2xx response; `type` is the error body's `type`, when it has one. */
export class AuthHttpError extends Error {
  readonly status: number
  readonly type?: string

  constructor(status: number, url: string, type?: string) {
    super(`Auth API: ${status} - ${url}`)
    this.name = 'AuthHttpError'
    this.status = status
    this.type = type
  }
}

// Duck-typed rather than `instanceof` so a host's own `AuthClient` only has to throw something
// carrying `status`.
export const isUnauthorized = (error: unknown): boolean => {
  return (error as { status?: unknown } | null)?.status === 401
}

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.headers?.get('content-type')?.includes('application/json')) return undefined

  try {
    return await response.json()
  } catch {
    return undefined
  }
}

const errorType = (body: unknown): string | undefined => {
  const type = (body as { type?: unknown } | undefined)?.type

  return typeof type === 'string' ? type : undefined
}

/**
 * The plain-`fetch` client for a cookie-session magic-link API. JSON in and out; every non-2xx
 * rejects with an `AuthHttpError`, except where the `AuthClient` contract says otherwise.
 *
 * @example
 *     const client = createAuthClient<User>({ paths: { requestMagicLink: '/auth/magic-link', … } })
 */
export const createAuthClient = <TUser>(options: AuthClientOptions): AuthClient<TUser> => {
  const { paths, baseUrl = '', credentials = 'same-origin' } = options

  // Wrapped (not captured) so a global `fetch` stubbed after creation is still the one called.
  const doFetch =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) => {
      return fetch(input, init)
    })

  const send = async (path: string, init: { method: string; body?: unknown }): Promise<Response> => {
    const url = `${baseUrl}${path}`

    const response = await doFetch(url, {
      method: init.method,
      credentials,
      headers: { 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

    if (!response.ok) {
      throw new AuthHttpError(response.status, url, errorType(await readJson(response)))
    }

    return response
  }

  const ownRefresh = async (): Promise<boolean> => {
    try {
      await send(paths.refresh, { method: 'POST' })

      return true
    } catch {
      return false
    }
  }

  return {
    requestMagicLink: async (request: MagicLinkRequest) => {
      await send(paths.requestMagicLink, {
        method: 'POST',
        body: { email: request.email, ...(request.redirectUrl ? { redirectUrl: request.redirectUrl } : {}) },
      })
    },
    verifyMagicLink: async (token: string): Promise<VerifyMagicLinkResult> => {
      try {
        const response = await send(`${paths.verifyMagicLink}?token=${encodeURIComponent(token)}`, { method: 'GET' })
        const body = (await readJson(response)) as { ok?: boolean; redirect?: string } | undefined

        if (!body?.ok) return { ok: false, errorCode: errorType(body) }

        return { ok: true, redirect: body.redirect }
      } catch (error) {
        return { ok: false, errorCode: error instanceof AuthHttpError ? error.type : undefined }
      }
    },
    me: async () => {
      return (await readJson(await send(paths.me, { method: 'GET' }))) as TUser
    },
    refresh: options.refresh ?? ownRefresh,
    logout: async () => {
      await send(paths.logout, { method: 'POST' })
    },
  }
}
