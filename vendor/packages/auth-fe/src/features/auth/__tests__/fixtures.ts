import type { AuthPaths } from '../types.js'

export const PATHS: AuthPaths = {
  requestMagicLink: '/api/v1/auth/magic-link',
  verifyMagicLink: '/api/v1/auth/magic-link/verify',
  me: '/api/v1/auth/me',
  refresh: '/api/v1/auth/refresh',
  logout: '/api/v1/auth/logout',
}

export interface TestUser {
  id: string
  email: string
}

export const USER: TestUser = { id: '1', email: 'a@b.com' }

const jsonHeaders = { 'content-type': 'application/json' }

export const okResponse = (body: unknown) => {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders })
}

export const errorResponse = (status: number, body: unknown) => {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

export const callsTo = (fetchMock: { mock: { calls: unknown[][] } }, path: string) => {
  return fetchMock.mock.calls.filter((call) => {
    return String(call[0]).includes(path)
  })
}
