import { beforeEach, describe, expect, it, vi } from 'vitest'

import { configGet } from '../config-get'

// Seed the loader rather than resolving a real repo: configGet must REUSE getInfraKitConfig /
// getInfraKitConfigPaths and surface exactly what they return, so the test pins that contract.
const seed = vi.hoisted(() => {
  return {
    config: {} as Record<string, unknown>,
    paths: { main: '', userGlobal: '', userProject: '', projectName: '' },
    configThrows: null as Error | null,
  }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    getInfraKitConfig: vi.fn(() => {
      if (seed.configThrows) {
        return Promise.reject(seed.configThrows)
      }

      return Promise.resolve(seed.config)
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      return Promise.resolve(seed.paths)
    }),
  }
})

describe('configGet', () => {
  beforeEach(() => {
    seed.configThrows = null
    seed.paths = {
      main: '/repo/infra-kit.json',
      userGlobal: '/home/.infra-kit/infra-kit.json',
      userProject: '/home/.infra-kit/projects/repo/infra-kit.json',
      projectName: 'repo',
    }
    seed.config = {
      envManagement: { provider: 'doppler', config: { name: 'my-proj' } },
      dev: { web: { port: 3000 } },
      devServersPresets: { default: {} },
    }
  })

  it('returns the merged config verbatim as structuredContent, plus the resolved path + project name', async () => {
    const result = await configGet()

    // The merged config is surfaced UNCHANGED under `config` — not re-derived or filtered.
    expect(result.structuredContent.config).toEqual(seed.config)
    expect(result.structuredContent.configPath).toBe('/repo/infra-kit.json')
    expect(result.structuredContent.projectName).toBe('repo')
  })

  it('serializes the same object into the text content channel', async () => {
    const result = await configGet()

    const parsed = JSON.parse(result.content[0]!.text)

    expect(parsed.config).toEqual(seed.config)
    expect(parsed.configPath).toBe('/repo/infra-kit.json')
  })

  it('reflects a different merged config (proves it is not a hard-coded shape)', async () => {
    seed.config = { envManagement: { provider: 'infisical', config: {} } }

    const result = await configGet()

    expect(result.structuredContent.config).toEqual({ envManagement: { provider: 'infisical', config: {} } })
  })

  it('propagates the loader error when run outside a configured repo (honest failure, not empty success)', async () => {
    seed.configThrows = new Error('infra-kit.json not found at /nowhere/infra-kit.json')

    await expect(configGet()).rejects.toThrow('infra-kit.json not found')
  })
})
