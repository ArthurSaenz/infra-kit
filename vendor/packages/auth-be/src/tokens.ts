import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'

import type { CreateAuthError } from './errors.js'
import { defaultCreateAuthError } from './errors.js'

const JWT_ALGORITHM = 'HS256'

export const MIN_SECRET_LENGTH = 32
export const DEFAULT_ACCESS_TTL_SEC = 15 * 60
export const DEFAULT_REFRESH_TTL_SEC = 7 * 24 * 60 * 60

export interface AccessTokenPayload {
  sub: string
  roles: string[]
  authMethod: 'magic' | 'google'
}

export interface RefreshTokenPayload {
  sub: string
  jti: string
}

/** Issuer + audience pin a token to the API that minted it, so one app's token never opens another. */
export interface JwtIdentity {
  issuer: string
  audience: string
}

export interface SignedToken {
  token: string
  expSec: number
}

export const generateRawToken = (): string => {
  return crypto.randomBytes(32).toString('hex')
}

export const hashToken = (raw: string): string => {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

const sign = (payload: object, secret: string, identity: JwtIdentity, ttlSec: number): SignedToken => {
  const token = jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ttlSec,
    issuer: identity.issuer,
    audience: identity.audience,
  })

  return { token, expSec: ttlSec }
}

export const signAccessToken = (
  payload: AccessTokenPayload,
  secret: string,
  identity: JwtIdentity,
  ttlSec: number = DEFAULT_ACCESS_TTL_SEC,
): SignedToken => {
  return sign(payload, secret, identity, ttlSec)
}

export const signRefreshToken = (
  payload: RefreshTokenPayload,
  secret: string,
  identity: JwtIdentity,
  ttlSec: number = DEFAULT_REFRESH_TTL_SEC,
): SignedToken => {
  return sign(payload, secret, identity, ttlSec)
}

const verify = <T extends { sub: string }>(token: string, secret: string, identity: JwtIdentity): T => {
  const decoded = jwt.verify(token, secret, {
    algorithms: [JWT_ALGORITHM],
    issuer: identity.issuer,
    audience: identity.audience,
  })

  if (typeof decoded !== 'object' || decoded === null || typeof decoded.sub !== 'string' || !decoded.sub) {
    throw new Error('Token has no subject')
  }

  return decoded as unknown as T
}

export const verifyAccessToken = (
  token: string,
  secret: string,
  identity: JwtIdentity,
  createError: CreateAuthError = defaultCreateAuthError,
): AccessTokenPayload => {
  try {
    const decoded = verify<AccessTokenPayload>(token, secret, identity)

    return { sub: decoded.sub, roles: decoded.roles, authMethod: decoded.authMethod }
  } catch (error) {
    throw createError({ message: 'Invalid access token', code: 'INVALID_ACCESS_TOKEN', status: 401, cause: error })
  }
}

export const verifyRefreshToken = (
  token: string,
  secret: string,
  identity: JwtIdentity,
  createError: CreateAuthError = defaultCreateAuthError,
): RefreshTokenPayload => {
  try {
    const decoded = verify<RefreshTokenPayload>(token, secret, identity)

    return { sub: decoded.sub, jti: decoded.jti }
  } catch (error) {
    throw createError({ message: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN', status: 401, cause: error })
  }
}

export const assertSecret = (name: string, secret: string | undefined): void => {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`auth: ${name} must be at least ${MIN_SECRET_LENGTH} chars`)
  }
}
