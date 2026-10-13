import { AuthError } from './errors.js'
import type { HeaderBag } from './http.js'
import { readHeader } from './http.js'
import type { MagicLinkAuth, RequestMeta } from './magicLinkAuth.js'
import type { AuthContext, AuthUser } from './ports.js'

/** The slice of an API Gateway (REST, v1) proxy event the routes read. */
export interface LambdaEvent {
  headers?: HeaderBag
  queryStringParameters?: Record<string, string | undefined> | null
  body?: string | null
  requestContext?: { identity?: { sourceIp?: string | null } }
}

/** Structurally an `APIGatewayProxyResult`. */
export interface LambdaResult {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  body: string
}

export interface AuthRoute<TCtx> {
  handle: (event: LambdaEvent, ctx?: TCtx) => Promise<LambdaResult>
  /** Set on routes that must never surface an error: the error is the host's to log, the client gets this. */
  fallbackResponse?: () => LambdaResult
  /** A 401 from this route also clears both cookies, so a dead refresh cookie leaves the browser. */
  clearCookiesOn401?: boolean
}

export interface AuthRoutesOptions {
  corsHeaders: () => Record<string, string>
  /** The body every link request gets, whatever happened. */
  requestMagicLinkMessage?: string
}

export const extractSourceIp = (event: LambdaEvent): string => {
  const forwarded = readHeader(event.headers, 'x-forwarded-for')?.split(',')[0]

  return (forwarded || event.requestContext?.identity?.sourceIp || '').toString().trim()
}

export const extractUserAgent = (event: LambdaEvent): string => {
  return readHeader(event.headers, 'user-agent') || ''
}

const requestMeta = (event: LambdaEvent): RequestMeta => {
  return { ipAddress: extractSourceIp(event), userAgent: extractUserAgent(event) }
}

/**
 * The five auth endpoints as Lambda bodies: `POST magic-link`, `GET magic-link/verify?token=`,
 * `POST refresh`, `POST logout`, `GET me`. Each `handle` throws the engine's errors; wrap it with
 * the host's error envelope, honouring `fallbackResponse` / `clearCookiesOn401`, or use
 * {@link toLambdaHandler}.
 */
export const createAuthRoutes = <TUser extends AuthUser, TMe, TCtx extends AuthContext>(
  auth: MagicLinkAuth<TUser, TMe, TCtx>,
  options: AuthRoutesOptions,
) => {
  const { corsHeaders } = options
  const json = (statusCode: number, body: unknown): LambdaResult => {
    return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) }
  }
  const withCookies = (body: unknown, cookies: string[]): LambdaResult => {
    return { ...json(200, body), multiValueHeaders: { 'Set-Cookie': cookies } }
  }

  const genericOk = (): LambdaResult => {
    return json(200, {
      message: options.requestMagicLinkMessage ?? 'If that email exists, a sign-in link has been sent.',
    })
  }
  const noContent = (): LambdaResult => {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      multiValueHeaders: { 'Set-Cookie': auth.clearCookies() },
      body: '',
    }
  }

  const requestMagicLink: AuthRoute<TCtx> = {
    handle: async (event, ctx) => {
      let body: { email?: string; redirectUrl?: string } = {}

      if (event.body) {
        try {
          body = JSON.parse(event.body)
        } catch {
          return genericOk()
        }
      }

      await auth.requestMagicLink(
        {
          email: body.email || '',
          ...(body.redirectUrl ? { redirectUrl: body.redirectUrl } : {}),
          ...requestMeta(event),
        },
        ctx,
      )

      return genericOk()
    },
    // A silent surface answers the same body for every outcome, errors included: a 500 on one
    // address and a 200 on another would be the membership oracle `silent` exists to close.
    ...(auth.uninvitedRequest === 'silent' ? { fallbackResponse: genericOk } : {}),
  }

  // Answers JSON, not a 302: the SPA's verify page calls this with fetch, which would follow a
  // redirect silently. The cookies ride along on the same-origin response.
  const verifyMagicLink: AuthRoute<TCtx> = {
    handle: async (event, ctx) => {
      // eslint-disable-next-line dot-notation
      const rawToken = (event.queryStringParameters?.['token'] || '').toString().trim()
      const result = await auth.verifyMagicLink({ rawToken, ...requestMeta(event) }, ctx)

      return withCookies({ ok: true, redirect: result.redirectUrl }, [result.accessCookie, result.refreshCookie])
    },
  }

  const refresh: AuthRoute<TCtx> = {
    handle: async (event, ctx) => {
      const pair = await auth.refreshSession(auth.extractRefreshToken(event.headers) || '', ctx, {
        ipAddress: extractSourceIp(event),
      })

      return withCookies({ ok: true }, [pair.accessCookie, pair.refreshCookie])
    },
    clearCookiesOn401: true,
  }

  // Logout always ends the browser's session, whatever the server side managed to revoke.
  const logout: AuthRoute<TCtx> = {
    handle: async (event, ctx) => {
      await auth.logout(auth.extractRefreshToken(event.headers), ctx)

      return noContent()
    },
    fallbackResponse: noContent,
  }

  const me: AuthRoute<TCtx> = {
    handle: async (event, ctx) => {
      return json(200, await auth.getMe(auth.requireUser(event.headers), ctx))
    },
  }

  return { requestMagicLink, verifyMagicLink, refresh, logout, me }
}

export interface ToLambdaHandlerOptions<TCtx> {
  corsHeaders: () => Record<string, string>
  clearCookies: () => string[]
  context?: (event: LambdaEvent) => TCtx
  /** Maps any thrown error to a status + body; the default understands {@link AuthError}. */
  toErrorResponse?: (error: unknown) => { statusCode: number; body: unknown }
  onError?: (error: unknown) => void
}

const defaultErrorResponse = (error: unknown): { statusCode: number; body: unknown } => {
  if (error instanceof AuthError) {
    return { statusCode: error.status, body: { type: error.code, message: error.message } }
  }

  return { statusCode: 500, body: { type: 'INTERNAL_ERROR', message: 'Internal error' } }
}

/** A ready Lambda handler for hosts without their own controller envelope. */
export const toLambdaHandler = <TCtx>(route: AuthRoute<TCtx>, options: ToLambdaHandlerOptions<TCtx>) => {
  return async (event: LambdaEvent): Promise<LambdaResult> => {
    try {
      return await route.handle(event, options.context?.(event))
    } catch (error) {
      options.onError?.(error)

      if (route.fallbackResponse) return route.fallbackResponse()

      const { statusCode, body } = (options.toErrorResponse ?? defaultErrorResponse)(error)
      const result: LambdaResult = { statusCode, headers: options.corsHeaders(), body: JSON.stringify(body) }

      if (route.clearCookiesOn401 && statusCode === 401) {
        return { ...result, multiValueHeaders: { 'Set-Cookie': options.clearCookies() } }
      }

      return result
    }
  }
}
