import { beforeEach, describe, expect, it, vi } from 'vitest'

import { quietShell } from 'src/lib/quiet-shell'

import { resetZxFactoryArgs, zxFactoryArgs } from './zx-shell-mock'

/**
 * The one assertion this module exists for.
 *
 * zx forwards a child's STDERR to the parent's by default, so a probe of an absent binary printed
 * `/bin/bash: <name>: command not found` into the terminal of every `setup` and `doctor` run. `quiet`
 * is the whole fix, and a mock that answers a bare tag and a configured tag identically would stay
 * green after someone deleted it — so what is checked here is that the OPTION reached zx, not that the
 * call resolved.
 */
vi.mock('zx', async () => {
  const { zxShellMock } = await import('./zx-shell-mock')

  return zxShellMock(() => {
    return Promise.resolve({ stdout: 'v1.2.3', stderr: '' })
  })
})

beforeEach(() => {
  resetZxFactoryArgs()
})

describe('quietShell', () => {
  it('configures zx to capture the child’s output instead of relaying it', async () => {
    await quietShell()`${['node', '--version']}`

    expect(zxFactoryArgs).toEqual([{ quiet: true }])
  })

  it('is built per call, so no zx invocation happens at import time', () => {
    // At module scope `$({ … })` fires on IMPORT — inside every suite that mocks `zx` anywhere in the
    // graph, before that suite's own fixtures exist. Importing this module must configure nothing.
    expect(zxFactoryArgs).toEqual([])
  })

  it('still hands back the child’s streams, which is what the version probes read', async () => {
    const result = await quietShell()`${['node', '--version']}`

    expect(result).toMatchObject({ stdout: 'v1.2.3' })
  })
})
