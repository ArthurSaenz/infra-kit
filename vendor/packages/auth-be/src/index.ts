export { createE2eLogin, parseAllowedEmails, safeSecretEqual } from './e2eLogin.js'
export type { E2eLoginConfig, E2eLoginInput } from './e2eLogin.js'
export { buildMagicLinkUrl, formatExpiry, renderMagicLinkEmail } from './email.js'
export type { MagicLinkEmailText } from './email.js'
export { AuthError, defaultCreateAuthError } from './errors.js'
export type { AuthErrorCode, AuthErrorInit, CreateAuthError } from './errors.js'
export {
  buildAccessCookie,
  buildClearCookies,
  buildRefreshCookie,
  extractAccessToken,
  extractRefreshToken,
  parseCookieHeader,
  readHeader,
  resolveCookieOptions,
  sanitizeRedirectUrl,
} from './http.js'
export type { CookieOptions, HeaderBag, ResolvedCookieOptions } from './http.js'
export { createAuthRoutes, extractSourceIp, extractUserAgent, toLambdaHandler } from './lambda.js'
export type { AuthRoute, AuthRoutesOptions, LambdaEvent, LambdaResult, ToLambdaHandlerOptions } from './lambda.js'
export { createMagicLinkAuth, DEFAULT_INVITE_TOKEN_TTL_MIN, DEFAULT_MAGIC_TOKEN_TTL_MIN } from './magicLinkAuth.js'
export type {
  MagicLinkAuth,
  MagicLinkAuthConfig,
  RateLimitConfig,
  RequestMagicLinkInput,
  RequestMeta,
  RequestValidationInput,
  TokenPair,
  VerifyMagicLinkInput,
  VerifyMagicLinkResult,
} from './magicLinkAuth.js'
export type {
  AuthContext,
  AuthLogger,
  AuthUser,
  MagicLinkEmail,
  MagicTokenStore,
  Mailer,
  NewMagicToken,
  NewSession,
  RateLimiter,
  SessionStore,
  StoredMagicToken,
  StoredSession,
  UserStore,
} from './ports.js'
export { verifySession } from './session.js'
export type { VerifySessionOptions } from './session.js'
export {
  DEFAULT_ACCESS_TTL_SEC,
  DEFAULT_REFRESH_TTL_SEC,
  generateRawToken,
  hashToken,
  MIN_SECRET_LENGTH,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens.js'
export type { AccessTokenPayload, JwtIdentity, RefreshTokenPayload, SignedToken } from './tokens.js'
