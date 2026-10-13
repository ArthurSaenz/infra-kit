// `expectAuthError` asserts; the rule does not follow helpers.
/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/assertions-in-tests */
import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'

import { AuthError } from '../errors.js'
import { createMagicLinkAuth } from '../magicLinkAuth.js'
import { hashToken, signRefreshToken } from '../tokens.js'
import { ACCESS_SECRET, IDENTITY, REFRESH_SECRET, createFakes, invitedUser, tokenFromEmail } from './helpers/fakes.js'

const cookieValue = (cookie: string): string => {
  return cookie.split(';')[0]!.split('=')[1]!
}

const signIn = async (fakes: ReturnType<typeof createFakes>, email = 'ada@example.com') => {
  const auth = createMagicLinkAuth(fakes.config)

  await auth.requestMagicLink({ email, redirectUrl: '/trips' })

  return { auth, result: await auth.verifyMagicLink({ rawToken: tokenFromEmail(fakes.sent.at(-1)!) }) }
}

const expectAuthError = async (promise: Promise<unknown>, code: string, status: number) => {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    return error instanceof AuthError && error.code === code && error.status === status
  })
}

describe('createMagicLinkAuth config guards', () => {
  it.each([
    ['short access secret', { accessSecret: 'short' }],
    ['short refresh secret', { refreshSecret: 'short' }],
    ['identical secrets', { refreshSecret: ACCESS_SECRET }],
  ])('refuses %s', (_label, jwtOverride) => {
    const { config } = createFakes()

    expect(() => {
      return createMagicLinkAuth({ ...config, jwt: { ...config.jwt, ...jwtOverride } })
    }).toThrow()
  })

  it('refuses a missing magic-link base URL', () => {
    const { config } = createFakes()

    expect(() => {
      return createMagicLinkAuth({ ...config, magicLink: { baseUrl: '' } })
    }).toThrow(/baseUrl/)
  })
})

describe('requestMagicLink', () => {
  it('emails an invited user a single-use link carrying the sanitised redirect', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth(fakes.config)

    await auth.requestMagicLink({ email: '  ADA@example.com ', redirectUrl: '/trips?x=1', ipAddress: '1.1.1.1' })

    expect(fakes.sent).toHaveLength(1)
    expect(fakes.sent[0]!.to).toBe('ada@example.com')
    expect(fakes.sent[0]!.text).toContain('https://app.test/auth/verify?token=')
    expect(fakes.sent[0]!.text).toContain('&redirect=%2Ftrips%3Fx%3D1')
    expect(fakes.sent[0]!.text).toContain('This link expires in 15 minutes.')
    expect(fakes.tokens[0]).toMatchObject({ email: 'ada@example.com', redirectUrl: '/trips?x=1', ipAddress: '1.1.1.1' })
    expect(fakes.tokens[0]!.tokenHash).toBe(hashToken(tokenFromEmail(fakes.sent[0]!)))
  })

  it.each([
    ['unknown', []],
    ['uninvited', [invitedUser({ invited: false })]],
  ])('answers silently for an %s address and creates nothing', async (_label, seed) => {
    const fakes = createFakes(seed)

    await createMagicLinkAuth(fakes.config).requestMagicLink({ email: 'ada@example.com' })

    expect(fakes.tokens).toHaveLength(0)
    expect(fakes.sent).toHaveLength(0)
  })

  it('throws NOT_INVITED for an uninvited address when the host chose `reject`', async () => {
    const fakes = createFakes([invitedUser({ invited: false })])
    const auth = createMagicLinkAuth({ ...fakes.config, uninvitedRequest: 'reject', notInvitedMessage: 'No.' })

    await expectAuthError(auth.requestMagicLink({ email: 'ada@example.com' }), 'NOT_INVITED', 403)
    expect(fakes.sent).toHaveLength(0)
  })

  it('swallows a validation failure', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth(fakes.config)

    await auth.requestMagicLink({ email: 'not-an-email' })
    await auth.requestMagicLink({ email: 'ada@example.com', redirectUrl: '/a\\b' })

    expect(fakes.userStore.findByEmail).not.toHaveBeenCalled()
  })

  it('uses a host validator in place of the built-in one', async () => {
    const fakes = createFakes([invitedUser()])
    const requestMagicLink = vi.fn(() => {
      throw new Error('nope')
    })

    await createMagicLinkAuth({ ...fakes.config, validate: { requestMagicLink } }).requestMagicLink({
      email: 'ada@example.com',
    })

    expect(requestMagicLink).toHaveBeenCalledWith({ email: 'ada@example.com', redirectUrl: undefined }, undefined)
    expect(fakes.sent).toHaveLength(0)
  })

  it('stops quietly past the per-email and per-IP budgets, under the configured key prefix', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth({ ...fakes.config, rateLimits: { perEmail: 2, keyPrefix: 'bo' } })

    for (let i = 0; i < 3; i++) await auth.requestMagicLink({ email: 'ada@example.com', ipAddress: '9.9.9.9' })

    expect(fakes.sent).toHaveLength(2)
    expect(fakes.rateLimiter.incrementAndCheck).toHaveBeenCalledWith('bo:email:ada@example.com', 2, 3600, undefined)
    expect(fakes.rateLimiter.incrementAndCheck).toHaveBeenCalledWith('bo:ip:9.9.9.9', 20, 3600, undefined)
  })

  it('invalidates the previous outstanding link', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth(fakes.config)

    await auth.requestMagicLink({ email: 'ada@example.com' })
    await auth.requestMagicLink({ email: 'ada@example.com' })

    await expectAuthError(
      auth.verifyMagicLink({ rawToken: tokenFromEmail(fakes.sent[0]!) }),
      'INVALID_OR_EXPIRED_TOKEN',
      401,
    )
  })

  it('invalidates the token when the email could not be sent', async () => {
    const fakes = createFakes([invitedUser()])
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    fakes.mailer.send.mockRejectedValueOnce(new Error('provider down'))

    await createMagicLinkAuth(fakes.config).requestMagicLink({ email: 'ada@example.com' }, { logger })

    expect(fakes.tokens[0]!.spent).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })

  it('logs, not throws, when the cleanup after a failed send fails too', async () => {
    const fakes = createFakes([invitedUser()])
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    fakes.mailer.send.mockRejectedValueOnce(new Error('provider down'))
    fakes.magicTokens.invalidateByEmail.mockResolvedValueOnce().mockRejectedValueOnce(new Error('db down'))

    await createMagicLinkAuth(fakes.config).requestMagicLink({ email: 'ada@example.com' }, { logger })

    expect(logger.error).toHaveBeenCalledTimes(2)
  })
})

describe('sendInviteLink', () => {
  it('emails without the allowlist or rate limit, with the invite TTL', async () => {
    const fakes = createFakes()

    await createMagicLinkAuth(fakes.config).sendInviteLink(' New@Example.com ')

    expect(fakes.sent[0]!.to).toBe('new@example.com')
    expect(fakes.sent[0]!.text).toContain('This link expires in 3 days.')
    expect(fakes.rateLimiter.incrementAndCheck).not.toHaveBeenCalled()
    expect((fakes.tokens[0]!.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000)
  })
})

describe('verifyMagicLink', () => {
  it('mints a session pinned to the configured identity and returns the stored redirect', async () => {
    const fakes = createFakes([invitedUser()])
    const onSignIn = vi.fn(async () => {})

    fakes.config.onSignIn = onSignIn

    const { result } = await signIn(fakes)
    const access = jwt.verify(result.accessToken, ACCESS_SECRET, IDENTITY) as jwt.JwtPayload

    expect(access).toMatchObject({ sub: 'u1', roles: ['user'], authMethod: 'magic' })
    expect(result.redirectUrl).toBe('/trips')
    expect(result.accessCookie).toMatch(/^access_token=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=900$/)
    expect(result.refreshCookie).toMatch(/; Path=\/api\/v1\/auth; Max-Age=604800$/)
    expect(fakes.sessions[0]).toMatchObject({ userId: 'u1', tokenHash: hashToken(result.refreshToken) })
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), undefined)
  })

  it('takes the roles claim from rolesOf', async () => {
    const fakes = createFakes([invitedUser({ roles: [] })])

    fakes.config.rolesOf = (user) => {
      return user.roles.length ? user.roles : ['user']
    }

    const { result } = await signIn(fakes)

    expect((jwt.decode(result.accessToken) as { roles: string[] }).roles).toEqual(['user'])
  })

  it('spends the token once', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth(fakes.config)

    await auth.requestMagicLink({ email: 'ada@example.com' })

    const rawToken = tokenFromEmail(fakes.sent[0]!)

    await auth.verifyMagicLink({ rawToken })
    await expectAuthError(auth.verifyMagicLink({ rawToken }), 'INVALID_OR_EXPIRED_TOKEN', 401)
  })

  it.each([
    ['past', new Date(Date.now() - 1000)],
    ['unparseable', 'not a date'],
  ])('refuses a token whose expiry is %s', async (_label, expiresAt) => {
    const fakes = createFakes([invitedUser()])

    fakes.magicTokens.consumeByHash.mockResolvedValueOnce({ email: 'ada@example.com', expiresAt })

    await expectAuthError(
      createMagicLinkAuth(fakes.config).verifyMagicLink({ rawToken: 'ab'.repeat(32) }),
      'INVALID_OR_EXPIRED_TOKEN',
      401,
    )
  })

  it("refuses a token older than this host's longest TTL, whatever its own expiry says", async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth({ ...fakes.config, magicLink: { baseUrl: 'https://app.test', inviteTtlMin: 15 } })

    fakes.magicTokens.consumeByHash.mockResolvedValueOnce({
      email: 'ada@example.com',
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      expiresAt: new Date(Date.now() + 70 * 3600 * 1000),
    })

    await expectAuthError(auth.verifyMagicLink({ rawToken: 'ab'.repeat(32) }), 'INVALID_OR_EXPIRED_TOKEN', 401)
  })

  it('keeps a default rate limit when an override is undefined', async () => {
    const fakes = createFakes([invitedUser()])

    await createMagicLinkAuth({
      ...fakes.config,
      rateLimits: { perEmail: undefined as unknown as number },
    }).requestMagicLink({
      email: 'ada@example.com',
    })

    expect(fakes.rateLimiter.incrementAndCheck).toHaveBeenCalledWith('magic:email:ada@example.com', 5, 3600, undefined)
  })

  it('re-checks the allowlist: an invite revoked after the request is refused', async () => {
    const fakes = createFakes([invitedUser()])
    const auth = createMagicLinkAuth(fakes.config)

    await auth.requestMagicLink({ email: 'ada@example.com' })
    fakes.users.get('u1')!.invited = false

    await expectAuthError(auth.verifyMagicLink({ rawToken: tokenFromEmail(fakes.sent[0]!) }), 'NOT_INVITED', 403)
    expect(fakes.sessions).toHaveLength(0)
  })

  it('refuses a non-hex token before touching the store', async () => {
    const fakes = createFakes([invitedUser()])

    await expectAuthError(createMagicLinkAuth(fakes.config).verifyMagicLink({ rawToken: 'zz' }), 'INVALID_REQUEST', 400)
    expect(fakes.magicTokens.consumeByHash).not.toHaveBeenCalled()
  })

  it('rate-limits verification per IP', async () => {
    const fakes = createFakes([invitedUser()])

    fakes.rateLimiter.limitOverride = 0

    await expectAuthError(
      createMagicLinkAuth(fakes.config).verifyMagicLink({ rawToken: 'ab'.repeat(32), ipAddress: '1.1.1.1' }),
      'RATE_LIMITED',
      429,
    )
  })

  it('maps errors through the host factory', async () => {
    const fakes = createFakes([invitedUser()])
    const createError = vi.fn((init: { code: string }) => {
      return new Error(`host:${init.code}`)
    })

    await expect(
      createMagicLinkAuth({ ...fakes.config, createError }).verifyMagicLink({ rawToken: 'ab'.repeat(32) }),
    ).rejects.toThrow('host:INVALID_OR_EXPIRED_TOKEN')
  })
})

describe('refreshSession', () => {
  it('rotates: a new pair, the old refresh token dead', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    const next = await auth.refreshSession(result.refreshToken, undefined, { ipAddress: '1.1.1.1' })

    expect(next.refreshToken).not.toBe(result.refreshToken)
    expect(cookieValue(next.refreshCookie)).toBe(next.refreshToken)
    expect(fakes.sessions).toHaveLength(2)
  })

  it('treats a replayed refresh token as theft and revokes every session of the user', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)
    const next = await auth.refreshSession(result.refreshToken)

    await expectAuthError(auth.refreshSession(result.refreshToken), 'INVALID_REFRESH_TOKEN', 401)
    await expectAuthError(auth.refreshSession(next.refreshToken), 'INVALID_REFRESH_TOKEN', 401)
    expect(fakes.sessionStore.revokeAllForUser).toHaveBeenCalledWith('u1', undefined)
  })

  it('fails only the loser of a concurrent rotation', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    fakes.sessionStore.rotate.mockResolvedValueOnce(null)

    await expectAuthError(auth.refreshSession(result.refreshToken), 'INVALID_REFRESH_TOKEN', 401)
    expect(fakes.sessionStore.revokeAllForUser).not.toHaveBeenCalled()
  })

  it('ends every session of a user whose invite was revoked', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    fakes.users.get('u1')!.invited = false

    await expectAuthError(auth.refreshSession(result.refreshToken), 'NOT_INVITED', 403)
    expect(fakes.sessions[0]!.revokedAt).toBeTruthy()
  })

  it.each([
    ['empty', '', 'UNAUTHENTICATED'],
    ['garbage', 'not-a-jwt', 'INVALID_REFRESH_TOKEN'],
    [
      'unknown session',
      signRefreshToken({ sub: 'u1', jti: 'x' }, REFRESH_SECRET, IDENTITY).token,
      'INVALID_REFRESH_TOKEN',
    ],
  ])('refuses an %s refresh token', async (_label, token, code) => {
    const fakes = createFakes([invitedUser()])

    await expectAuthError(createMagicLinkAuth(fakes.config).refreshSession(token), code, 401)
  })

  it('refuses an expired session row and a deleted user', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    fakes.sessions[0]!.expiresAt = new Date(Date.now() - 1000)
    await expectAuthError(auth.refreshSession(result.refreshToken), 'INVALID_REFRESH_TOKEN', 401)

    fakes.sessions[0]!.expiresAt = new Date(Date.now() + 60_000)
    fakes.users.delete('u1')
    await expectAuthError(auth.refreshSession(result.refreshToken), 'USER_NOT_FOUND', 401)
  })

  it('rate-limits refresh per IP', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    fakes.rateLimiter.limitOverride = 0

    await expectAuthError(
      auth.refreshSession(result.refreshToken, undefined, { ipAddress: '1.1.1.1' }),
      'RATE_LIMITED',
      429,
    )
  })
})

describe('session reads', () => {
  it('requireUser reads the cookie first, then a bearer header', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    expect(auth.requireUser({ Cookie: `x=1; access_token=${result.accessToken}` }).sub).toBe('u1')
    expect(auth.requireUser({ authorization: `Bearer ${result.accessToken}` }).sub).toBe('u1')
    expect(() => {
      return auth.requireUser({})
    }).toThrow(AuthError)
    expect(() => {
      return auth.requireUser({ cookie: 'access_token=forged' })
    }).toThrow('Invalid access token')
  })

  it('authenticate and getMe load the current row', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)
    const headers = { cookie: `access_token=${result.accessToken}` }

    expect((await auth.authenticate(headers)).user.name).toBe('Ada')
    expect(await auth.getMe(auth.requireUser(headers))).toEqual({ id: 'u1', email: 'ada@example.com' })

    fakes.users.delete('u1')
    await expectAuthError(auth.authenticate(headers), 'USER_NOT_FOUND', 401)
  })

  it('logout revokes the session and never throws', async () => {
    const fakes = createFakes([invitedUser()])
    const { auth, result } = await signIn(fakes)

    await auth.logout(result.refreshToken)
    expect(fakes.sessions[0]!.revokedAt).toBeTruthy()

    fakes.sessionStore.revokeByTokenHash.mockRejectedValueOnce(new Error('db down'))
    await expect(auth.logout(result.refreshToken)).resolves.toBeUndefined()
    await expect(auth.logout(null)).resolves.toBeUndefined()
  })

  it('honours custom cookie names and paths', async () => {
    const fakes = createFakes([invitedUser()])

    fakes.config.cookies = { accessName: 'sid', refreshName: 'rid', refreshPath: '/auth' }

    const { auth, result } = await signIn(fakes)

    expect(result.refreshCookie).toMatch(/^rid=.+; Path=\/auth;/)
    expect(auth.extractRefreshToken({ cookie: `rid=${result.refreshToken}` })).toBe(result.refreshToken)
    expect(auth.extractAccessToken({ cookie: `sid=${result.accessToken}` })).toBe(result.accessToken)
    expect(auth.clearCookies()).toEqual([
      'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      'rid=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0',
    ])
  })
})
