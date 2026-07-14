import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import type { DoctorConfig } from '../doctor'
import { checkIdeInstalled, readDoctorConfig } from '../doctor'

const config = vi.hoisted(() => {
  return { value: {} as { ide?: unknown }, shouldThrow: false }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    resetInfraKitConfigCache: vi.fn(),
    getInfraKitConfig: vi.fn(() => {
      if (config.shouldThrow) {
        return Promise.reject(new Error('bad config'))
      }

      return Promise.resolve(config.value)
    }),
    // Mirror the real normalizer (single → [ide], array → as-is, undefined → []).
    resolveConfiguredIdes: vi.fn((cfg: { ide?: unknown }) => {
      const ide = cfg.ide

      if (!ide) return []

      return Array.isArray(ide) ? ide : [ide]
    }),
  }
})

const zx = vi.hoisted(() => {
  return { shouldThrow: false }
})

vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      if (zx.shouldThrow) {
        return Promise.reject(new Error('command not found'))
      }

      return Promise.resolve({ stdout: '' })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

/** The already-read config every check is threaded, standing in for one `readDoctorConfig()` run. */
const read = (value: unknown): DoctorConfig => {
  return { config: value as InfraKitConfig, error: null }
}

describe('checkIdeInstalled', () => {
  beforeEach(() => {
    config.value = {}
    config.shouldThrow = false
    zx.shouldThrow = false
    vi.clearAllMocks()
  })

  it('passes informationally when no IDE is configured', async () => {
    const result = await checkIdeInstalled(read({ ide: undefined }))

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/No IDE configured/)
  })

  it('passes when the configured Cursor binary is present', async () => {
    const result = await checkIdeInstalled(read({ ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } } }))

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Cursor/)
  })

  it('fails when the configured Cursor binary is missing', async () => {
    zx.shouldThrow = true

    const result = await checkIdeInstalled(read({ ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } } }))

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Cursor is not installed/)
  })

  it('passes when the configured Zed binary is present', async () => {
    const result = await checkIdeInstalled(read({ ide: { provider: 'zed', config: {} } }))

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Zed/)
  })

  it('fails when the configured Zed binary is missing', async () => {
    zx.shouldThrow = true

    const result = await checkIdeInstalled(read({ ide: { provider: 'zed', config: {} } }))

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Zed is not installed/)
  })

  it('passes listing all editors when multiple are configured and present', async () => {
    const result = await checkIdeInstalled(
      read({
        ide: [
          { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
          { provider: 'zed', config: {} },
        ],
      }),
    )

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Cursor, Zed/)
  })

  it('fails when one of several configured editors is missing', async () => {
    zx.shouldThrow = true

    const result = await checkIdeInstalled(
      read({
        ide: [
          { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
          { provider: 'zed', config: {} },
        ],
      }),
    )

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Cursor is not installed/)
  })

  it('passes informationally when the config could not be read', async () => {
    const result = await checkIdeInstalled({ config: null, error: new Error('bad config') })

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Skipped/)
  })

  /**
   * The race this pins: `checkIdeInstalled` used to reset the module-level config cache itself, while
   * `checkInfraKitConfigValid` did the same from the SAME `Promise.all` — two resets against one shared
   * slot. The check now consumes an already-read config and must touch the cache not at all.
   */
  it('never resets the shared config cache — it consumes the config doctor already read', async () => {
    await checkIdeInstalled(read({ ide: { provider: 'zed', config: {} } }))

    expect(vi.mocked(resetInfraKitConfigCache)).not.toHaveBeenCalled()
  })
})

describe('readDoctorConfig', () => {
  beforeEach(() => {
    config.value = {}
    config.shouldThrow = false
    vi.clearAllMocks()
  })

  it('resets the config cache exactly once, so doctor reports what is on disk now', async () => {
    await readDoctorConfig()

    expect(vi.mocked(resetInfraKitConfigCache)).toHaveBeenCalledTimes(1)
  })

  it('captures a broken config instead of throwing — explaining it is what doctor is for', async () => {
    config.shouldThrow = true

    const result = await readDoctorConfig()

    expect(result.config).toBeNull()
    expect(result.error?.message).toBe('bad config')
  })
})
