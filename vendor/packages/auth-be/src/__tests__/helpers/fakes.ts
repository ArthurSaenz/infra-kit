import { vi } from 'vitest'

import type { MagicLinkAuthConfig } from '../../magicLinkAuth.js'
import type {
  AuthUser,
  MagicLinkEmail,
  NewMagicToken,
  NewSession,
  StoredMagicToken,
  StoredSession,
} from '../../ports.js'

export interface TestUser extends AuthUser {
  id: string
  email: string
  invited: boolean
  roles: string[]
  name: string
}

export const ACCESS_SECRET = 'a'.repeat(32)
export const REFRESH_SECRET = 'r'.repeat(32)
export const IDENTITY = { issuer: 'test-api', audience: 'test-app' }

/** In-memory stores with the contracts the engine relies on (single-use tokens, atomic rotate). */
export const createFakes = (seed: TestUser[] = []) => {
  const users = new Map(
    seed.map((user) => {
      return [user.id, user]
    }),
  )
  const tokens: (NewMagicToken & { spent: boolean })[] = []
  const sessions: (NewSession & StoredSession & { id: string })[] = []
  const sent: MagicLinkEmail[] = []
  const counters = new Map<string, number>()
  let nextSessionId = 1

  const userStore = {
    findByEmail: vi.fn(async (email: string) => {
      return [...users.values()].find((user) => {
        return user.email === email
      })
    }),
    findById: vi.fn(async (id: string) => {
      return users.get(id)
    }),
  }

  const magicTokens = {
    create: vi.fn(async (data: NewMagicToken) => {
      tokens.push({ ...data, spent: false })
    }),
    consumeByHash: vi.fn(async (tokenHash: string): Promise<StoredMagicToken | null> => {
      const row = tokens.find((token) => {
        return token.tokenHash === tokenHash && !token.spent
      })

      if (!row) return null

      row.spent = true

      return { email: row.email, redirectUrl: row.redirectUrl ?? null, expiresAt: row.expiresAt ?? new Date(0) }
    }),
    invalidateByEmail: vi.fn(async (email: string) => {
      for (const token of tokens) if (token.email === email) token.spent = true
    }),
  }

  const sessionStore = {
    create: vi.fn(async (data: NewSession) => {
      const row = { ...data, id: String(nextSessionId++), revokedAt: null }

      sessions.push(row)

      return row
    }),
    findByTokenHash: vi.fn(async (tokenHash: string) => {
      return (
        sessions.find((session) => {
          return session.tokenHash === tokenHash
        }) ?? null
      )
    }),
    rotate: vi.fn(async (oldId: string, next: NewSession): Promise<unknown> => {
      const old = sessions.find((session) => {
        return session.id === oldId
      })

      if (!old || old.revokedAt) return null

      old.revokedAt = new Date()

      return sessionStore.create(next)
    }),
    revokeByTokenHash: vi.fn(async (tokenHash: string) => {
      for (const session of sessions) if (session.tokenHash === tokenHash) session.revokedAt = new Date()
    }),
    revokeAllForUser: vi.fn(async (userId: string) => {
      for (const session of sessions) if (session.userId === userId) session.revokedAt = new Date()
    }),
  }

  const rateLimiter = {
    limitOverride: undefined as number | undefined,
    incrementAndCheck: vi.fn(async (key: string, limit: number) => {
      const count = (counters.get(key) ?? 0) + 1

      counters.set(key, count)

      return { allowed: count <= (rateLimiter.limitOverride ?? limit) }
    }),
  }

  const mailer = {
    send: vi.fn(async (email: MagicLinkEmail) => {
      sent.push(email)
    }),
  }

  const config: MagicLinkAuthConfig<TestUser, { id: string; email: string }, object> = {
    users: userStore,
    magicTokens,
    sessions: sessionStore,
    rateLimiter,
    mailer,
    jwt: { accessSecret: ACCESS_SECRET, refreshSecret: REFRESH_SECRET, ...IDENTITY },
    magicLink: { baseUrl: 'https://app.test' },
    email: { subject: 'Sign in', intro: 'Use the link below:', linkLabel: 'Sign in' },
    toMe: (user) => {
      return { id: user.id, email: user.email }
    },
  }

  return { config, users, tokens, sessions, sent, userStore, magicTokens, sessionStore, rateLimiter, mailer }
}

export const tokenFromEmail = (email: MagicLinkEmail): string => {
  const match = /token=([a-f0-9]+)/.exec(email.text)

  if (!match?.[1]) throw new Error('no token in email')

  return match[1]
}

export const invitedUser = (overrides: Partial<TestUser> = {}): TestUser => {
  return { id: 'u1', email: 'ada@example.com', invited: true, roles: ['user'], name: 'Ada', ...overrides }
}
