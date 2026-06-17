import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quote } from 'zx'

import { createReleaseBranch, getReleasePRs, getReleasePRsWithInfo } from '../gh-release-prs'

interface FakePR {
  number: number
  title: string
  headRefName: string
  state: string
  baseRefName: string
  createdAt: string
}

const responses = vi.hoisted(() => {
  return {
    release: [] as FakePR[],
    hotfix: [] as FakePR[],
    calls: [] as { strings: string[]; values: unknown[] }[],
  }
})

// Mock zx's tagged-template `$`: the gh pr list call for `--base dev` returns
// the "release" set, `--base main` returns the "hotfix" set, and `gh pr create`
// returns a fake PR URL. Every invocation is captured (template strings +
// interpolated values) so tests can reconstruct the exact command zx would run.
// Spreading `...actual` keeps zx's real `quote` available for that reconstruction.
vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const command = strings.join('')

      responses.calls.push({ strings: [...strings], values })

      if (command.includes('gh pr create')) {
        return Promise.resolve({ stdout: 'https://github.com/acme/repo/pull/123' })
      }

      if (command.includes('--base main')) {
        return Promise.resolve({ stdout: JSON.stringify(responses.hotfix) })
      }

      return Promise.resolve({ stdout: JSON.stringify(responses.release) })
    }),
  }
})

const pr = (overrides: Partial<FakePR> & Pick<FakePR, 'headRefName' | 'createdAt'>): FakePR => {
  return {
    number: 1,
    title: 'Release',
    state: 'OPEN',
    baseRefName: 'dev',
    ...overrides,
  }
}

describe('getReleasePRs (discovery + sort)', () => {
  beforeEach(() => {
    responses.release = []
    responses.hotfix = []
  })

  it('sorts version branches first by semver ascending (numeric, 1.9.0 < 1.10.0), then names by createdAt', async () => {
    responses.release = [
      pr({ headRefName: 'release/zeta-feature', createdAt: '2026-01-10T00:00:00Z', title: 'Release zeta-feature' }),
      pr({ headRefName: 'release/v1.10.0', createdAt: '2026-01-02T00:00:00Z' }),
      pr({ headRefName: 'release/alpha-feature', createdAt: '2026-01-05T00:00:00Z', title: 'Release alpha-feature' }),
      pr({ headRefName: 'release/v1.9.0', createdAt: '2026-01-01T00:00:00Z' }),
    ]

    await expect(getReleasePRs()).resolves.toEqual([
      'release/v1.9.0',
      'release/v1.10.0',
      'release/alpha-feature',
      'release/zeta-feature',
    ])
  })

  it('filters out unparseable junk branches instead of throwing or NaN-sorting', async () => {
    responses.release = [
      pr({ headRefName: 'release/Bad_Name', createdAt: '2026-01-01T00:00:00Z' }),
      pr({ headRefName: 'release/v1.2.3', createdAt: '2026-01-02T00:00:00Z' }),
      pr({ headRefName: 'totally-not-a-release', createdAt: '2026-01-03T00:00:00Z' }),
      pr({
        headRefName: 'release/checkout-redesign',
        createdAt: '2026-01-04T00:00:00Z',
        title: 'Release checkout-redesign',
      }),
    ]

    await expect(getReleasePRs()).resolves.toEqual(['release/v1.2.3', 'release/checkout-redesign'])
  })

  it('merges hotfix (base main) and release (base dev) sets', async () => {
    responses.release = [pr({ headRefName: 'release/v2.0.0', createdAt: '2026-01-01T00:00:00Z' })]
    responses.hotfix = [
      pr({
        headRefName: 'release/v1.9.9',
        createdAt: '2026-01-02T00:00:00Z',
        baseRefName: 'main',
        title: 'Hotfix v1.9.9',
      }),
    ]

    await expect(getReleasePRs()).resolves.toEqual(['release/v1.9.9', 'release/v2.0.0'])
  })
})

describe('getReleasePRsWithInfo (discovery + sort)', () => {
  beforeEach(() => {
    responses.release = []
    responses.hotfix = []
  })

  it('returns branch/title/createdAt in the locked order with junk filtered', async () => {
    responses.release = [
      pr({ headRefName: 'release/beta-feature', createdAt: '2026-02-02T00:00:00Z', title: 'Release beta-feature' }),
      pr({ headRefName: 'release/Bad_Name', createdAt: '2026-02-03T00:00:00Z', title: 'Release Bad_Name' }),
      pr({ headRefName: 'release/v3.1.0', createdAt: '2026-02-01T00:00:00Z', title: 'Release v3.1.0' }),
    ]

    await expect(getReleasePRsWithInfo()).resolves.toEqual([
      { branch: 'release/v3.1.0', title: 'Release v3.1.0', createdAt: '2026-02-01T00:00:00Z' },
      { branch: 'release/beta-feature', title: 'Release beta-feature', createdAt: '2026-02-02T00:00:00Z' },
    ])
  })
})

describe('createReleaseBranch (gh pr create title quoting)', () => {
  beforeEach(() => {
    responses.calls = []
  })

  // Rebuild the exact command zx would have run: interleave each template
  // string with the zx-quoted form of its interpolated value. This reflects
  // what the shell actually receives, including zx's ANSI-C `$'...'` escaping
  // for values containing spaces.
  const reconstruct = (call: { strings: string[]; values: unknown[] }): string => {
    return call.strings
      .map((part, i) => {
        return i < call.values.length ? part + quote(String(call.values[i])) : part
      })
      .join('')
  }

  const findCreateCommand = (): string => {
    const call = responses.calls.find((c) => {
      return c.strings.join('').includes('gh pr create')
    })

    if (!call) throw new Error('gh pr create was not invoked')

    return reconstruct(call)
  }

  // Run the reconstructed command through a real shell with `gh pr create`
  // replaced by a function that prints back the value the shell parsed for
  // `--title`. This is the behavioral proof of what gh would receive.
  const shellTitleArg = (command: string): string => {
    const probe = command.replace(
      'gh pr create',
      'f(){ while [ "$#" -gt 0 ]; do if [ "$1" = "--title" ]; then printf %s "$2"; return 0; fi; shift; done; }; f',
    )

    // Absolute path (not PATH-resolved) keeps the lint's command-injection guard happy.
    return execFileSync('/bin/sh', ['-c', probe]).toString()
  }

  it("delivers a spaced title to gh as the literal string, with no $'...' corruption", async () => {
    const id = { kind: 'version', semver: { major: 1, minor: 89, patch: 1 }, raw: '1.89.1' } as const

    await createReleaseBranch({ id, jiraVersionUrl: 'https://jira.example/v1.89.1', type: 'hotfix' })

    const command = findCreateCommand()

    // Behavioral: the shell parses --title to exactly the intended title.
    expect(shellTitleArg(command)).toBe('Hotfix v1.89.1')
    // The pre-fix bug wrapped zx's `$'...'` token in literal double quotes, so
    // the shell passed the literal `$'Hotfix v1.89.1'` to gh. That marker must be absent.
    expect(command).not.toContain('"$\'')
  })

  it('delivers a named release title to gh as the literal string', async () => {
    const id = { kind: 'name', name: 'checkout-redesign', raw: 'checkout-redesign' } as const

    await createReleaseBranch({ id, jiraVersionUrl: 'https://jira.example/checkout-redesign', type: 'regular' })

    const command = findCreateCommand()

    expect(shellTitleArg(command)).toBe('Release checkout-redesign')
    expect(command).not.toContain('"$\'')
  })
})
