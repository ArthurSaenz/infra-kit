import crypto from 'node:crypto'

import type { MagicLinkEmailText } from './email.js'
import { buildMagicLinkUrl, renderMagicLinkEmail } from './email.js'
import type { AuthErrorCode, CreateAuthError } from './errors.js'
import { defaultCreateAuthError } from './errors.js'
import type { CookieOptions, HeaderBag } from './http.js'
import {
  buildAccessCookie,
  buildClearCookies,
  buildRefreshCookie,
  extractAccessToken,
  extractRefreshToken,
  resolveCookieOptions,
  sanitizeRedirectUrl,
} from './http.js'
import type {
  AuthContext,
  AuthUser,
  MagicTokenStore,
  Mailer,
  RateLimiter,
  SessionStore,
  StoredSession,
  UserStore,
} from './ports.js'
import type { AccessTokenPayload, JwtIdentity } from './tokens.js'
import {
  DEFAULT_ACCESS_TTL_SEC,
  DEFAULT_REFRESH_TTL_SEC,
  assertSecret,
  generateRawToken,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens.js'

export const DEFAULT_MAGIC_TOKEN_TTL_MIN = 15
// An invite can sit unread for days while a sign-in link is clicked seconds after it is requested;
// 72 h covers "saw it after the weekend", and re-inviting invalidates the old link.
export const DEFAULT_INVITE_TOKEN_TTL_MIN = 72 * 60

export interface RateLimitConfig {
  perEmail: number
  perIp: number
  perIpVerify: number
  perIpRefresh: number
  windowSec: number
  /** Key namespace in the limiter's store; two apps sharing one store and one prefix share budgets. */
  keyPrefix: string
}

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perEmail: 5,
  perIp: 20,
  perIpVerify: 30,
  perIpRefresh: 60,
  windowSec: 3600,
  keyPrefix: 'magic',
}

export interface RequestMeta {
  ipAddress?: string
  userAgent?: string
}

export interface RequestMagicLinkInput extends RequestMeta {
  email: string
  redirectUrl?: string
}

export interface VerifyMagicLinkInput extends RequestMeta {
  rawToken: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessCookie: string
  refreshCookie: string
}

export interface VerifyMagicLinkResult extends TokenPair {
  redirectUrl: string
}

export interface MagicLinkAuthConfig<TUser extends AuthUser, TMe, TCtx extends AuthContext> {
  users: UserStore<TUser, TCtx>
  magicTokens: MagicTokenStore<TCtx>
  sessions: SessionStore<TCtx>
  rateLimiter: RateLimiter<TCtx>
  mailer: Mailer<TCtx>
  jwt: JwtIdentity & { accessSecret: string; refreshSecret: string; accessTtlSec?: number; refreshTtlSec?: number }
  /** `baseUrl` is the SPA origin; the emailed link is `${baseUrl}${verifyPath}?token=…`. */
  magicLink: { baseUrl: string; verifyPath?: string; ttlMin?: number; inviteTtlMin?: number }
  email: MagicLinkEmailText
  /** The DTO `GET /auth/me` answers with. */
  toMe: (user: TUser) => TMe
  cookies?: CookieOptions
  rateLimits?: Partial<RateLimitConfig>
  /**
   * What a link request from an address that may not sign in gets. `silent` (default) answers like a
   * success so a public endpoint is not a membership oracle; `reject` throws NOT_INVITED (403) for an
   * internal tool whose invited users need the feedback.
   */
  uninvitedRequest?: 'silent' | 'reject'
  /** The allowlist; re-asked at request, verify AND refresh so a revoke ends running sessions. */
  isAllowed?: (user: TUser) => boolean
  /** Copied into the access token. Informational: authorise from the loaded row, not from the claim. */
  rolesOf?: (user: TUser) => string[]
  /** Side effects of a successful sign-in (mark the email verified, record the login…). */
  onSignIn?: (user: TUser, ctx?: TCtx) => Promise<void>
  /** Throw to reject. A rejected link request still answers like a success (anti-enumeration). */
  validate?: {
    requestMagicLink?: (input: RequestValidationInput, ctx?: TCtx) => void
    verifyMagicLink?: (input: { rawToken: string }, ctx?: TCtx) => void
  }
  createError?: CreateAuthError
  notInvitedMessage?: string
}

export interface RequestValidationInput {
  email: string
  redirectUrl: string | undefined
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_REDIRECT_CHARS = /[\\\u0000-\u001F\u007F]/
const EMAIL_REGEX = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/
const TOKEN_REGEX = /^[a-f0-9]{16,256}$/i

const toMs = (value: Date | string): number => {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

const withMeta = (meta: RequestMeta | undefined): RequestMeta => {
  return {
    ...(meta?.ipAddress ? { ipAddress: meta.ipAddress } : {}),
    ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
  }
}

export type MagicLinkAuth<TUser extends AuthUser, TMe, TCtx extends AuthContext> = ReturnType<
  typeof createMagicLinkAuth<TUser, TMe, TCtx>
>

export const createMagicLinkAuth = <TUser extends AuthUser, TMe, TCtx extends AuthContext = AuthContext>(
  config: MagicLinkAuthConfig<TUser, TMe, TCtx>,
) => {
  assertSecret('jwt.accessSecret', config.jwt.accessSecret)
  assertSecret('jwt.refreshSecret', config.jwt.refreshSecret)

  if (config.jwt.accessSecret === config.jwt.refreshSecret) {
    throw new Error('auth: jwt.accessSecret and jwt.refreshSecret must differ')
  }

  if (!config.magicLink.baseUrl) {
    throw new Error('auth: magicLink.baseUrl is required')
  }

  const { users, magicTokens, sessions, rateLimiter, mailer } = config
  const identity: JwtIdentity = { issuer: config.jwt.issuer, audience: config.jwt.audience }
  const accessTtlSec = config.jwt.accessTtlSec ?? DEFAULT_ACCESS_TTL_SEC
  const refreshTtlSec = config.jwt.refreshTtlSec ?? DEFAULT_REFRESH_TTL_SEC
  const signInTtlMin = config.magicLink.ttlMin ?? DEFAULT_MAGIC_TOKEN_TTL_MIN
  const inviteTtlMin = config.magicLink.inviteTtlMin ?? DEFAULT_INVITE_TOKEN_TTL_MIN
  const cookies = resolveCookieOptions(config.cookies)
  const maxTokenAgeMs = Math.max(signInTtlMin, inviteTtlMin) * 60 * 1000
  // Per key, so an explicit `undefined` override keeps the default instead of disabling the limit.
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_RATE_LIMITS).map(([key, fallback]) => {
      return [key, config.rateLimits?.[key as keyof RateLimitConfig] ?? fallback]
    }),
  ) as unknown as RateLimitConfig
  const createError = config.createError ?? defaultCreateAuthError
  const notInvitedMessage = config.notInvitedMessage ?? 'This email is not invited.'

  const isAllowed =
    config.isAllowed ??
    ((user: TUser) => {
      return user.invited === true
    })
  const rolesOf =
    config.rolesOf ??
    ((user: TUser) => {
      return user.roles ?? []
    })

  const fail = (message: string, code: AuthErrorCode, status: number): Error => {
    return createError({ message, code, status })
  }

  const invalidSession = (code: AuthErrorCode = 'INVALID_REFRESH_TOKEN'): Error => {
    return fail('Invalid session', code, 401)
  }

  const validateRequest =
    config.validate?.requestMagicLink ??
    ((input: RequestValidationInput) => {
      if (input.email.length > 320 || !EMAIL_REGEX.test(input.email)) throw new Error('Invalid email')

      if (input.redirectUrl && (input.redirectUrl.length > 2048 || UNSAFE_REDIRECT_CHARS.test(input.redirectUrl))) {
        throw new Error('Invalid redirectUrl')
      }
    })

  const validateVerify =
    config.validate?.verifyMagicLink ??
    ((input: { rawToken: string }) => {
      if (!TOKEN_REGEX.test(input.rawToken)) {
        throw fail('rawToken must be hex', 'INVALID_REQUEST', 400)
      }
    })

  const checkRate = async (key: string, limit: number, ctx?: TCtx): Promise<boolean> => {
    const gate = await rateLimiter.incrementAndCheck(`${limits.keyPrefix}:${key}`, limit, limits.windowSec, ctx)

    return gate.allowed
  }

  const mintAndSendMagicLink = async (
    email: string,
    redirectUrl: string,
    meta: RequestMeta,
    ttlMin: number,
    ctx?: TCtx,
  ): Promise<void> => {
    await magicTokens.invalidateByEmail(email, ctx)

    const rawToken = generateRawToken()

    await magicTokens.create(
      {
        email,
        tokenHash: hashToken(rawToken),
        redirectUrl,
        expiresAt: new Date(Date.now() + ttlMin * 60 * 1000),
        ...withMeta(meta),
      },
      ctx,
    )

    const link = buildMagicLinkUrl(config.magicLink.baseUrl, rawToken, redirectUrl, config.magicLink.verifyPath)

    try {
      await mailer.send(renderMagicLinkEmail(email, link, ttlMin, config.email), ctx)
    } catch (error) {
      // A token nobody received must not stay redeemable.
      ctx?.logger?.error('Magic link send failed; invalidating the undelivered token', {
        data: { name: (error as Error).name },
      })

      try {
        await magicTokens.invalidateByEmail(email, ctx)
      } catch (cleanupError) {
        ctx?.logger?.error('Failed to invalidate the undelivered magic token', {
          data: { name: (cleanupError as Error).name },
        })
      }
    }
  }

  const loadUser = async (userId: string, ctx?: TCtx): Promise<TUser> => {
    const user = await users.findById(userId, ctx)

    if (!user) throw fail('User not found', 'USER_NOT_FOUND', 401)

    return user
  }

  /** Mint an access + refresh pair for `user` and persist the refresh session. */
  const issueSession = async (user: TUser, meta?: RequestMeta, ctx?: TCtx): Promise<TokenPair> => {
    const userId = String(user.id)
    const jti = crypto.randomUUID()
    const access = signAccessToken(
      { sub: userId, roles: rolesOf(user), authMethod: 'magic' },
      config.jwt.accessSecret,
      identity,
      accessTtlSec,
    )
    const refresh = signRefreshToken({ sub: userId, jti }, config.jwt.refreshSecret, identity, refreshTtlSec)

    await sessions.create(
      {
        userId,
        tokenHash: hashToken(refresh.token),
        jti,
        expiresAt: new Date(Date.now() + refresh.expSec * 1000),
        ...withMeta(meta),
      },
      ctx,
    )

    return toPair(access.token, access.expSec, refresh.token, refresh.expSec)
  }

  const toPair = (accessToken: string, accessExp: number, refreshToken: string, refreshExp: number): TokenPair => {
    return {
      accessToken,
      refreshToken,
      accessCookie: buildAccessCookie(cookies, accessToken, accessExp),
      refreshCookie: buildRefreshCookie(cookies, refreshToken, refreshExp),
    }
  }

  const rotateSession = async (session: StoredSession, user: TUser, ctx?: TCtx): Promise<TokenPair> => {
    const userId = String(user.id)
    const jti = crypto.randomUUID()
    const access = signAccessToken(
      { sub: userId, roles: rolesOf(user), authMethod: 'magic' },
      config.jwt.accessSecret,
      identity,
      accessTtlSec,
    )
    const refresh = signRefreshToken({ sub: userId, jti }, config.jwt.refreshSecret, identity, refreshTtlSec)

    const rotated = await sessions.rotate(
      String(session.id),
      {
        userId,
        tokenHash: hashToken(refresh.token),
        jti,
        expiresAt: new Date(Date.now() + refresh.expSec * 1000),
        ...withMeta({
          ...(session.ipAddress ? { ipAddress: session.ipAddress } : {}),
          ...(session.userAgent ? { userAgent: session.userAgent } : {}),
        }),
      },
      ctx,
    )

    // The `revokedAt` read in refresh happens outside the rotation transaction, so two refreshes
    // presenting the same live token (a parallel tab, not an attack) both pass it; `rotate` settles
    // the race under its row lock. Fail only the loser: the winner's session stays valid.
    if (!rotated) {
      ctx?.logger?.warn('Concurrent refresh lost the rotation race; failing this request only', {
        data: { userId },
      })

      throw invalidSession()
    }

    return toPair(access.token, access.expSec, refresh.token, refresh.expSec)
  }

  const requireUser = (headers: HeaderBag): AccessTokenPayload => {
    const token = extractAccessToken(headers, cookies.accessName)

    if (!token) throw fail('Missing access token', 'UNAUTHENTICATED', 401)

    return verifyAccessToken(token, config.jwt.accessSecret, identity, createError)
  }

  return {
    cookies,
    identity,
    uninvitedRequest: config.uninvitedRequest ?? 'silent',

    async requestMagicLink(input: RequestMagicLinkInput, ctx?: TCtx): Promise<void> {
      const email = (input.email || '').trim().toLowerCase()

      try {
        validateRequest({ email, redirectUrl: input.redirectUrl }, ctx)
      } catch (validationError) {
        ctx?.logger?.info('Magic link request rejected by validation; answering the generic OK', {
          data: { reason: (validationError as Error).name },
        })

        return
      }

      const redirectUrl = sanitizeRedirectUrl(input.redirectUrl)
      const emailAllowed = await checkRate(`email:${email}`, limits.perEmail, ctx)
      const ipAllowed = input.ipAddress ? await checkRate(`ip:${input.ipAddress}`, limits.perIp, ctx) : true

      if (!emailAllowed || !ipAllowed) {
        ctx?.logger?.warn('Magic link rate limit exceeded', { data: { emailAllowed, ipAllowed } })

        return
      }

      // Never create a user here: an address that is not already allowed gets no row, no token and
      // no email. Creating on request is how an invite-only surface ends up open to the internet.
      const user = await users.findByEmail(email, ctx)

      if (!user || !isAllowed(user)) {
        ctx?.logger?.warn('Magic link requested by an address that may not sign in', {
          data: { exists: Boolean(user) },
        })

        if (config.uninvitedRequest === 'reject') throw fail(notInvitedMessage, 'NOT_INVITED', 403)

        return
      }

      await mintAndSendMagicLink(email, redirectUrl, input, signInTtlMin, ctx)
    },

    /**
     * Email a sign-in link on an admin's behalf: no rate limit and no allowlist check, because the
     * caller has just authorised this address. Uses the longer invite TTL.
     */
    async sendInviteLink(email: string, ctx?: TCtx): Promise<void> {
      await mintAndSendMagicLink(
        (email || '').trim().toLowerCase(),
        sanitizeRedirectUrl(undefined),
        {},
        inviteTtlMin,
        ctx,
      )
    },

    async verifyMagicLink(input: VerifyMagicLinkInput, ctx?: TCtx): Promise<VerifyMagicLinkResult> {
      validateVerify({ rawToken: input.rawToken }, ctx)

      if (input.ipAddress && !(await checkRate(`verify:ip:${input.ipAddress}`, limits.perIpVerify, ctx))) {
        ctx?.logger?.warn('Magic link verify rate limit exceeded', { data: { ipAddress: input.ipAddress } })
        throw fail('Too many requests', 'RATE_LIMITED', 429)
      }

      const record = await magicTokens.consumeByHash(hashToken(input.rawToken), ctx)

      if (!record) throw fail('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN', 401)

      // `consumeByHash` should already skip expired rows; this re-check uses the token's own expiry
      // (so a 72 h invite is honoured) and treats an unparseable one as expired, never as "no expiry".
      const expiresAtMs = toMs(record.expiresAt)

      if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
        throw fail('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN', 401)
      }

      // Two hosts sharing one token table would otherwise honour each other's TTLs (a 72 h staff
      // invite redeemed at a 15-minute traveller surface): no token outlives this host's longest TTL.
      if (record.createdAt !== undefined && Date.now() - toMs(record.createdAt) > maxTokenAgeMs) {
        throw fail('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN', 401)
      }

      // The allowlist may have been revoked between request and verify.
      const user = await users.findByEmail(record.email, ctx)

      if (!user || !isAllowed(user)) {
        ctx?.logger?.warn('Magic link verify rejected: address may not sign in', {
          data: { exists: Boolean(user) },
        })
        throw fail(notInvitedMessage, 'NOT_INVITED', 403)
      }

      await config.onSignIn?.(user, ctx)

      const pair = await issueSession(user, input, ctx)

      return { ...pair, redirectUrl: sanitizeRedirectUrl(record.redirectUrl) }
    },

    async refreshSession(refreshToken: string, ctx?: TCtx, meta?: RequestMeta): Promise<TokenPair> {
      if (!refreshToken) throw invalidSession('UNAUTHENTICATED')

      if (meta?.ipAddress && !(await checkRate(`refresh:ip:${meta.ipAddress}`, limits.perIpRefresh, ctx))) {
        ctx?.logger?.warn('Refresh rate limit exceeded', { data: { ipAddress: meta.ipAddress } })
        throw fail('Too many requests', 'RATE_LIMITED', 429)
      }

      const payload = verifyRefreshToken(refreshToken, config.jwt.refreshSecret, identity, createError)
      const session = await sessions.findByTokenHash(hashToken(refreshToken), ctx)

      if (!session) throw invalidSession()

      if (session.revokedAt) {
        ctx?.logger?.warn('Refresh token reuse detected; revoking every session of the user', {
          data: { userId: session.userId },
        })
        await sessions.revokeAllForUser(session.userId, ctx)

        throw invalidSession()
      }

      if (toMs(session.expiresAt) < Date.now()) throw invalidSession()

      const user = await users.findById(payload.sub, ctx)

      if (!user) throw invalidSession('USER_NOT_FOUND')

      // Refresh is where a long-lived session re-earns its right to exist, so a revoked invite must
      // end it here. Revoke every session: the siblings would walk straight back in on their next rotation.
      if (!isAllowed(user)) {
        ctx?.logger?.warn('Refresh by a user who may no longer sign in; revoking every session', {
          data: { userId: String(user.id) },
        })
        await sessions.revokeAllForUser(String(user.id), ctx)

        throw fail(notInvitedMessage, 'NOT_INVITED', 403)
      }

      return rotateSession(session, user, ctx)
    },

    async logout(refreshToken: string | null, ctx?: TCtx): Promise<void> {
      if (!refreshToken) return

      try {
        await sessions.revokeByTokenHash(hashToken(refreshToken), ctx)
      } catch (error) {
        ctx?.logger?.warn('Failed to revoke session on logout', { data: { name: (error as Error).name } })
      }
    },

    /** The verified access-token payload, or UNAUTHENTICATED / INVALID_ACCESS_TOKEN (401). */
    requireUser,

    /** `requireUser` plus the freshly loaded row: authorise from this, so a revoke applies on the next request. */
    async authenticate(headers: HeaderBag, ctx?: TCtx): Promise<{ payload: AccessTokenPayload; user: TUser }> {
      const payload = requireUser(headers)

      return { payload, user: await loadUser(payload.sub, ctx) }
    },

    async getMe(payload: AccessTokenPayload, ctx?: TCtx): Promise<TMe> {
      return config.toMe(await loadUser(payload.sub, ctx))
    },

    issueSession,

    extractAccessToken(headers: HeaderBag): string | null {
      return extractAccessToken(headers, cookies.accessName)
    },

    extractRefreshToken(headers: HeaderBag): string | null {
      return extractRefreshToken(headers, cookies.refreshName)
    },

    clearCookies(): string[] {
      return buildClearCookies(cookies)
    },
  }
}
