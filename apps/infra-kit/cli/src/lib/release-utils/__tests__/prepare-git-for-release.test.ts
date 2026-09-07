import { beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { expectRejection } from 'src/lib/errors/__tests__/expect-rejection'
import { OperationError } from 'src/lib/errors/operation-error'

import { prepareGitForRelease } from '../release-utils'

const HEAD_SHA = 'f'.repeat(40)

const state = vi.hoisted(() => {
  return {
    commands: [] as string[],
    /** Substring -> outcome. `throws` rejects; a non-zero exitCode rejects unless `nothrow`. */
    overrides: [] as { match: string; stdout?: string; exitCode?: number; throws?: boolean }[],
    head: 'f'.repeat(40),
  }
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()
  // Imported INSIDE the factory, not at module scope. This file also imports `$` from 'zx' (the
  // assertions below read `$.quiet`), so the factory runs while the module's own imports are still
  // in their temporal dead zone — a top-level import of the helper is unreachable from here.
  const { zxCommandMock } = await import('src/lib/git-utils/__tests__/zx-command-mock')

  const $fn = zxCommandMock((command) => {
    state.commands.push(command)

    const override = state.overrides.find((entry) => {
      return command.includes(entry.match)
    })

    if (override) {
      return override.throws
        ? { throws: Object.assign(new Error('git failed'), { stderr: 'fatal: authentication failed' }) }
        : override
    }

    if (command.includes('git rev-parse HEAD')) return { stdout: state.head }

    return {}
  })

  // `quiet` is a real property on zx's `$`; the assertions below read it to prove the code never
  // writes to the shared instance.
  return { ...actual, $: Object.assign($fn, { quiet: false }) }
})

describe('prepareGitForRelease', () => {
  beforeEach(() => {
    state.commands = []
    state.overrides = []
    state.head = HEAD_SHA
    ;($ as unknown as { quiet: boolean }).quiet = false
  })

  it('fetches, switches, then pulls the base branch in that order', async () => {
    await prepareGitForRelease('regular')

    const at = (needle: string) => {
      return state.commands.findIndex((command) => {
        return command.includes(needle)
      })
    }

    expect(at('git fetch origin')).toBeLessThan(at('git switch dev'))
    expect(at('git switch dev')).toBeLessThan(at('git pull'))
  })

  // Without --ff-only a drifted local base is MERGED instead of refused, writing a merge commit
  // onto dev/main in the operator's own checkout and rooting the release in it.
  it('pulls with --ff-only', async () => {
    await prepareGitForRelease('regular')

    expect(
      state.commands.some((command) => {
        return command.includes('git pull --ff-only origin dev')
      }),
    ).toBe(true)
  })

  it('uses main as the base for a hotfix', async () => {
    await prepareGitForRelease('hotfix')

    expect(state.commands).toContain('git switch main')
  })

  // The SHA is the caller's proof that the checkout it verified is still the one it mutates.
  it('returns the SHA the base branch landed on', async () => {
    await expect(prepareGitForRelease('regular')).resolves.toBe(HEAD_SHA)
  })

  // A long-lived MCP server shares one `$`; silencing it globally would mute a concurrent tool call
  // that never asked for quiet. The FAILURE path is the one that matters: the old code set the
  // global and cleared it only after its last successful statement, so a success-path assertion
  // alone holds on the buggy version too and proves nothing.
  it.each([
    ['succeeds', [] as typeof state.overrides],
    ['fails', [{ match: 'git pull', throws: true }]],
  ])('never touches the global $.quiet when the pull %s', async (_case, overrides) => {
    state.overrides = overrides

    await prepareGitForRelease('regular').catch(() => {
      return undefined
    })

    expect(($ as unknown as { quiet: boolean }).quiet).toBe(false)
  })

  // `git rev-list --left-right --count origin/dev...dev` prints LEFT then RIGHT: left is what
  // origin has and we do not (behind), right is what we have and origin does not (ahead).
  // Transposing them is the single easiest error on this path, so it is asserted by value.
  it('reports ahead and behind the right way round', async () => {
    state.overrides = [
      { match: 'git pull', throws: true },
      { match: 'git rev-list', stdout: '3\t2' },
    ]

    const error = await expectRejection(prepareGitForRelease('regular'))

    expect(error.message).toContain('2 commit(s) ahead and 3 behind')
  })

  // buildMessage gives an explicit stderrExcerpt priority over the cause, so attaching one
  // unconditionally would overwrite git's own text on failures that are not divergence at all.
  it('lets git speak for itself when the branches have not diverged', async () => {
    state.overrides = [
      { match: 'git pull', throws: true },
      { match: 'git rev-list', stdout: '0\t0' },
    ]

    const error = await expectRejection(prepareGitForRelease('regular'))

    expect(error.message).toContain('authentication failed')
    expect(error.message).not.toContain('0 commit(s) ahead')
    expect(error.remediation).toContain('access to origin')
  })

  // The probe exists only to enrich the refusal. If it throws in turn, the accurate
  // "your base has diverged" error would be replaced by an error about counting commits.
  it('still reports the pull failure when the divergence probe itself fails', async () => {
    state.overrides = [
      { match: 'git pull', throws: true },
      { match: 'git rev-list', exitCode: 128 },
    ]

    const error = await expectRejection(prepareGitForRelease('regular'))

    expect(error).toBeInstanceOf(OperationError)
    expect(error.operation).toContain('fast-forward dev')
  })
})
