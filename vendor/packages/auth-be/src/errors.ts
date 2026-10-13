// The codes are the strings a host's error envelope already speaks (e.g. an `EManagedError` enum),
// so a host maps an AuthError onto its own error class 1:1 and the browser sees the same `type`.
export type AuthErrorCode =
  | 'INVALID_ACCESS_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'INVALID_OR_EXPIRED_TOKEN'
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'USER_NOT_FOUND'
  | 'NOT_INVITED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'

export interface AuthErrorInit {
  message: string
  code: AuthErrorCode
  status: number
  cause?: unknown
}

export class AuthError extends Error {
  public readonly code: AuthErrorCode
  public readonly status: number

  constructor(init: AuthErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AuthError'
    this.code = init.code
    this.status = init.status
  }
}

export type CreateAuthError = (init: AuthErrorInit) => Error

export const defaultCreateAuthError: CreateAuthError = (init) => {
  return new AuthError(init)
}
