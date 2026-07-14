import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTokenStorePath, readTokenStore } from 'src/lib/env-tokens'
import type { EnvAuthError } from 'src/lib/errors/env-auth-error'
import { isEnvAuthFailure } from 'src/lib/errors/env-auth-error'

import { INFRA_KIT_ENV_TOKEN_VAR, resolveEnvToken } from '../token-resolver'

vi.mock('src/lib/env-tokens', () => {
  return { getTokenStorePath: vi.fn(), readTokenStore: vi.fn() }
})

const STORE_PATH = '/home/dev/.infra-kit/projects/api/tokens.json'
const ENV_TOKEN = 'dp.st.from-env.AAAA'
const STORE_TOKEN = 'dp.st.from-store.BBBB'

const ORIGINAL_ENV = { ...process.env }

const mockStore = (envs: Record<string, string>): void => {
  vi.mocked(readTokenStore).mockResolvedValue({ version: 1, envs })
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env[INFRA_KIT_ENV_TOKEN_VAR]
  vi.mocked(getTokenStorePath).mockResolvedValue(STORE_PATH)
  vi.mocked(readTokenStore).mockResolvedValue(null)
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('resolveEnvToken — precedence', () => {
  it('prefers INFRA_KIT_ENV_TOKEN over the store, and never reads the store', async () => {
    process.env[INFRA_KIT_ENV_TOKEN_VAR] = ENV_TOKEN
    mockStore({ dev: STORE_TOKEN })

    expect(await resolveEnvToken('dev')).toEqual({ token: ENV_TOKEN, source: 'env' })

    // The CI path must not need (or touch) a home config at all — a corrupt store there
    // would otherwise throw on a machine that supplied a perfectly good token.
    expect(readTokenStore).not.toHaveBeenCalled()
  })

  it('falls back to the store when the env var is unset', async () => {
    mockStore({ dev: STORE_TOKEN, prod: 'dp.st.prod.CCCC' })

    expect(await resolveEnvToken('dev')).toEqual({ token: STORE_TOKEN, source: 'store' })
  })

  it('treats an EMPTY env var as a miss, not as an empty token', async () => {
    process.env[INFRA_KIT_ENV_TOKEN_VAR] = ''
    mockStore({ dev: STORE_TOKEN })

    expect(await resolveEnvToken('dev')).toEqual({ token: STORE_TOKEN, source: 'store' })
  })
})

describe('resolveEnvToken — the no-token refusal', () => {
  it('throws when there is neither an env var nor a store', async () => {
    await expect(resolveEnvToken('dev')).rejects.toThrow(/No Doppler service token for env "dev"/)
  })

  it('throws when the store exists but has no token for THIS env', async () => {
    mockStore({ prod: 'dp.st.prod.CCCC' })

    await expect(resolveEnvToken('dev')).rejects.toThrow(/No Doppler service token for env "dev"/)
  })

  it('is actionable: names the fix command, the store path, and the CI variable', async () => {
    // `toThrow(string)` is a SUBSTRING match, so each line of the message is asserted on its own.
    await expect(resolveEnvToken('dev')).rejects.toThrow('`infra-kit env-token-set dev`')
    await expect(resolveEnvToken('dev')).rejects.toThrow('tokens.json')
    await expect(resolveEnvToken('dev')).rejects.toThrow('0600')
    await expect(resolveEnvToken('dev')).rejects.toThrow(INFRA_KIT_ENV_TOKEN_VAR)
  })

  // The CLASS, not just the message. A plain Error here is classified TRANSIENT by env auto-load, so
  // it expires with the 30s backoff and the shell-startup user — whose stderr is discarded — is never
  // told anything at all. That is the migration case, and it shipped exactly this way once.
  it('throws an ENV-AUTH-class error, so the durable failure is type-detectable downstream', async () => {
    const error = await resolveEnvToken('dev').catch((err: unknown) => {
      return err
    })

    expect(isEnvAuthFailure(error)).toBe(true)
    expect((error as EnvAuthError).env).toBe('dev')
  })
})
