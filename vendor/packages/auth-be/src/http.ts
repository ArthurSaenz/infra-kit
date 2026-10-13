export type HeaderBag = Record<string, string | undefined> | null | undefined

export interface CookieOptions {
  accessName?: string
  refreshName?: string
  accessPath?: string
  /**
   * Must cover the refresh and logout routes or the browser never sends the refresh cookie there.
   * Behind an `/api/v1` mount a bare `/auth` would not match `/api/v1/auth/refresh`, so refresh
   * would fail silently.
   */
  refreshPath?: string
}

export type ResolvedCookieOptions = Required<CookieOptions>

const BEARER_PREFIX = 'Bearer '

export const resolveCookieOptions = (options: CookieOptions = {}): ResolvedCookieOptions => {
  return {
    accessName: options.accessName ?? 'access_token',
    refreshName: options.refreshName ?? 'refresh_token',
    accessPath: options.accessPath ?? '/',
    refreshPath: options.refreshPath ?? '/api/v1/auth',
  }
}

const buildCookie = (name: string, value: string, path: string, maxAgeSec: number): string => {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSec}`
}

export const buildAccessCookie = (cookies: ResolvedCookieOptions, token: string, expSec: number): string => {
  return buildCookie(cookies.accessName, token, cookies.accessPath, expSec)
}

export const buildRefreshCookie = (cookies: ResolvedCookieOptions, token: string, expSec: number): string => {
  return buildCookie(cookies.refreshName, token, cookies.refreshPath, expSec)
}

export const buildClearCookies = (cookies: ResolvedCookieOptions): string[] => {
  return [
    buildCookie(cookies.accessName, '', cookies.accessPath, 0),
    buildCookie(cookies.refreshName, '', cookies.refreshPath, 0),
  ]
}

export const readHeader = (headers: HeaderBag, name: string): string | undefined => {
  if (!headers) return undefined

  const wanted = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value ?? undefined
  }

  return undefined
}

export const parseCookieHeader = (header: string | undefined): Record<string, string> => {
  const result: Record<string, string> = {}

  if (!header) return result

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')

    if (eq === -1) continue

    const name = part.slice(0, eq).trim()

    if (!name) continue

    // Our tokens never contain `%`; a malformed escape from a hand-built cookie is no cookie, not a 500.
    try {
      result[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      continue
    }
  }

  return result
}

/** Cookie first (the browser path); a bearer header serves server-side callers and tests. */
export const extractAccessToken = (headers: HeaderBag, cookieName = 'access_token'): string | null => {
  const fromCookie = parseCookieHeader(readHeader(headers, 'cookie'))[cookieName]

  if (fromCookie) return fromCookie

  const authorization = readHeader(headers, 'authorization')

  if (authorization?.startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim() || null
  }

  return null
}

export const extractRefreshToken = (headers: HeaderBag, cookieName = 'refresh_token'): string | null => {
  return parseCookieHeader(readHeader(headers, 'cookie'))[cookieName] || null
}

const hasControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)

    if (code < 0x20 || code === 0x7f) return true
  }

  return false
}

/**
 * Only an in-app path survives; anything that could leave the origin becomes `/`. Backslashes are
 * refused because browsers read `/\evil.com` as the protocol-relative `//evil.com`.
 */
export const sanitizeRedirectUrl = (input: string | undefined | null): string => {
  if (!input || input.length > 2048 || hasControlChars(input) || input.includes('\\')) return '/'

  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('//')) return '/'

  if (input.includes(':')) return '/'

  return input.startsWith('/') ? input : `/${input}`
}
