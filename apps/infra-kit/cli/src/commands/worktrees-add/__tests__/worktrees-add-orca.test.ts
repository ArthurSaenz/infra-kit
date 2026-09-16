import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import {
  OrcaError,
  addOrcaRepo,
  findOrcaRepo,
  isOrcaWorktreeListed,
  openOrcaWorktreeTerminals,
  probeOrca,
} from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, resolveConfiguredIdes, resolveOrcaLayout } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { worktreesAdd } from '../worktrees-add'

/**
 * The Orca leg of `worktrees add` (docs/orca-migration-plan.md §2.4, §2.5): what happens between
 * the confirm and the result for each probe / registration / visibility cell. The driver is a
 * module mock; git and `pnpm install` are the recorded `$` mock. Every case runs headless under
 * `--yes` so no prompt opens.
 *
 * @example
 * await worktreesAdd({ confirmedCommand: true, versions: '1.2.5', orca: true })
 */

const shellCommands = vi.hoisted(() => {
  return [] as string[]
})

// The helper is imported INSIDE the factory: the real Orca barrel (imported above for `OrcaError`)
// pulls `zx` in before a top-level helper import would be initialised.
vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  const { zxCommandMock } = await import('src/lib/git-utils/__tests__/zx-command-mock')

  return {
    ...actual,
    $: zxCommandMock((command) => {
      shellCommands.push(command)

      return { stdout: '' }
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

// `OrcaError` stays real so the `code`-keyed skip reasons are exercised through `instanceof`; the
// poll and title helpers are pure and stay real too. Only the spawning verbs are mocked.
vi.mock('src/integrations/orca', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/orca')>()

  return {
    ...actual,
    probeOrca: vi.fn(),
    findOrcaRepo: vi.fn(),
    addOrcaRepo: vi.fn(),
    openOrcaWorktreeTerminals: vi.fn(),
    isOrcaWorktreeListed: vi.fn(),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const PROJECT_ROOT = '/workspace/project-root'
const MAIN_REPO_ROOT = '/workspace/hulyo-monorepo'
const WORKTREE_DIR = `${PROJECT_ROOT}-worktrees`
const BRANCH_A = 'release/v1.2.5'
const BRANCH_B = 'release/v1.2.6'

const run = (args: { versions: string; orca?: boolean }) => {
  return worktreesAdd({ confirmedCommand: true, ...args })
}

const gitAdds = () => {
  return shellCommands.filter((command) => {
    return command.startsWith('git worktree add')
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  shellCommands.length = 0
  commandEcho.reset()
  vi.spyOn(commandEcho, 'print').mockImplementation(() => {})
  agentMode.source = 'flag'

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(getProjectRoot).mockResolvedValue(PROJECT_ROOT)
  vi.mocked(getMainRepoRoot).mockResolvedValue(MAIN_REPO_ROOT)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'test' } },
    worktrees: { openInGithubDesktop: false },
  })
  vi.mocked(resolveConfiguredIdes).mockReturnValue([])
  vi.mocked(resolveOrcaLayout).mockReturnValue('three-pane')

  vi.mocked(probeOrca).mockResolvedValue('ready')
  vi.mocked(findOrcaRepo).mockResolvedValue({ registered: true, visibility: 'show' })
  vi.mocked(addOrcaRepo).mockResolvedValue({ visibility: 'hide' })
  vi.mocked(openOrcaWorktreeTerminals).mockResolvedValue({ handles: ['h0', 'h1', 'h2'], layout: 'full' })
  vi.mocked(isOrcaWorktreeListed).mockResolvedValue(true)
})

describe('worktrees add — the Orca leg on a shown, registered repo', () => {
  it('lays out a single created worktree WITH focus and reports it under orcaOpened', async () => {
    const result = await run({ versions: '1.2.5', orca: true })

    expect(gitAdds()).toEqual([`git worktree add ${WORKTREE_DIR}/${BRANCH_A} ${BRANCH_A}`])
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(1)
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: `${WORKTREE_DIR}/${BRANCH_A}`,
        title: '1.2.5',
        focus: true,
        layout: 'full',
        panes: 'three-pane',
      }),
    )
    expect(isOrcaWorktreeListed).toHaveBeenCalledWith(MAIN_REPO_ROOT, `${WORKTREE_DIR}/${BRANCH_A}`)
    expect(result.structuredContent).toEqual({
      createdWorktrees: [BRANCH_A],
      count: 1,
      orcaOpened: [{ branch: BRANCH_A, layout: 'full' }],
      orcaSkipped: [],
      orcaHidden: [],
    })
    expect(addOrcaRepo).not.toHaveBeenCalled()
  })

  it('lays out a multi-branch batch WITHOUT focus, sharing one poll, with no already-open check', async () => {
    await run({ versions: '1.2.5, 1.2.6', orca: true })

    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(2)

    const calls = vi.mocked(openOrcaWorktreeTerminals).mock.calls.map((call) => {
      return call[0]
    })

    expect(
      calls.map((call) => {
        return call.focus
      }),
    ).toEqual([false, false])
    expect(calls[0]?.poll).toBeDefined()
    expect(calls[1]?.poll).toBe(calls[0]?.poll)
    // Fresh worktrees always lay out — the driver's `terminal list` is never consulted here.
    expect(
      shellCommands.some((command) => {
        return command.includes('terminal list')
      }),
    ).toBe(false)
  })

  it('routes a worktree the sidebar does not list to orcaHidden with the UI steps', async () => {
    vi.mocked(isOrcaWorktreeListed).mockResolvedValue(false)

    const result = await run({ versions: '1.2.5', orca: true })

    expect(result.structuredContent.orcaOpened).toEqual([])
    expect(result.structuredContent.orcaHidden).toEqual([
      {
        branch: BRANCH_A,
        path: `${WORKTREE_DIR}/${BRANCH_A}`,
        fix: 'Orca → hulyo-monorepo → "hidden worktrees" card → Show, or Settings → General → Workspace → external-worktree sources',
      },
    ])
  })

  it('reports a poll exhaustion as orca_worktree_not_selectable and any other OrcaError with its code, and keeps going', async () => {
    vi.mocked(openOrcaWorktreeTerminals)
      .mockRejectedValueOnce(new OrcaError({ code: 'orca_worktree_not_selectable', message: 'not yet' }))
      .mockRejectedValueOnce(new OrcaError({ code: 'runtime_error', message: 'boom' }))

    const result = await run({ versions: '1.2.5, 1.2.6', orca: true })

    expect(result.structuredContent.createdWorktrees).toEqual([BRANCH_A, BRANCH_B])
    expect(result.structuredContent.orcaSkipped).toEqual([
      { branch: BRANCH_A, reason: 'orca_worktree_not_selectable' },
      { branch: BRANCH_B, reason: 'orca_error', code: 'runtime_error' },
    ])
    expect(result.structuredContent.orcaOpened).toEqual([])
  })
})

describe('worktrees add — a hidden repo never gets --focus (axis 1 = no)', () => {
  it('opens a single target in the background when the repo hides external worktrees', async () => {
    vi.mocked(findOrcaRepo).mockResolvedValue({ registered: true, visibility: 'hide' })
    vi.mocked(isOrcaWorktreeListed).mockResolvedValue(false)

    const result = await run({ versions: '1.2.5', orca: true })

    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(expect.objectContaining({ focus: false }))
    expect(result.structuredContent.orcaHidden).toHaveLength(1)
  })
})

describe('worktrees add — an unregistered repo is registered after the confirm, before git', () => {
  it('runs orca repo add once, then lays out without focus (a fresh row is hidden)', async () => {
    vi.mocked(findOrcaRepo).mockResolvedValue({ registered: false })
    vi.mocked(isOrcaWorktreeListed).mockResolvedValue(false)

    const order: string[] = []

    vi.mocked(addOrcaRepo).mockImplementation(async () => {
      order.push('repo add')

      return { visibility: 'hide' }
    })
    vi.mocked(openOrcaWorktreeTerminals).mockImplementation(async () => {
      order.push(`open after ${gitAdds().length} git add(s)`)

      return { handles: ['h0'], layout: 'full' }
    })

    const result = await run({ versions: '1.2.5', orca: true })

    expect(addOrcaRepo).toHaveBeenCalledWith(MAIN_REPO_ROOT)
    expect(order).toEqual(['repo add', 'open after 1 git add(s)'])
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(expect.objectContaining({ focus: false }))
    expect(result.structuredContent.orcaHidden).toHaveLength(1)
  })

  it('a failed repo add never blocks git: every branch lands in orcaSkipped as orca_error', async () => {
    vi.mocked(findOrcaRepo).mockResolvedValue({ registered: false })
    vi.mocked(addOrcaRepo).mockRejectedValue(new OrcaError({ code: 'repo_add_failed', message: 'nope' }))

    const result = await run({ versions: '1.2.5', orca: true })

    expect(gitAdds()).toHaveLength(1)
    expect(openOrcaWorktreeTerminals).not.toHaveBeenCalled()
    expect(result.structuredContent.orcaSkipped).toEqual([
      { branch: BRANCH_A, reason: 'orca_error', code: 'repo_add_failed' },
    ])
  })
})

describe('worktrees add — Orca not ready', () => {
  it('config-derived openInOrca + unreachable: worktrees are created, one warn, every branch orcaSkipped', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      envManagement: { provider: 'doppler', config: { name: 'test' } },
      worktrees: { openInGithubDesktop: false, openInOrca: true },
    })
    vi.mocked(probeOrca).mockResolvedValue('unreachable')

    const result = await run({ versions: '1.2.5, 1.2.6' })

    expect(gitAdds()).toHaveLength(2)
    expect(findOrcaRepo).not.toHaveBeenCalled()
    expect(openOrcaWorktreeTerminals).not.toHaveBeenCalled()
    expect(result.structuredContent.orcaSkipped).toEqual([
      { branch: BRANCH_A, reason: 'orca_unreachable' },
      { branch: BRANCH_B, reason: 'orca_unreachable' },
    ])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('config-derived openInOrca + absent: the reason is orca_absent', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      envManagement: { provider: 'doppler', config: { name: 'test' } },
      worktrees: { openInGithubDesktop: false, openInOrca: true },
    })
    vi.mocked(probeOrca).mockResolvedValue('absent')

    const result = await run({ versions: '1.2.5' })

    expect(result.structuredContent.orcaSkipped).toEqual([{ branch: BRANCH_A, reason: 'orca_absent' }])
  })

  it('explicit --orca + absent: refuses orca_absent before any git call', async () => {
    vi.mocked(probeOrca).mockResolvedValue('absent')

    const error = await run({ versions: '1.2.5', orca: true }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'refused',
      reason: 'orca_absent',
    })
    expect(gitAdds()).toEqual([])
    expect(findOrcaRepo).not.toHaveBeenCalled()
  })

  it('--no-orca spawns nothing Orca-related', async () => {
    const result = await run({ versions: '1.2.5', orca: false })

    expect(probeOrca).not.toHaveBeenCalled()
    expect(result.structuredContent).toMatchObject({ orcaOpened: [], orcaSkipped: [], orcaHidden: [] })
  })
})

describe('worktrees add — the early return carries the Orca arrays', () => {
  it('emits empty orcaOpened/orcaSkipped/orcaHidden when there is no open release branch', async () => {
    const result = await worktreesAdd({ confirmedCommand: true })

    expect(result.structuredContent).toEqual({
      createdWorktrees: [],
      count: 0,
      orcaOpened: [],
      orcaSkipped: [],
      orcaHidden: [],
    })
    expect(probeOrca).not.toHaveBeenCalled()
  })
})
