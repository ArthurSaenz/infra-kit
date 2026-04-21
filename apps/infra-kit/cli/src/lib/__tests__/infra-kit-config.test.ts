import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot } from 'src/lib/git-utils'

import { getInfraKitConfig, resetInfraKitConfigCache } from '../infra-kit-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
  }
})

const VALID_YML = `dopplerProjectName: my-project
environments:
  - dev
  - staging
taskManagerProvider: linear
`

const ALTERNATE_YML = `dopplerProjectName: other-project
environments:
  - dev
taskManagerProvider: false
`

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  resetInfraKitConfigCache()

  try {
    await fn(tmp)
  } finally {
    resetInfraKitConfigCache()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('getInfraKitConfig', () => {
  beforeEach(() => {
    resetInfraKitConfigCache()
  })

  afterEach(() => {
    resetInfraKitConfigCache()
    vi.clearAllMocks()
  })

  it('reads and validates a well-formed infra-kit.yml', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.yml'), VALID_YML)

      const cfg = await getInfraKitConfig()

      expect(cfg.dopplerProjectName).toBe('my-project')
      expect(cfg.environments).toEqual(['dev', 'staging'])
      expect(cfg.taskManagerProvider).toBe('linear')
    })
  })

  it('accepts taskManagerProvider: false as a literal boolean', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.yml'), ALTERNATE_YML)

      const cfg = await getInfraKitConfig()

      expect(cfg.taskManagerProvider).toBe(false)
    })
  })

  it('throws when infra-kit.yml is missing', async () => {
    await withTmpRepo(async () => {
      await expect(getInfraKitConfig()).rejects.toThrow(/not found/)
    })
  })

  it('throws a descriptive error on schema violations', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.yml'),
        'dopplerProjectName: ""\nenvironments: []\ntaskManagerProvider: false\n',
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit.yml/)
    })
  })

  it('re-reads the file when mtime changes (long-running MCP scenario)', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')

      fs.writeFileSync(ymlPath, VALID_YML)

      const first = await getInfraKitConfig()

      expect(first.dopplerProjectName).toBe('my-project')

      // Advance mtime past the previous stat to simulate an edit; write new content.
      const future = new Date(Date.now() + 2_000)

      fs.writeFileSync(ymlPath, ALTERNATE_YML)
      fs.utimesSync(ymlPath, future, future)

      const second = await getInfraKitConfig()

      expect(second.dopplerProjectName).toBe('other-project')
      expect(second.environments).toEqual(['dev'])
    })
  })

  it('returns the cached value on repeated calls when mtime is unchanged', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')

      fs.writeFileSync(ymlPath, VALID_YML)

      const a = await getInfraKitConfig()
      const b = await getInfraKitConfig()

      // Same object reference — no re-parse.
      expect(a).toBe(b)
    })
  })
})
