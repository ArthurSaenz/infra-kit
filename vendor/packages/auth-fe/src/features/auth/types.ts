import type { ReactNode } from 'react'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

export interface AuthPaths {
  /** POST `{ email, redirectUrl? }` — emails the sign-in link. */
  requestMagicLink: string
  /** GET `?token=` — exchanges the link's token for the session cookies. */
  verifyMagicLink: string
  /** GET — the signed-in user. */
  me: string
  /** POST — rotates the session from the refresh-token cookie. */
  refresh: string
  /** POST — ends the session. */
  logout: string
}

export interface AuthClientOptions {
  paths: AuthPaths
  /** Prefix for every path; `''` (same-origin) by default. */
  baseUrl?: string
  /** Defaults to the global `fetch`, looked up at call time. */
  fetch?: typeof fetch
  credentials?: RequestCredentials
  /**
   * Replaces the client's own `POST paths.refresh`. A host that refreshes from more than one place
   * passes its single-flight refresh here: two concurrent refreshes present the same refresh token
   * twice, and a backend with reuse detection revokes the session.
   */
  refresh?: () => Promise<boolean>
}

export interface MagicLinkRequest {
  email: string
  redirectUrl?: string
}

export interface MagicLinkResult {
  ok: boolean
  email: string
}

export interface VerifyMagicLinkResult {
  ok: boolean
  redirect?: string
  /** The error body's `type` (e.g. `INVALID_OR_EXPIRED_TOKEN`); absent on a network failure. */
  errorCode?: string
}

export interface AuthClient<TUser> {
  /** Rejects on any non-2xx or network failure. */
  requestMagicLink: (request: MagicLinkRequest) => Promise<void>
  /** Never rejects. */
  verifyMagicLink: (token: string) => Promise<VerifyMagicLinkResult>
  /** Rejects with an `AuthHttpError` on a non-2xx, so a 401 can be told apart. */
  me: () => Promise<TUser>
  /** Resolves `true` when a fresh access cookie was issued; never rejects. */
  refresh: () => Promise<boolean>
  /** Rejects on any non-2xx or network failure. */
  logout: () => Promise<void>
}

export interface AuthState<TUser> {
  status: AuthStatus
  user: TUser | null
  /** A magic-link request is in flight. */
  requestLoading: boolean
  /** Where the last link went; the form shows its "check your inbox" state while set. */
  sentToEmail: string | null
  requestError: string | null
  /** A `fetchMe` is in flight. */
  isSessionLoading: boolean
}

export interface AuthStoreOptions<TUser> {
  /** The text `requestError` takes when a magic-link request fails. */
  requestErrorText?: string
  initialState?: Partial<AuthState<TUser>>
}

export interface AuthStore<TUser> {
  getState: () => AuthState<TUser>
  subscribe: (listener: () => void) => () => void
  /** Trims and lower-cases the email before sending it. */
  submitEmail: (request: MagicLinkRequest) => Promise<MagicLinkResult>
  resetSentEmail: () => void
  /** Concurrent callers share one in-flight request; a 401 gets one silent refresh and one retry. */
  fetchMe: () => Promise<TUser | null>
  verify: (token: string) => Promise<VerifyMagicLinkResult>
  /** Clears the local session even when the request fails. */
  logout: () => Promise<void>
  refresh: () => Promise<boolean>
}

export interface AuthProviderProps<TUser> {
  store: AuthStore<TUser>
  children?: ReactNode
}

export interface AuthFormRenderProps {
  status: AuthStatus
  loading: boolean
  sentToEmail: string | null
  error: string | null
  onSubmit: (values: { email: string }) => Promise<MagicLinkResult>
  onUseDifferentEmail: () => void
}

export interface AuthFormContainerProps {
  /** Where to land after sign-in; passed through `safeRedirect`. */
  redirect?: string
  /** Fired when the session is (or becomes) authenticated, with the safe redirect target. */
  onAuthenticated: (target: string) => void
  render: (props: AuthFormRenderProps) => ReactNode
}

export type AuthVerifyState = 'idle' | 'loading' | 'error'

export interface AuthVerifyContainerProps {
  token?: string
  /** Fallback target when the verify response carries no `redirect`. */
  redirect?: string
  /** Fired once the token is verified and the user is loaded, with the safe redirect target. */
  onVerified: (target: string) => void
  render: (state: AuthVerifyState) => ReactNode
}

export interface SessionRenderProps<TUser> {
  user: TUser
  /** Logs out, then calls `onLoggedOut`. */
  onLogout: () => Promise<void>
}

export interface UserMenuContainerProps<TUser> {
  onLoggedOut: () => void | Promise<void>
  render: (props: SessionRenderProps<TUser>) => ReactNode
}

export interface RequireAuthContainerProps<TUser> {
  /** Fired when the session resolves unauthenticated — typically a redirect to the sign-in page. */
  onUnauthenticated: () => void
  onLoggedOut: () => void | Promise<void>
  /** Shown while the session is unknown, loading, or unauthenticated (redirect in flight). */
  fallback: ReactNode
  /** Authorization on top of authentication; every signed-in user passes when omitted. */
  isAllowed?: (user: TUser) => boolean
  /** Rendered for a signed-in user `isAllowed` rejects; the children never mount. */
  renderDenied?: (props: SessionRenderProps<TUser>) => ReactNode
  children?: ReactNode
}
