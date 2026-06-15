import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { closeCmuxWorkspaceByTitle } from '../close-workspace-by-title'

const listOutput = vi.hoisted(() => {
  return { value: '' }
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
      return strings.join('').includes('list-workspaces') ? makeResult(listOutput.value) : makeResult('')
    }),
  }
})

type CmuxCall = [TemplateStringsArray, ...string[]]

function isCloseCall(call: CmuxCall): boolean {
  return call[0].join('').includes('close-workspace')
}

const closeCallRef = (): string | undefined => {
  const calls = vi.mocked($).mock.calls as unknown as CmuxCall[]

  return calls.find(isCloseCall)?.[1]
}

describe('closeCmuxWorkspaceByTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listOutput.value = ''
  })

  it('closes a workspace stored under an old v-prefixed title when asked with the bare-semver title', async () => {
    listOutput.value = [
      '  workspace:8  hulyo-monorepo v1.48.0',
      '* workspace:6  obsidian-workspace  [selected]',
      '',
    ].join('\n')

    await closeCmuxWorkspaceByTitle('hulyo-monorepo 1.48.0')

    expect(closeCallRef()).toBe('workspace:8')
  })

  it('does not close anything when no title matches', async () => {
    listOutput.value = '  workspace:8  hulyo-monorepo 2.0.0\n'

    await closeCmuxWorkspaceByTitle('hulyo-monorepo 1.48.0')

    expect(closeCallRef()).toBeUndefined()
  })
})
