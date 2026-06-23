import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { CmuxLayout } from 'src/lib/infra-kit-config'

import { openCmuxWorkspaceWithLayout } from '../open-workspace-with-layout'

vi.mock('src/lib/infra-kit-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/infra-kit-config')>()

  return {
    ...actual,
    getInfraKitConfig: vi.fn(),
  }
})

vi.mock('zx', () => {
  function makeResult(stdout: string) {
    return Object.assign(Promise.resolve({ stdout }), {
      quiet: () => {
        return Promise.resolve({ stdout })
      },
    })
  }

  return {
    $: vi.fn((strings: TemplateStringsArray) => {
      const cmd = strings.join('')

      if (cmd.includes('workspace create')) return makeResult('created workspace:7\n')
      if (cmd.includes('list-pane-surfaces')) return makeResult('surface:12 (active)\n')

      return makeResult('')
    }),
  }
})

// A worktree cwd that is not under a publicly writable directory (avoids the
// sonarjs/publicly-writable-directories lint that flags /tmp paths).
const WORKTREE_CWD = '/home/dev/repo/wt'

type CmuxCall = [TemplateStringsArray, ...string[]]

const allCommands = (): string[] => {
  const calls = vi.mocked($).mock.calls as unknown as CmuxCall[]

  return calls.map((call) => {
    return call[0].join('')
  })
}

const splitCommands = (): string[] => {
  return allCommands().filter((cmd) => {
    return cmd.includes('new-split')
  })
}

const mockLayout = (layout: CmuxLayout): void => {
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    environments: ['dev'],
    envManagement: { provider: 'doppler', config: { name: 'p' } },
    worktrees: { cmux: { layout } },
  } as Awaited<ReturnType<typeof getInfraKitConfig>>)
}

describe('openCmuxWorkspaceWithLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('two-columns layout issues a single right split (no down split)', async () => {
    mockLayout('two-columns')

    await openCmuxWorkspaceWithLayout({ cwd: WORKTREE_CWD })

    const splits = splitCommands()

    expect(
      splits.some((cmd) => {
        return cmd.includes('new-split right')
      }),
    ).toBe(true)
    expect(
      splits.some((cmd) => {
        return cmd.includes('new-split down')
      }),
    ).toBe(false)
    expect(splits).toHaveLength(1)
  })

  it('three-pane layout issues both a right and a down split', async () => {
    mockLayout('three-pane')

    await openCmuxWorkspaceWithLayout({ cwd: WORKTREE_CWD })

    const splits = splitCommands()

    expect(
      splits.some((cmd) => {
        return cmd.includes('new-split right')
      }),
    ).toBe(true)
    expect(
      splits.some((cmd) => {
        return cmd.includes('new-split down')
      }),
    ).toBe(true)
    expect(splits).toHaveLength(2)
  })

  it('renames the workspace when a title is provided', async () => {
    mockLayout('two-columns')

    await openCmuxWorkspaceWithLayout({ cwd: WORKTREE_CWD, title: 'my-title' })

    const calls = vi.mocked($).mock.calls as unknown as CmuxCall[]
    const renameCall = calls.find((call) => {
      return call[0].join('').includes('workspace rename')
    })

    expect(renameCall).toBeDefined()
    // The title is the last interpolated value of `cmux workspace rename … --title ${title}`,
    // so it lands in the final tuple slot — assert on that value, not tuple membership.
    expect(renameCall?.at(-1)).toBe('my-title')
  })
})
