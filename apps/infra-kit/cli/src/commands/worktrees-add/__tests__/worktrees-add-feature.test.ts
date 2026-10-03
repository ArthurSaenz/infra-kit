import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import type { FakeCommandResult } from 'src/lib/git-utils/__tests__/zx-command-mock'
import { getInfraKitConfig, resolveConfiguredIdes, resolveOrcaLayout } from 'src/lib/infra-kit-config'

import { resolveFeatureBase, toFeatureBranch } from '../feature-worktrees'
import { worktreesAdd } from '../worktrees-add'

/**
 * The feature leg of `worktrees add`: how a `--feature` name becomes a branch, which of the three
 * `git worktree add` forms it gets, and that a bad base or a mixed release+feature call stops before git.
 *
 * @example
 * await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })
 */

const shellCommands = vi.hoisted(() => {
  return [] as string[]
})

/** Commands whose probe exits non-zero; everything else answers 0. */
const failing = vi.hoisted(() => {
  return new Set<string>()
})

/** Commands that print something; everything else prints nothing. */
const stdouts = vi.hoisted(() => {
  return new Map<string, string>()
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  const { zxCommandMock } = await import('src/lib/git-utils/__tests__/zx-command-mock')

  return {
    ...actual,
    $: zxCommandMock((command): FakeCommandResult => {
      shellCommands.push(command)

      return { stdout: stdouts.get(command) ?? '', exitCode: failing.has(command) ? 1 : 0 }
    }),
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getMainRepoRoot: vi.fn(), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn(), resolveConfiguredIdes: vi.fn(), resolveOrcaLayout: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/integrations/ide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/ide')>()

  return { ...actual, addIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const PROJECT_ROOT = '/workspace/project-root'
const WORKTREE_DIR = `${PROJECT_ROOT}-worktrees`
const FEATURE = 'feature/checkout-v2'
const FEATURE_PATH = `${WORKTREE_DIR}/${FEATURE}`

const gitAdds = () => {
  return shellCommands.filter((command) => {
    return command.startsWith('git worktree add')
  })
}

/** A branch neither local nor on origin — the default for every case unless it says otherwise. */
const branchIsNew = (branch: string) => {
  failing.add(`git show-ref --verify --quiet refs/heads/${branch}`)
  failing.add(`git fetch origin ${branch}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  shellCommands.length = 0
  failing.clear()
  stdouts.clear()
  commandEcho.reset()
  vi.spyOn(commandEcho, 'print').mockImplementation(() => {})
  agentMode.source = 'flag'

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getMainRepoRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'test' } },
  })
  vi.mocked(resolveConfiguredIdes).mockReturnValue([])
  vi.mocked(resolveOrcaLayout).mockReturnValue('two-columns')
})

describe('feature names and bases', () => {
  it('normalizes a name with or without the prefix', () => {
    expect(toFeatureBranch(' Checkout V2 ')).toBe(FEATURE)
    expect(toFeatureBranch(FEATURE)).toBe(FEATURE)
  })

  it('defaults the base to dev and resolves a release ref to its branch', async () => {
    expect(await resolveFeatureBase(undefined)).toBe('dev')
    expect(await resolveFeatureBase('1.4.0')).toBe('release/v1.4.0')
    expect(await resolveFeatureBase('release/checkout')).toBe('release/checkout')
  })
})

describe('worktrees add --feature', () => {
  it('cuts a new branch from origin/dev with no upstream and reports it', async () => {
    branchIsNew(FEATURE)

    const result = await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })

    expect(shellCommands).toContain('git fetch origin dev')
    expect(gitAdds()).toEqual([`git worktree add --no-track -b ${FEATURE} ${FEATURE_PATH} origin/dev`])
    expect(shellCommands).toContain('pnpm install')
    expect(result.structuredContent).toMatchObject({
      kind: 'feature',
      createdWorktrees: [FEATURE],
      features: [{ branch: FEATURE, base: 'dev', source: 'new' }],
    })
  })

  it('cuts from a release branch when --base names one', async () => {
    branchIsNew(FEATURE)

    await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2', base: '1.4.0' })

    expect(gitAdds()).toEqual([`git worktree add --no-track -b ${FEATURE} ${FEATURE_PATH} origin/release/v1.4.0`])
  })

  it('tracks an existing remote branch instead of cutting a new one', async () => {
    failing.add(`git show-ref --verify --quiet refs/heads/${FEATURE}`)

    const result = await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })

    expect(gitAdds()).toEqual([`git worktree add --track -b ${FEATURE} ${FEATURE_PATH} origin/${FEATURE}`])
    expect(result.structuredContent).toMatchObject({ features: [{ branch: FEATURE, source: 'remote' }] })
  })

  it('checks out an existing local branch as-is', async () => {
    await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })

    expect(gitAdds()).toEqual([`git worktree add ${FEATURE_PATH} ${FEATURE}`])
  })

  it('skips a feature that already has a worktree', async () => {
    branchIsNew(FEATURE)
    vi.mocked(getCurrentWorktrees).mockImplementation(async (type) => {
      return type === 'feature' ? [FEATURE] : []
    })

    const result = await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })

    expect(gitAdds()).toEqual([])
    expect(result.structuredContent).toMatchObject({ createdWorktrees: [], features: [] })
  })

  it('stops before git when the base does not exist on origin', async () => {
    branchIsNew(FEATURE)
    failing.add('git fetch origin release/v9.9.9')

    await expect(worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2', base: '9.9.9' })).rejects.toThrow(
      /origin\/release\/v9\.9\.9 not found/,
    )
    expect(gitAdds()).toEqual([])
  })

  describe('in a repo with no dev branch', () => {
    const ORIGIN_HEAD = 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD'

    beforeEach(() => {
      branchIsNew(FEATURE)
      failing.add('git fetch origin dev')
    })

    it('cuts from the default branch origin/HEAD records, and previews it', async () => {
      stdouts.set(ORIGIN_HEAD, 'origin/main\n')

      const error = await worktreesAdd({ confirmedCommand: false, feature: 'checkout-v2' }).catch((e: unknown) => {
        return e
      })

      expect((error as StructuredRefusalError).structuredContent.message).toContain(
        `${FEATURE}: new branch from origin/main`,
      )

      const result = await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' })

      expect(gitAdds()).toEqual([`git worktree add --no-track -b ${FEATURE} ${FEATURE_PATH} origin/main`])
      expect(result.structuredContent).toMatchObject({ features: [{ branch: FEATURE, base: 'main', source: 'new' }] })
    })

    it('takes --base main as the branch, not a release named main', async () => {
      failing.add(ORIGIN_HEAD)

      await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2', base: 'main' })

      expect(gitAdds()).toEqual([`git worktree add --no-track -b ${FEATURE} ${FEATURE_PATH} origin/main`])
    })

    it('takes --base <default branch> when the default is not called main', async () => {
      stdouts.set(ORIGIN_HEAD, 'origin/trunk\n')

      await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2', base: 'trunk' })

      expect(gitAdds()).toEqual([`git worktree add --no-track -b ${FEATURE} ${FEATURE_PATH} origin/trunk`])
    })

    it('refuses before git when origin records no default branch either, naming the way out', async () => {
      failing.add(ORIGIN_HEAD)

      const error = await worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2' }).catch((e: unknown) => {
        return e
      })
      const { message } = error as Error

      expect(message).toMatch(/origin\/dev not found/)
      expect(message).toContain('--base main')
      expect(gitAdds()).toEqual([])
    })
  })

  it('refuses a call that mixes release and feature targets', async () => {
    await expect(worktreesAdd({ confirmedCommand: true, feature: 'checkout-v2', versions: '1.2.5' })).rejects.toThrow(
      /cannot be combined/,
    )
    expect(shellCommands).toEqual([])
  })

  it('names the planned branch and its base in the confirmation preview', async () => {
    branchIsNew(FEATURE)

    const error = await worktreesAdd({ confirmedCommand: false, feature: 'checkout-v2' }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent.message).toContain(
      `${FEATURE}: new branch from origin/dev`,
    )
    expect(gitAdds()).toEqual([])
  })
})
