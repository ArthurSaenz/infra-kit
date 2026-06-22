import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkIdeInstalled } from '../doctor'

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

describe('checkIdeInstalled', () => {
  beforeEach(() => {
    config.value = {}
    config.shouldThrow = false
    zx.shouldThrow = false
    vi.clearAllMocks()
  })

  it('passes informationally when no IDE is configured', async () => {
    config.value = { ide: undefined }

    const result = await checkIdeInstalled()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/No IDE configured/)
  })

  it('passes when the configured Cursor binary is present', async () => {
    config.value = { ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } } }

    const result = await checkIdeInstalled()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Cursor/)
  })

  it('fails when the configured Cursor binary is missing', async () => {
    config.value = { ide: { provider: 'cursor', config: { workspaceConfigPath: 'ws' } } }
    zx.shouldThrow = true

    const result = await checkIdeInstalled()

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Cursor is not installed/)
  })

  it('passes when the configured Zed binary is present', async () => {
    config.value = { ide: { provider: 'zed', config: {} } }

    const result = await checkIdeInstalled()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Zed/)
  })

  it('fails when the configured Zed binary is missing', async () => {
    config.value = { ide: { provider: 'zed', config: {} } }
    zx.shouldThrow = true

    const result = await checkIdeInstalled()

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Zed is not installed/)
  })

  it('passes listing all editors when multiple are configured and present', async () => {
    config.value = {
      ide: [
        { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
        { provider: 'zed', config: {} },
      ],
    }

    const result = await checkIdeInstalled()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Installed: Cursor, Zed/)
  })

  it('fails when one of several configured editors is missing', async () => {
    config.value = {
      ide: [
        { provider: 'cursor', config: { workspaceConfigPath: 'ws' } },
        { provider: 'zed', config: {} },
      ],
    }
    zx.shouldThrow = true

    const result = await checkIdeInstalled()

    expect(result.status).toBe('fail')
    expect(result.message).toMatch(/Cursor is not installed/)
  })

  it('passes informationally when the config cannot be read', async () => {
    config.shouldThrow = true

    const result = await checkIdeInstalled()

    expect(result.status).toBe('pass')
    expect(result.message).toMatch(/Skipped/)
  })
})
