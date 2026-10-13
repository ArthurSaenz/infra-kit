import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'

import type { CreateAuthError } from './errors.js'
import { defaultCreateAuthError } from './errors.js'
import type { RequestMeta, TokenPair } from './magicLinkAuth.js'
import type { AuthContext, AuthUser } from './ports.js'
import { MIN_SECRET_LENGTH } from './tokens.js'

/** Constant-time; false for any missing value or length mismatch (timingSafeEqual throws on those). */
export const safeSecretEqual = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false

  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

/** `E2E_AUTH_ALLOWED_EMAILS`: comma- or whitespace-separated, case-insensitive. */
export const parseAllowedEmails = (raw: string | undefined): string[] => {
  if (!raw) return []

  return raw
    .split(/[,\s]+/)
    .map((entry) => {
      return entry.trim().toLowerCase()
    })
    .filter(Boolean)
}

export interface E2eLoginConfig<TUser extends AuthUser, TCtx extends AuthContext> {
  /** The engine's `issueSession`: the same tokens, cookies and session row a magic link would give. */
  issueSession: (user: TUser, meta?: RequestMeta, ctx?: TCtx) => Promise<TokenPair>
  /** Empty disables the endpoint entirely: it answers 404, like a route that does not exist. */
  secret: string
  /** The only accounts this will ever sign in: the blast-radius cap if the secret leaks. */
  allowedEmails: string[]
  /** Turn an allowlisted email into the account to sign in (and record the login). */
  resolveAccount: (email: string, ctx?: TCtx) => Promise<TUser>
  createError?: CreateAuthError
}

export interface E2eLoginInput extends RequestMeta {
  email: string
  providedSecret: string | null
}

/**
 * A real session for a test account without the email round-trip, kept apart from the magic-link
 * surface. Three independent gates make it safe to ship to prod: secret unset → 404; constant-time
 * secret check; email allowlist.
 */
export const createE2eLogin = <TUser extends AuthUser, TCtx extends AuthContext>(
  config: E2eLoginConfig<TUser, TCtx>,
) => {
  if (config.secret && config.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`e2e login: secret must be at least ${MIN_SECRET_LENGTH} chars when set`)
  }

  const createError = config.createError ?? defaultCreateAuthError
  const allowedEmails = config.allowedEmails
    .map((email) => {
      return email.trim().toLowerCase()
    })
    .filter(Boolean)

  return {
    isEnabled: Boolean(config.secret),

    async login(input: E2eLoginInput, ctx?: TCtx): Promise<TokenPair> {
      if (!config.secret) throw createError({ message: 'Not found', code: 'NOT_FOUND', status: 404 })

      // A wrong secret never reveals whether the endpoint is enabled; 401 mirrors a bad magic token.
      if (!safeSecretEqual(input.providedSecret, config.secret)) {
        ctx?.logger?.warn('E2E login rejected: bad secret')
        throw createError({ message: 'Invalid or expired token', code: 'UNAUTHENTICATED', status: 401 })
      }

      const email = (input.email || '').trim().toLowerCase()

      if (!email || !allowedEmails.includes(email)) {
        ctx?.logger?.warn('E2E login rejected: email not on allowlist', { data: { email } })
        throw createError({ message: 'E2E login is not permitted for this email.', code: 'FORBIDDEN', status: 403 })
      }

      const account = await config.resolveAccount(email, ctx)
      // A test account always carries at least the base role, whatever the host's own fallback.
      const pair = await config.issueSession(
        { ...account, roles: account.roles?.length ? account.roles : ['user'] },
        input,
        ctx,
      )

      ctx?.logger?.info('E2E login issued session', { data: { userId: String(account.id) } })

      return pair
    },
  }
}
