import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listCmuxWorkspaceTitles } from '../list-workspace-titles'

const listOutput = vi.hoisted(() => {
  return { value: '' }
})

vi.mock('zx', () => {
  function makeResult() {
    return Object.assign(Promise.resolve({ stdout: listOutput.value }), {
      quiet: () => {
        return Promise.resolve({ stdout: listOutput.value })
      },
    })
  }

  return {
    $: vi.fn(makeResult),
  }
})

describe('listCmuxWorkspaceTitles', () => {
  beforeEach(() => {
    listOutput.value = ''
  })

  it('parses titles, stripping the [selected] suffix and leading * marker', async () => {
    listOutput.value = [
      '  workspace:8  hulyo-monorepo 1.48.0',
      '* workspace:6  obsidian-workspace  [selected]',
      '',
    ].join('\n')

    const titles = await listCmuxWorkspaceTitles()

    expect(titles.has('hulyo-monorepo 1.48.0')).toBe(true)
    expect(titles.has('obsidian-workspace')).toBe(true)
  })

  it('canonicalizes a v-prefixed (old CLI) stored title to the bare-semver key', async () => {
    listOutput.value = '  workspace:8  hulyo-monorepo v1.48.0\n'

    const titles = await listCmuxWorkspaceTitles()

    expect(titles.has('hulyo-monorepo 1.48.0')).toBe(true)
    expect(titles.has('hulyo-monorepo v1.48.0')).toBe(false)
  })

  it('collapses extra internal whitespace into the canonical key', async () => {
    listOutput.value = '  workspace:3  hulyo-monorepo    1.48.0\n'

    const titles = await listCmuxWorkspaceTitles()

    expect(titles.has('hulyo-monorepo 1.48.0')).toBe(true)
  })

  it('returns an empty set when cmux output is empty', async () => {
    listOutput.value = ''

    const titles = await listCmuxWorkspaceTitles()

    expect(titles.size).toBe(0)
  })
})
