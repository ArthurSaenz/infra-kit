import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OrcaError,
  isOrcaWorktreeListed,
  listOrcaTerminals,
  openOrcaWorktreeTerminals,
  probeOrca,
} from 'src/integrations/orca'
import type { OrcaTerminal } from 'src/integrations/orca'
import { logger } from 'src/lib/logger'

import { reopenOrca } from '../reopen'

/**
 * `reopenOrca` — the additive, never-focusing, never-closing Orca leg of `reopen`
 * (docs/orca-migration-plan.md §2.4 `commands/reopen`, §2.5 axis 2 = yes).
 *
 * @example
 * await reopenOrca({ targets, mainRepoRoot: '/repos/hulyo', repoName: 'hulyo', config })
 */

// Mock only the spawning verbs; `OrcaError` and the poll stay real so the code-keyed skips are
// exercised through `instanceof`.
vi.mock('src/integrations/orca', async (importActual) => {
  const actual = await importActual<typeof import('src/integrations/orca')>()

  return {
    ...actual,
    probeOrca: vi.fn(),
    listOrcaTerminals: vi.fn(),
    openOrcaWorktreeTerminals: vi.fn(),
    isOrcaWorktreeListed: vi.fn(),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const MAIN = '/repos/hulyo-monorepo'
const REPO = 'hulyo-monorepo'
const CWD_A = '/repos/hulyo-worktrees/release/v1.48.0'
const CWD_B = '/repos/hulyo-worktrees/release/checkout-redesign'
const BRANCH_A = 'release/v1.48.0'
const BRANCH_B = 'release/checkout-redesign'

const targets = [
  { branch: BRANCH_A, title: '1.48.0', cwd: CWD_A },
  { branch: BRANCH_B, title: 'checkout-redesign', cwd: CWD_B },
]

const config = { envManagement: { provider: 'doppler' as const, config: { name: 'test' } } }

const connected = (handle: string): OrcaTerminal => {
  return { handle, title: 't', tabId: 'tab', connected: true, orphaned: false }
}

const terminalsIn = (open: Record<string, OrcaTerminal[]>) => {
  vi.mocked(listOrcaTerminals).mockImplementation(async (cwd: string) => {
    return { terminals: open[cwd] ?? [], truncated: false }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(probeOrca).mockResolvedValue('ready')
  terminalsIn({})
  vi.mocked(openOrcaWorktreeTerminals).mockResolvedValue({ handles: ['h0', 'h1'], layout: 'full' })
  vi.mocked(isOrcaWorktreeListed).mockResolvedValue(true)
})

describe('reopenOrca — additive, keyed on a connected terminal in the cwd', () => {
  it('opens only the targets with no connected terminal; the rest are already_open', async () => {
    terminalsIn({ [CWD_A]: [connected('h5')] })

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.opened).toEqual([{ branch: BRANCH_B, layout: 'full' }])
    expect(result.skipped).toEqual([{ branch: BRANCH_A, reason: 'already_open' }])
    expect(result.hidden).toEqual([])
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(1)
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: CWD_B, title: 'checkout-redesign', focus: false, layout: 'full' }),
    )
  })

  it('a disconnected terminal does not count as open', async () => {
    terminalsIn({ [CWD_A]: [{ ...connected('h5'), connected: false }] })

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.opened).toHaveLength(2)
  })

  it('is idempotent: a second run with every cwd already open opens 0 new tabs', async () => {
    terminalsIn({ [CWD_A]: [connected('h5')], [CWD_B]: [connected('h6')] })

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.opened).toEqual([])
    expect(result.skipped).toEqual([
      { branch: BRANCH_A, reason: 'already_open' },
      { branch: BRANCH_B, reason: 'already_open' },
    ])
    expect(openOrcaWorktreeTerminals).not.toHaveBeenCalled()
  })

  it('never passes --focus and shares one poll across the batch', async () => {
    await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    const calls = vi.mocked(openOrcaWorktreeTerminals).mock.calls.map((call) => {
      return call[0]
    })

    expect(calls).toHaveLength(2)
    expect(
      calls.every((call) => {
        return call.focus === false
      }),
    ).toBe(true)
    expect(calls[1]?.poll).toBe(calls[0]?.poll)
  })

  it('reports a target whose row the sidebar hides under hidden, with the UI steps', async () => {
    vi.mocked(isOrcaWorktreeListed).mockImplementation(async (_main: string, cwd: string) => {
      return cwd !== CWD_B
    })

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.opened).toEqual([{ branch: BRANCH_A, layout: 'full' }])
    expect(result.hidden).toEqual([
      {
        branch: BRANCH_B,
        path: CWD_B,
        fix: 'Orca → hulyo-monorepo → "hidden worktrees" card → Show, or Settings → General → Workspace → external-worktree sources',
      },
    ])
  })

  it('continues past a per-target Orca failure, recording the reason and code', async () => {
    vi.mocked(openOrcaWorktreeTerminals)
      .mockRejectedValueOnce(new OrcaError({ code: 'orca_worktree_not_selectable', message: 'not yet' }))
      .mockResolvedValueOnce({ handles: ['h0'], layout: 'full' })

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.skipped).toEqual([{ branch: BRANCH_A, reason: 'orca_worktree_not_selectable' }])
    expect(result.opened).toEqual([{ branch: BRANCH_B, layout: 'full' }])
    expect(openOrcaWorktreeTerminals).toHaveBeenCalledTimes(2)
  })

  it('maps any other OrcaError to orca_error with its code', async () => {
    vi.mocked(openOrcaWorktreeTerminals).mockRejectedValue(new OrcaError({ code: 'runtime_error', message: 'boom' }))

    const result = await reopenOrca({ targets: [targets[0]!], mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.skipped).toEqual([{ branch: BRANCH_A, reason: 'orca_error', code: 'runtime_error' }])
  })
})

describe('reopenOrca — Orca not ready', () => {
  it('unreachable: skips every target with orca_unreachable, one warn, no refusal, no list/open', async () => {
    vi.mocked(probeOrca).mockResolvedValue('unreachable')

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result.skipped).toEqual([
      { branch: BRANCH_A, reason: 'orca_unreachable' },
      { branch: BRANCH_B, reason: 'orca_unreachable' },
    ])
    expect(result.opened).toEqual([])
    expect(listOrcaTerminals).not.toHaveBeenCalled()
    expect(openOrcaWorktreeTerminals).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('absent: the reason is orca_absent', async () => {
    vi.mocked(probeOrca).mockResolvedValue('absent')

    const result = await reopenOrca({ targets, mainRepoRoot: MAIN, repoName: REPO, config })

    expect(
      result.skipped.map((entry) => {
        return entry.reason
      }),
    ).toEqual(['orca_absent', 'orca_absent'])
  })

  it('with no targets nothing is probed', async () => {
    const result = await reopenOrca({ targets: [], mainRepoRoot: MAIN, repoName: REPO, config })

    expect(result).toEqual({ opened: [], skipped: [], hidden: [] })
    expect(probeOrca).not.toHaveBeenCalled()
  })
})
