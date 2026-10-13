import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'

import { createE2eLogin, parseAllowedEmails, safeSecretEqual } from '../e2eLogin.js'
import { AuthError } from '../errors.js'
import { createMagicLinkAuth } from '../magicLinkAuth.js'
import { createFakes, invitedUser } from './helpers/fakes.js'

const SECRET = 's'.repeat(32)

const setup = (secret = SECRET, user = invitedUser({ roles: [] })) => {
  const fakes = createFakes([user])
  const auth = createMagicLinkAuth(fakes.config)
  const resolveAccount = vi.fn(async () => {
    return user
  })

  return {
    fakes,
    resolveAccount,
    e2e: createE2eLogin({
      issueSession: auth.issueSession,
      secret,
      allowedEmails: [' Ada@Example.com '],
      resolveAccount,
    }),
  }
}

const expectAuthError = async (promise: Promise<unknown>, code: string, status: number) => {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    return error instanceof AuthError && error.code === code && error.status === status
  })
}

describe('createE2eLogin', () => {
  it('mints a real session for an allowlisted email with the right secret', async () => {
    const { e2e, fakes, resolveAccount } = setup()
    const pair = await e2e.login({ email: 'ADA@example.com', providedSecret: SECRET })

    expect(resolveAccount).toHaveBeenCalledWith('ada@example.com', undefined)
    expect((jwt.decode(pair.accessToken) as { roles: string[] }).roles).toEqual(['user'])
    expect(fakes.sessions).toHaveLength(1)
  })

  it('answers 404 when disabled, 401 on a wrong secret, 403 off the allowlist', async () => {
    const disabled = setup('')

    expect(disabled.e2e.isEnabled).toBe(false)
    await expectAuthError(disabled.e2e.login({ email: 'ada@example.com', providedSecret: SECRET }), 'NOT_FOUND', 404)

    const { e2e, resolveAccount } = setup()

    await expectAuthError(
      e2e.login({ email: 'ada@example.com', providedSecret: 'x'.repeat(32) }),
      'UNAUTHENTICATED',
      401,
    )
    await expectAuthError(e2e.login({ email: 'eve@example.com', providedSecret: SECRET }), 'FORBIDDEN', 403)
    expect(resolveAccount).not.toHaveBeenCalled()
  })

  it('refuses a short secret at construction', () => {
    expect(() => {
      return setup('short')
    }).toThrow(/at least 32/)
  })
})

describe('helpers', () => {
  it('safeSecretEqual compares in constant time and refuses missing or uneven values', () => {
    expect(safeSecretEqual('abc', 'abc')).toBe(true)
    expect(safeSecretEqual('abc', 'abd')).toBe(false)
    expect(safeSecretEqual('abc', 'abcd')).toBe(false)
    expect(safeSecretEqual(null, 'abc')).toBe(false)
  })

  it('parseAllowedEmails splits on commas and whitespace, lower-cased', () => {
    expect(parseAllowedEmails(' A@x.com, b@x.com\nC@x.com ')).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    expect(parseAllowedEmails(undefined)).toEqual([])
  })
})
