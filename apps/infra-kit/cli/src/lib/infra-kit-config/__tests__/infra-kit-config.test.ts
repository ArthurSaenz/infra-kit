import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { getInfraKitConfig, resetInfraKitConfigCache } from '../infra-kit-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
  }
})

const VALID_YML = `environments:
  - dev
  - staging
envManagement:
  provider: doppler
  config:
    name: my-project
`

const ALTERNATE_YML = `environments:
  - dev
envManagement:
  provider: doppler
  config:
    name: other-project
`

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-config-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  // Point os.homedir() at the tmp dir so user-scope override layers
  // (~/.infra-kit/config.yml, ~/.infra-kit/projects/<repo>/infra-kit.yml)
  // can't leak the developer's real config into the test.
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)

  resetInfraKitConfigCache()

  try {
    await fn(tmp)
  } finally {
    homedirSpy.mockRestore()
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

      expect(cfg.envManagement.config.name).toBe('my-project')
      expect(cfg.environments).toEqual(['dev', 'staging'])
      expect(cfg.taskManager).toBeUndefined()
      expect(cfg.ide).toBeUndefined()
    })
  })

  it('accepts ide and taskManager when provided', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.yml'),
        `environments: [dev]
envManagement:
  provider: doppler
  config:
    name: p
ide:
  provider: cursor
  config:
    mode: workspace
    workspaceConfigPath: ./ws.code-workspace
taskManager:
  provider: jira
  config:
    baseUrl: https://example.atlassian.net
    projectId: 123
`,
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.ide?.provider).toBe('cursor')

      if (cfg.ide?.provider === 'cursor') {
        expect(cfg.ide.config.mode).toBe('workspace')
        expect(cfg.ide.config.workspaceConfigPath).toBe('./ws.code-workspace')
      }

      expect(cfg.taskManager?.provider).toBe('jira')
    })
  })

  it('accepts a worktrees prompt-defaults block', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.yml'),
        `environments: [dev]
envManagement:
  provider: doppler
  config:
    name: p
worktrees:
  openInGithubDesktop: false
  openInCmux: true
`,
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees?.openInGithubDesktop).toBe(false)
      expect(cfg.worktrees?.openInCmux).toBe(true)
    })
  })

  it('lets the user-global config layer supply a worktrees block when the project omits it', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'infra-kit.yml'), VALID_YML)

      const userGlobalDir = path.join(tmp, '.infra-kit')

      fs.mkdirSync(userGlobalDir, { recursive: true })
      fs.writeFileSync(
        path.join(userGlobalDir, 'config.yml'),
        `worktrees:
  openInGithubDesktop: false
  openInCmux: true
`,
      )

      const cfg = await getInfraKitConfig()

      expect(cfg.worktrees?.openInGithubDesktop).toBe(false)
      expect(cfg.worktrees?.openInCmux).toBe(true)
    })
  })

  it('rejects ide.cursor mode=workspace without workspaceConfigPath', async () => {
    await withTmpRepo(async (tmp) => {
      fs.writeFileSync(
        path.join(tmp, 'infra-kit.yml'),
        `environments: [dev]
envManagement:
  provider: doppler
  config:
    name: p
ide:
  provider: cursor
  config:
    mode: workspace
`,
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/workspaceConfigPath/)
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
        'environments: []\nenvManagement:\n  provider: doppler\n  config:\n    name: ""\n',
      )

      await expect(getInfraKitConfig()).rejects.toThrow(/Invalid infra-kit.yml/)
    })
  })

  it('re-reads the file when mtime changes (long-running MCP scenario)', async () => {
    await withTmpRepo(async (tmp) => {
      const ymlPath = path.join(tmp, 'infra-kit.yml')

      fs.writeFileSync(ymlPath, VALID_YML)

      const first = await getInfraKitConfig()

      expect(first.envManagement.config.name).toBe('my-project')

      // Advance mtime past the previous stat to simulate an edit; write new content.
      const future = new Date(Date.now() + 2_000)

      fs.writeFileSync(ymlPath, ALTERNATE_YML)
      fs.utimesSync(ymlPath, future, future)

      const second = await getInfraKitConfig()

      expect(second.envManagement.config.name).toBe('other-project')
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
