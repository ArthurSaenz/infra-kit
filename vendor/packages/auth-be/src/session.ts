import type { HeaderBag } from './http.js'
import { extractAccessToken } from './http.js'
import type { AccessTokenPayload, JwtIdentity } from './tokens.js'
import { MIN_SECRET_LENGTH, verifyAccessToken } from './tokens.js'

export interface VerifySessionOptions extends JwtIdentity {
  /** The minting API's access secret. A missing or short one means nobody is signed in. */
  accessSecret: string | undefined
  accessCookieName?: string
}

/**
 * For a service that did not mint the session but must honour it (another Lambda behind the same
 * origin): the access-token payload, or `null` for anything less than a valid token. Fails closed.
 */
export const verifySession = (headers: HeaderBag, options: VerifySessionOptions): AccessTokenPayload | null => {
  const { accessSecret } = options

  if (!accessSecret || accessSecret.length < MIN_SECRET_LENGTH) return null

  const token = extractAccessToken(headers, options.accessCookieName)

  if (!token) return null

  try {
    return verifyAccessToken(token, accessSecret, options)
  } catch {
    return null
  }
}
