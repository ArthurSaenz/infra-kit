import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkLegacyUserGlobalConfig } from '../doctor'

const cfg = vi.hoisted(() => {
  return { userGlobal: '', shouldThrow: false }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    getInfraKitConfig: vi.fn(),
    resetInfraKitConfigCache: vi.fn(),
    resolveConfiguredIdes: vi.fn(() => {
      return []
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      if (cfg.shouldThrow) {
        return Promise.reject(new Error('no repo'))
      }

      return Promise.resolve({
        main: '',
        userGlobal: cfg.userGlobal,
        userProject: '',
        projectName: 'api',
      })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const withTmpHome = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-doctor-legacy-test-'))
  const dir = path.join(tmp, '.infra-kit')

  fs.mkdirSync(dir, { recursive: true })
  cfg.userGlobal = path.join(dir, 'infra-kit.json')
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)

  try {
    await fn(dir)
  } finally {
    homedirSpy.mockRestore()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('checkLegacyUserGlobalConfig', () => {
  beforeEach(() => {
    cfg.shouldThrow = false
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('fails with a migrate message when only config.json exists (overrides not applied)', async () => {
    await withTmpHome(async (dir) => {
      fs.writeFileSync(path.join(dir, 'config.json'), '{}\n')

      const result = await checkLegacyUserGlobalConfig()

      expect(result.status).toBe('fail')
      expect(result.message).toMatch(/run `infra-kit init` to migrate/)
      expect(result.message).toMatch(/not being applied/)
    })
  })

  it('fails with a stale message when both config.json and infra-kit.json exist', async () => {
    await withTmpHome(async (dir) => {
      fs.writeFileSync(path.join(dir, 'config.json'), '{}\n')
      fs.writeFileSync(path.join(dir, 'infra-kit.json'), '{}\n')

      const result = await checkLegacyUserGlobalConfig()

      expect(result.status).toBe('fail')
      expect(result.message).toMatch(/Stale legacy config\.json/)
      expect(result.message).toMatch(/remove the old file/)
      // Must NOT falsely claim overrides aren't applied — infra-kit.json is active.
      expect(result.message).not.toMatch(/not being applied/)
    })
  })

  it('passes when there is no legacy config.json', async () => {
    await withTmpHome(async (dir) => {
      fs.writeFileSync(path.join(dir, 'infra-kit.json'), '{}\n')

      const result = await checkLegacyUserGlobalConfig()

      expect(result.status).toBe('pass')
      expect(result.message).toMatch(/No legacy user-global config\.json/)
    })
  })

  it('passes informationally when the config paths cannot be resolved', async () => {
    cfg.shouldThrow = true

    const result = await checkLegacyUserGlobalConfig()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Skipped/)
  })
})
