import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultProbeDeps } from 'src/lib/dependency-probe'
import { resetZxFactoryArgs, zxFactoryArgs } from 'src/lib/quiet-shell/__tests__/zx-shell-mock'

/**
 * The production wiring, which `dependency-probe.test.ts` deliberately never exercises — that suite
 * injects fixtures precisely so it never shells out.
 *
 * What is pinned here is the property that was BROKEN in the field: this module asks possibly-absent
 * binaries what version they are, so every one of its zx calls has to capture the child's output rather
 * than let zx relay it. A test that only checked the parsed result would pass just as happily against
 * the version that printed `/bin/bash: portless: command not found` into the user's terminal.
 */
vi.mock('zx', async () => {
  const { zxShellMock } = await import('src/lib/quiet-shell/__tests__/zx-shell-mock')

  return zxShellMock((_strings, command) => {
    if (command[0] === 'command') return Promise.resolve({ stdout: '/usr/local/bin/aws\n', stderr: '' })

    // `aws --version` writes its banner to STDERR, which is why `runCommand` concatenates the streams.
    return Promise.resolve({ stdout: '', stderr: 'aws-cli/2.17.0 Python/3.11.6\n' })
  })
})

beforeEach(() => {
  resetZxFactoryArgs()
})

describe('defaultProbeDeps runs every probe through a capturing shell', () => {
  it('configures zx quiet for a version probe', async () => {
    await defaultProbeDeps().runCommand(['aws', '--version'])

    expect(zxFactoryArgs).toEqual([{ quiet: true }])
  })

  it('configures zx quiet for the `command -v` resolver, which is the one that hits absent binaries', async () => {
    await defaultProbeDeps().resolveBinPath('aws')

    expect(zxFactoryArgs).toEqual([{ quiet: true }])
  })
})

describe('what the probe reads back', () => {
  it('keeps the child’s stderr, without which every aws version parse returns null', async () => {
    const result = await defaultProbeDeps().runCommand(['aws', '--version'])

    expect(result.stdout).toContain('aws-cli/2.17.0')
  })

  it('resolves a binary through the shell’s PATH rather than guessing at directories', async () => {
    await expect(defaultProbeDeps().resolveBinPath('aws')).resolves.toBe('/usr/local/bin/aws')
  })
})
