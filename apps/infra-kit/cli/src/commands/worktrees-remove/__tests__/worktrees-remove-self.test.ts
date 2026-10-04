import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { probeOrca, runOrca } from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { assertManagementContext } from 'src/lib/git-guard'
import { getMainRepoRoot, getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'

import { worktreesRemove } from '../worktrees-remove'

/**
 * `worktrees remove --self` checks every refusal the removal could hit while nothing is closed yet,
 * then hands the ordinary `worktrees remove` to an Orca tab of the main checkout.
 *
 * @example
 * await worktreesRemove({ confirmedCommand: true, self: true }) // → orca terminal create on the main row
 */

const MAIN = '/repos/app'
const FEATURE_PATH = `${MAIN}-worktrees/feature/checkout-v2`
const RELEASE_PATH = `${MAIN}-worktrees/release/v1.2.5`

vi.mock('zx', () => {
  return { $: vi.fn() }
})

vi.mock('node:fs/promises', () => {
  return {
    default: {
      realpath: vi.fn((value: string) => {
        return Promise.resolve(value)
      }),
    },
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), listWorktrees: vi.fn(), getCurrentWorktrees: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/integrations/orca', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/orca')>()

  return { ...actual, probeOrca: vi.fn(), runOrca: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const entry = (path: string, branch: string | null): WorktreeEntry => {
  return { path, branch, detached: false, bare: false, prunable: false, locked: false }
}

/** `git -C <dir> status --porcelain` answers from this map; every other dir is clean. */
let dirtyByDir: Record<string, string> = {}

const stubGit = (): void => {
  const run = (strings: TemplateStringsArray, values: unknown[]) => {
    const dir = String(values[0])

    return Promise.resolve({ stdout: strings.join('').includes('status') ? (dirtyByDir[dir] ?? '') : '' })
  }

  vi.mocked($).mockImplementation(((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first)) return run(first as unknown as TemplateStringsArray, values)

    return (strings: TemplateStringsArray, ...inner: unknown[]) => {
      return run(strings, inner)
    }
  }) as unknown as typeof $)
}

const callerIn = (path: string): void => {
  vi.mocked(getProjectRoot).mockResolvedValue(path)
}

const createCalls = (): string[][] => {
  return vi
    .mocked(runOrca)
    .mock.calls.map(([argv]) => {
      return argv
    })
    .filter((argv) => {
      return argv[0] === 'terminal' && argv[1] === 'create'
    })
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.spyOn(commandEcho, 'print').mockImplementation(() => {})
  agentMode.source = null
  dirtyByDir = {}

  stubGit()
  callerIn(FEATURE_PATH)
  vi.mocked(getMainRepoRoot).mockResolvedValue(MAIN)
  vi.mocked(listWorktrees).mockResolvedValue([
    entry(MAIN, 'main'),
    entry(FEATURE_PATH, 'feature/checkout-v2'),
    entry(RELEASE_PATH, 'release/v1.2.5'),
  ])
  vi.mocked(probeOrca).mockResolvedValue('ready')
  vi.mocked(runOrca).mockResolvedValue({ terminal: { handle: 'term_1' } })
})

describe('worktrees remove --self — hand-off', () => {
  it('hands the feature removal to an Orca tab of the main checkout, skipping the main-checkout guard', async () => {
    const result = await worktreesRemove({ confirmedCommand: true, self: true })

    expect(assertManagementContext).not.toHaveBeenCalled()
    expect(createCalls()).toHaveLength(1)

    const argv = createCalls()[0] ?? []

    expect(argv).toEqual(
      expect.arrayContaining(['--worktree', `path:${MAIN}`, '--title', 'ik: remove feature/checkout-v2']),
    )
    expect(argv.at(-1)).toBe('sleep 2; infra-kit worktrees remove --feature checkout-v2 --yes && { sleep 3; exit; }')
    expect((result.structuredContent as { handedOff?: unknown } | undefined)?.handedOff).toEqual({
      branch: 'feature/checkout-v2',
      worktreePath: FEATURE_PATH,
      terminal: 'term_1',
    })
  })

  it('names a release worktree with --versions', async () => {
    callerIn(RELEASE_PATH)

    await worktreesRemove({ confirmedCommand: true, self: true })

    expect(createCalls()[0]?.at(-1)).toMatch(/infra-kit worktrees remove --versions \S*1\.2\.5\S* --yes/)
  })
})

describe('worktrees remove --self — refusals close nothing', () => {
  it.each([
    [
      'the main checkout',
      () => {
        return callerIn(MAIN)
      },
      /not a linked worktree/,
    ],
    [
      'a dirty worktree',
      () => {
        dirtyByDir[FEATURE_PATH] = '?? notes.md'
      },
      /uncommitted changes: \?\? notes\.md/,
    ],
    [
      'a dirty main checkout',
      () => {
        dirtyByDir[MAIN] = ' M package.json'
      },
      /main checkout has uncommitted changes/,
    ],
    [
      'Orca not running',
      () => {
        return vi.mocked(probeOrca).mockResolvedValue('unreachable')
      },
      /Orca is unreachable/,
    ],
    [
      'a worktree outside the infra-kit layout',
      () => {
        callerIn('/elsewhere/feature/checkout-v2')
        vi.mocked(listWorktrees).mockResolvedValue([entry('/elsewhere/feature/checkout-v2', 'feature/checkout-v2')])
      },
      /is not an infra-kit worktree/,
    ],
  ])('refuses %s', async (_name, arrange, message) => {
    arrange()

    await expect(worktreesRemove({ confirmedCommand: true, self: true })).rejects.toThrow(message)
    expect(createCalls()).toEqual([])
  })

  it('refuses --self combined with explicit targets', async () => {
    await expect(worktreesRemove({ confirmedCommand: true, self: true, feature: 'x' })).rejects.toThrow(
      /--self cannot be combined/,
    )
    expect(createCalls()).toEqual([])
  })

  it('stops at the confirmation gate under agent mode without --yes', async () => {
    agentMode.source = 'flag'

    await expect(worktreesRemove({ confirmedCommand: false, self: true })).rejects.toMatchObject({
      structuredContent: expect.objectContaining({ status: 'confirmation_required' }),
    })
    expect(createCalls()).toEqual([])
  })
})
