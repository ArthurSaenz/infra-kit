import type { AuthClient, AuthState, AuthStore, AuthStoreOptions, MagicLinkRequest, MagicLinkResult } from '../types.js'
import { isUnauthorized } from './auth-client.js'

export const DEFAULT_REQUEST_ERROR_TEXT = 'We could not send your sign-in link. Please try again.'

/**
 * A framework-agnostic external store (`subscribe` / `getState`) holding the session and the
 * magic-link form state, with the actions that change them. React reads it through `AuthProvider`.
 *
 * @example
 *     const store = createAuthStore(createAuthClient<User>({ paths }))
 *     await store.fetchMe()
 */
export const createAuthStore = <TUser>(
  client: AuthClient<TUser>,
  options: AuthStoreOptions<TUser> = {},
): AuthStore<TUser> => {
  const { requestErrorText = DEFAULT_REQUEST_ERROR_TEXT } = options

  let state: AuthState<TUser> = {
    status: 'unknown',
    user: null,
    requestLoading: false,
    sentToEmail: null,
    requestError: null,
    isSessionLoading: false,
    ...options.initialState,
  }

  const listeners = new Set<() => void>()

  const setState = (patch: Partial<AuthState<TUser>>) => {
    state = { ...state, ...patch }
    listeners.forEach((listener) => {
      listener()
    })
  }

  // Concurrent callers (a layout, the sign-in form, the verify page, a StrictMode double-invoke)
  // collapse onto one /me call. Two concurrent 401 → refresh paths would otherwise present the same
  // refresh token twice, which a backend with reuse detection answers by revoking every session.
  let inFlightFetchMe: Promise<TUser | null> | null = null

  const loadUser = async (): Promise<TUser | null> => {
    setState({ isSessionLoading: true })

    try {
      let user: TUser

      try {
        user = await client.me()
      } catch (error) {
        // The short-lived access token may have expired while the refresh token is still valid —
        // on a 401, attempt a single silent refresh, then retry once.
        if (!isUnauthorized(error) || !(await client.refresh())) throw error

        user = await client.me()
      }

      setState({ user, status: 'authenticated', isSessionLoading: false })

      return user
    } catch {
      setState({ user: null, status: 'unauthenticated', isSessionLoading: false })

      return null
    }
  }

  return {
    getState: () => {
      return state
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    submitEmail: async (request: MagicLinkRequest): Promise<MagicLinkResult> => {
      const email = request.email.trim().toLowerCase()

      setState({ requestLoading: true, requestError: null })

      try {
        await client.requestMagicLink({ email, redirectUrl: request.redirectUrl })
        setState({ sentToEmail: email, requestLoading: false })

        return { ok: true, email }
      } catch {
        setState({ requestError: requestErrorText, requestLoading: false })

        return { ok: false, email }
      }
    },
    resetSentEmail: () => {
      setState({ sentToEmail: null })
    },
    fetchMe: () => {
      inFlightFetchMe ??= loadUser().finally(() => {
        inFlightFetchMe = null
      })

      return inFlightFetchMe
    },
    verify: async (token: string) => {
      const result = await client.verifyMagicLink(token)

      if (result.ok) setState({ status: 'authenticated' })

      return result
    },
    logout: async () => {
      try {
        await client.logout()
      } catch {
        // Ignore network failures: logout must always clear the local session.
      } finally {
        setState({ user: null, status: 'unauthenticated' })
      }
    },
    refresh: () => {
      return client.refresh()
    },
  }
}
