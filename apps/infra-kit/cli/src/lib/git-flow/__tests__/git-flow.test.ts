import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getMainRepoRoot, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { integrationBranchOf, resolveGitFlow, resolveIntegrationBranch } from '../git-flow'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

// Absolute, not `git` off PATH (sonarjs/no-os-command-from-path); same choice as the vendor sync fixture.
const GIT_BIN = '/usr/bin/git'

const ENV_MANAGEMENT = { provider: 'doppler', config: { name: 'my-project' } }

const withTmpRepo = async (fn: (tmp: string) => Promise<void>): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-git-flow-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  // Keeps the developer's real ~/.infra-kit layers out of the merge.
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

const writeProjectConfig = (tmp: string, extra: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(tmp, 'infra-kit.json'), JSON.stringify({ envManagement: ENV_MANAGEMENT, ...extra }))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('integrationBranchOf', () => {
  it('maps each flow to the branch work integrates into', () => {
    expect(integrationBranchOf('dev')).toBe('dev')
    expect(integrationBranchOf('main')).toBe('main')
  })
})

describe('resolveGitFlow', () => {
  it('reads "main" from the project infra-kit.json', async () => {
    await withTmpRepo(async (tmp) => {
      writeProjectConfig(tmp, { gitFlow: 'main' })

      expect(await resolveGitFlow()).toBe('main')
      expect(await resolveIntegrationBranch()).toBe('main')
    })
  })

  it('defaults to "dev" when the key is absent', async () => {
    await withTmpRepo(async (tmp) => {
      writeProjectConfig(tmp, {})

      expect(await resolveGitFlow()).toBe('dev')
    })
  })

  it('defaults to "dev" in a repo with no infra-kit.json', async () => {
    await withTmpRepo(async () => {
      expect(await resolveGitFlow()).toBe('dev')
    })
  })

  // A guessed "dev" here would deliver a main-flow repo's release into its stale dev branch.
  it('throws on an invalid value instead of guessing', async () => {
    await withTmpRepo(async (tmp) => {
      writeProjectConfig(tmp, { gitFlow: 'trunk' })

      await expect(resolveGitFlow()).rejects.toThrow(/gitFlow/)
    })
  })

  describe('against origin/main', () => {
    const commitAsOriginMain = (tmp: string, config: Record<string, unknown>): void => {
      const git = (...args: string[]): void => {
        execFileSync(GIT_BIN, ['-C', tmp, ...args], { stdio: 'ignore' })
      }

      writeProjectConfig(tmp, config)
      git('init', '-q')
      git('add', 'infra-kit.json')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'config')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    }

    // A branch cut before the key landed must not read as `dev`: deliver would sync prod into a stale dev.
    it('refuses a checkout that lacks the "main" flow origin/main declares', async () => {
      await withTmpRepo(async (tmp) => {
        commitAsOriginMain(tmp, { gitFlow: 'main' })
        writeProjectConfig(tmp, {})

        await expect(resolveGitFlow()).rejects.toThrow(/origin\/main sets "gitFlow": "main"/)
      })
    })

    it('accepts "dev" when origin/main agrees', async () => {
      await withTmpRepo(async (tmp) => {
        commitAsOriginMain(tmp, {})

        expect(await resolveGitFlow()).toBe('dev')
      })
    })
  })

  it('refuses gitFlow in the per-project override', async () => {
    await withTmpRepo(async (tmp) => {
      writeProjectConfig(tmp, {})

      const layerThreeDir = path.join(tmp, '.infra-kit', 'projects', path.basename(tmp))

      fs.mkdirSync(layerThreeDir, { recursive: true })
      fs.writeFileSync(path.join(layerThreeDir, 'infra-kit.json'), JSON.stringify({ gitFlow: 'main' }))

      await expect(resolveGitFlow()).rejects.toThrow(/"gitFlow" is not allowed in .*\.infra-kit\/projects/)
    })
  })
})
