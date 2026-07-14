import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readTokenStore, setToken } from 'src/lib/env-tokens'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { purgeRepoWarmCaches } from 'src/lib/warm-cache'

import { envTokenRemove } from '../env-token-remove'

const DEV_TOKEN = 'dp.st.dev.REMOVE_CANARY_00001111'
const PROD_TOKEN = 'dp.st.prod.REMOVE_CANARY_2222aaaa'

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
})

// The real purge (3 worktrees, real git) is covered in lib/warm-cache/__tests__/purge-repo.test.ts.
vi.mock('src/lib/warm-cache', () => {
  return {
    purgeRepoWarmCaches: vi.fn(async () => {
      return ['/warm/a', '/warm/b', '/warm/c']
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

const REPO_CONFIG = JSON.stringify({
  envManagement: { provider: 'doppler', config: { name: 'example-project' } },
})

let home: string
let repo: string

const printed = (): string => {
  return [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls].flat().join('\n')
}

beforeEach(async () => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-remove-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-remove-repo-')))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), REPO_CONFIG)

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  resetInfraKitConfigCache()

  await setToken('dev', DEV_TOKEN)
  await setToken('prod', PROD_TOKEN)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('env-token-remove', () => {
  it('drops only the named env’s key, and leaves the others', async () => {
    const result = await envTokenRemove({ env: 'dev' })

    const store = await readTokenStore()

    expect(store?.envs.dev).toBeUndefined()
    expect(store?.envs.prod).toBe(PROD_TOKEN)
    expect(result.structuredContent.removed).toBe(true)
  })

  /**
   * The removed token must not keep working for another 2h out of a sibling worktree's warm cache —
   * the cache is keyed per WORKTREE while the store is keyed per REPO.
   */
  it('purges the warm caches across every worktree', async () => {
    const result = await envTokenRemove({ env: 'dev' })

    expect(vi.mocked(purgeRepoWarmCaches)).toHaveBeenCalledTimes(1)
    expect(result.structuredContent.warmCachesPurged).toBe(3)
  })

  // The thing a user is most likely to get wrong: a local delete is not a revocation.
  it('says the token is NOT revoked, and prints where to revoke it', async () => {
    const result = await envTokenRemove({ env: 'dev' })

    expect(printed()).toMatch(/does NOT revoke it/)
    expect(printed()).toContain('https://dashboard.doppler.com')
    expect(result.structuredContent.revokeUrl).toContain('example-project')
  })

  it('is a no-op — not a failure — when there is no token for the env', async () => {
    await envTokenRemove({ env: 'dev' })

    const result = await envTokenRemove({ env: 'dev' })

    expect(result.structuredContent.removed).toBe(false)
    expect(printed()).toMatch(/nothing to remove/)
  })

  it('never prints a token value', async () => {
    await envTokenRemove({ env: 'dev' })

    expect(printed()).not.toContain(DEV_TOKEN)
    expect(printed()).not.toContain(PROD_TOKEN)
  })
})
