import { beforeEach, describe, expect, it, vi } from 'vitest'

import { pushAtomic } from '../merge-refs'

/**
 * Pre-mortem guard: nothing in the push path may ever rewind a shared ref.
 *
 * The correctness of that property does NOT depend on this test — a non-forced
 * `git push` is fast-forward-only by measurement (see `merge-refs.test.ts`, where
 * one non-fast-forwardable ref among three leaves all three unchanged on origin).
 * This test exists to stop a FUTURE edit from removing the property, because the
 * tempting "fix" for a rejected push is exactly the one that eats a teammate's
 * commit: someone hits `! [rejected]`, reaches for `--force-with-lease`, and a
 * commit disappears from a shared release branch with recovery depending on a
 * reflog that may only exist on the machine that pushed it.
 *
 * It asserts over the reconstructed argv rather than over intent, so it fails on
 * a flag added anywhere in the invocation — including inside a refspec.
 */

const zx = vi.hoisted(() => {
  const commands: string[] = []

  const reconstruct = (strings: TemplateStringsArray, values: unknown[]): string => {
    return strings.reduce((acc, part, i) => {
      const value = values[i]
      const rendered = Array.isArray(value) ? value.join(' ') : String(value ?? '')

      return acc + part + (i < values.length ? rendered : '')
    }, '')
  }

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    commands.push(reconstruct(strings, values))

    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  }

  const dollar = Object.assign(
    (first: unknown, ...rest: unknown[]): unknown => {
      return Array.isArray(first) ? tag(first as unknown as TemplateStringsArray, ...rest) : tag
    },
    { quiet: false },
  )

  return { dollar, commands }
})

vi.mock('zx', () => {
  return { $: zx.dollar }
})

const FORBIDDEN = [/--force\b/, /--force-with-lease/, /(^|\s)-f(\s|$)/, /(^|\s)\+/]

beforeEach(() => {
  zx.commands.length = 0
})

describe('the push path never rewinds a shared ref', () => {
  it('emits no force flag and no +-prefixed refspec', async () => {
    await pushAtomic('/repo', [
      { branch: 'release/v1.2.5', sha: 'aaa' },
      { branch: 'release/v1.2.6', sha: 'bbb' },
    ])

    const pushes = zx.commands.filter((cmd) => {
      return cmd.startsWith('git push')
    })

    expect(pushes).toHaveLength(1)

    for (const pattern of FORBIDDEN) {
      expect(pushes[0]).not.toMatch(pattern)
    }
  })

  it('pushes each ref as an explicit sha:refs/heads/<branch> pair', async () => {
    await pushAtomic('/repo', [{ branch: 'release/v1.2.5', sha: 'aaa' }])

    // Naming the full ref path rather than the short branch removes any chance of
    // the remote resolving the name to something else.
    expect(zx.commands[0]).toBe('git push --atomic origin aaa:refs/heads/release/v1.2.5')
  })

  it('issues no git command at all when there is nothing to push', async () => {
    const result = await pushAtomic('/repo', [])

    expect(zx.commands).toEqual([])
    expect(result.pushed).toBe(false)
  })
})
