import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchOpenPRsByHead,
  fetchPRByHead,
  fetchPRByNumber,
  fetchPRComments,
  fetchPRReviewState,
  fetchPRsByHeadAllStates,
} from '../pr-status'

const zx = vi.hoisted(() => {
  return {
    stdout: '[]',
    error: null as unknown,
    commands: [] as string[],
  }
})

// zx's tagged-template `$`, reconstructed into the shell line it would run so a test can assert
// the exact argv — the `--json` field list is the contract every consumer of these records reads.
vi.mock('zx', () => {
  const $ = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings
      .map((part, i) => {
        return i < values.length ? part + String(values[i]) : part
      })
      .join('')

    zx.commands.push(command)

    return zx.error ? Promise.reject(zx.error) : Promise.resolve({ stdout: zx.stdout, exitCode: 0 })
  })

  return { $ }
})

const RECORD = {
  number: 42,
  state: 'OPEN',
  title: 'Release v1.2.5',
  baseRefName: 'dev',
  headRefName: 'release/v1.2.5',
}

beforeEach(() => {
  zx.stdout = '[]'
  zx.error = null
  zx.commands = []
})

describe('fetchPRByHead', () => {
  it('asks gh for the base and head refs alongside number/state/title, any state, newest only', async () => {
    zx.stdout = JSON.stringify([RECORD])

    await expect(fetchPRByHead('release/v1.2.5')).resolves.toEqual(RECORD)

    expect(zx.commands).toEqual([
      'gh pr list --head release/v1.2.5 --state all --json number,state,title,baseRefName,headRefName --limit 1',
    ])
  })

  it('returns null when the head has never had a PR', async () => {
    await expect(fetchPRByHead('release/v9.9.9')).resolves.toBeNull()
  })
})

describe('fetchOpenPRsByHead', () => {
  it('lists open PRs only, with room for one per base, and returns every record', async () => {
    const toMain = { ...RECORD, number: 43, title: 'Hotfix v1.2.5', baseRefName: 'main' }

    zx.stdout = JSON.stringify([RECORD, toMain])

    await expect(fetchOpenPRsByHead('release/v1.2.5')).resolves.toEqual([RECORD, toMain])

    expect(zx.commands).toEqual([
      'gh pr list --head release/v1.2.5 --state open --limit 5 --json number,state,title,baseRefName,headRefName',
    ])
  })

  it('returns an empty list, not null, when nothing is open on the head', async () => {
    await expect(fetchOpenPRsByHead('release/v1.2.5')).resolves.toEqual([])
  })
})

describe('fetchPRByNumber', () => {
  it('views the PR by number and returns its base and head refs', async () => {
    zx.stdout = JSON.stringify(RECORD)

    await expect(fetchPRByNumber(42)).resolves.toEqual(RECORD)

    expect(zx.commands).toEqual(['gh pr view 42 --json number,state,title,baseRefName,headRefName'])
  })

  it('wraps a gh failure in an OperationError that names the PR', async () => {
    zx.error = new Error('no pull requests found for 404')

    await expect(fetchPRByNumber(404)).rejects.toMatchObject({
      name: 'OperationError',
      operation: 'fetch PR #404',
    })
  })
})

describe('fetchOpenPRsByHead fields', () => {
  it('takes a custom field list in place of the default', async () => {
    await fetchOpenPRsByHead('release/v1.2.5', 'number,body')

    expect(zx.commands).toEqual(['gh pr list --head release/v1.2.5 --state open --limit 5 --json number,body'])
  })
})

describe('fetchPRsByHeadAllStates', () => {
  it('returns newest first whatever order gh answers in', async () => {
    const at = (number: number, createdAt: string) => {
      return { ...RECORD, number, body: '', createdAt }
    }

    zx.stdout = JSON.stringify([
      at(2, '2026-01-02T00:00:00Z'),
      at(1, '2026-01-01T00:00:00Z'),
      at(4, '2026-01-04T00:00:00Z'),
      at(3, '2026-01-03T00:00:00Z'),
    ])

    const prs = await fetchPRsByHeadAllStates('release/v1.2.5')

    expect(
      prs.map((pr) => {
        return pr.number
      }),
    ).toEqual([4, 3, 2, 1])

    expect(zx.commands).toEqual([
      'gh pr list --head release/v1.2.5 --state all --limit 20 --json number,state,title,body,baseRefName,headRefName,createdAt',
    ])
  })
})

describe('fetchPRComments', () => {
  it('returns the comment bodies', async () => {
    zx.stdout = JSON.stringify({ comments: [{ body: 'a', author: {} }, { body: 'b' }] })

    await expect(fetchPRComments(7)).resolves.toEqual(['a', 'b'])

    expect(zx.commands).toEqual(['gh pr view 7 --json comments'])
  })
})

describe('fetchPRReviewState', () => {
  it('returns requested reviewer logins (skipping teams) and the latest reviews', async () => {
    zx.stdout = JSON.stringify({
      reviewRequests: [{ login: 'alice' }, { name: 'team-x' }],
      latestReviews: [{ author: { login: 'bob' }, state: 'APPROVED' }],
    })

    await expect(fetchPRReviewState(7)).resolves.toEqual({
      requestedReviewers: ['alice'],
      latestReviews: [{ login: 'bob', state: 'APPROVED' }],
    })

    expect(zx.commands).toEqual(['gh pr view 7 --json reviewRequests,latestReviews'])
  })
})
