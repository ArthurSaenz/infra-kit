import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closePrWithComment,
  compareContains,
  fetchActiveRuns,
  fetchCompareStatus,
  fetchPRMetadata,
  fetchRenamePermissions,
  listOpenPRBodies,
  listOpenPRsByBase,
  openReleasePr,
  retargetPrBase,
} from '../pr-lifecycle'

const zx = vi.hoisted(() => {
  return {
    // First matching prefix wins; a function result may throw to simulate a gh failure.
    responders: [] as { prefix: string; reply: () => string }[],
    commands: [] as string[],
    values: [] as unknown[][],
  }
})

// Arrays are flattened the way zx quotes them (one argv element each); the raw values are kept
// separately so a test can assert a body survives byte-for-byte rather than as shell text.
vi.mock('zx', () => {
  const $ = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings
      .map((part, i) => {
        if (i >= values.length) return part

        const value = values[i]

        return part + (Array.isArray(value) ? value.join(' ') : String(value))
      })
      .join('')

    zx.commands.push(command)
    zx.values.push(values)

    try {
      const responder = zx.responders.find((candidate) => {
        return command.startsWith(candidate.prefix)
      })

      return Promise.resolve({ stdout: responder ? responder.reply() : '' })
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  })

  return { $ }
})

const reply = (prefix: string, stdout: string) => {
  zx.responders.push({
    prefix,
    reply: () => {
      return stdout
    },
  })
}

const notFound = () => {
  throw Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' })
}

beforeEach(() => {
  zx.responders = []
  zx.commands = []
  zx.values = []
})

describe('openReleasePr', () => {
  const base = {
    head: 'release/v1.2.3',
    base: 'dev',
    title: 'Release v1.2.3',
    body: 'b',
    labels: [],
    assignees: [],
    milestone: null,
    draft: false,
  }

  it('omits label, assignee, milestone and draft when empty and parses the PR number', async () => {
    reply('gh pr create', 'https://github.com/o/r/pull/77\n')

    await expect(openReleasePr(base)).resolves.toBe(77)

    expect(zx.commands).toEqual(['gh pr create --title Release v1.2.3 --body b --base dev --head release/v1.2.3'])
  })

  it('adds one flag per label and assignee, plus milestone and draft when set', async () => {
    reply('gh pr create', 'https://github.com/o/r/pull/78')

    await openReleasePr({
      ...base,
      labels: ['a', 'b,c'],
      assignees: ['me'],
      milestone: 'M1',
      draft: true,
    })

    expect(zx.values[0]?.[0]).toEqual([
      '--title',
      'Release v1.2.3',
      '--body',
      'b',
      '--base',
      'dev',
      '--head',
      'release/v1.2.3',
      '--label',
      'a',
      '--label',
      'b,c',
      '--assignee',
      'me',
      '--milestone',
      'M1',
      '--draft',
    ])
  })

  it('passes a multi-line body with backticks and quotes unchanged', async () => {
    reply('gh pr create', 'https://github.com/o/r/pull/79')

    const body = 'line 1\n```ts\nconst a = "x" + \'y\'\n```\n$(rm -rf /) `date`'

    await openReleasePr({ ...base, body })

    expect((zx.values[0]?.[0] as string[])[3]).toBe(body)
  })

  it('throws when gh prints no PR URL', async () => {
    reply('gh pr create', 'something else')

    await expect(openReleasePr(base)).rejects.toThrow('could not read the new PR number')
  })
})

describe('retargetPrBase / closePrWithComment', () => {
  it('edits the base of the PR', async () => {
    await retargetPrBase(5, 'release/v2')

    expect(zx.commands).toEqual(['gh pr edit 5 --base release/v2'])
  })

  it('closes the PR with the comment as one value', async () => {
    await closePrWithComment(5, 'bye `x`')

    expect(zx.commands).toEqual(['gh pr close 5 --comment bye `x`'])
  })
})

describe('fetchPRMetadata', () => {
  it('flattens labels, assignees and milestone', async () => {
    reply(
      'gh pr view',
      JSON.stringify({
        title: 'T',
        body: 'B',
        baseRefName: 'dev',
        isDraft: true,
        labels: [{ name: 'l1' }],
        assignees: [{ login: 'u1' }],
        milestone: { title: 'M' },
      }),
    )

    await expect(fetchPRMetadata(9)).resolves.toEqual({
      title: 'T',
      body: 'B',
      baseRefName: 'dev',
      isDraft: true,
      labels: ['l1'],
      assignees: ['u1'],
      milestone: 'M',
    })

    expect(zx.commands).toEqual(['gh pr view 9 --json title,body,baseRefName,isDraft,labels,assignees,milestone'])
  })

  it('maps a missing milestone to null', async () => {
    reply(
      'gh pr view',
      JSON.stringify({
        title: 'T',
        body: '',
        baseRefName: 'dev',
        isDraft: false,
        labels: [],
        assignees: [],
        milestone: null,
      }),
    )

    await expect(fetchPRMetadata(9)).resolves.toMatchObject({ milestone: null })
  })
})

describe('fetchRenamePermissions', () => {
  it('encodes the slash in both branch names and reads push, protected and rule types', async () => {
    reply('gh api repos/{owner}/{repo} --jq', '{"push":true}')
    reply('gh api repos/{owner}/{repo}/branches/release%2Fv1.2.3 --jq', 'true\n')
    reply('gh api repos/{owner}/{repo}/rules/branches/release%2Fv1.2.3', '[{"type":"deletion"},{"type":"update"}]')
    reply('gh api repos/{owner}/{repo}/rules/branches/release%2Fv1.2.4', '[]')

    await expect(fetchRenamePermissions('release/v1.2.3', 'release/v1.2.4')).resolves.toEqual({
      canPush: true,
      oldProtected: true,
      oldRules: ['deletion', 'update'],
      newRules: [],
    })

    expect(zx.commands).toEqual([
      'gh api repos/{owner}/{repo} --jq .permissions',
      'gh api repos/{owner}/{repo}/branches/release%2Fv1.2.3 --jq .protected',
      'gh api repos/{owner}/{repo}/rules/branches/release%2Fv1.2.3',
      'gh api repos/{owner}/{repo}/rules/branches/release%2Fv1.2.4',
    ])
  })

  it('treats a 404 on the branch and rules endpoints as unprotected, not an error', async () => {
    zx.responders.push({
      prefix: 'gh api repos/{owner}/{repo} --jq',
      reply: () => {
        return '{"push":false}'
      },
    })
    zx.responders.push({ prefix: 'gh api repos/{owner}/{repo}/branches', reply: notFound })
    zx.responders.push({ prefix: 'gh api repos/{owner}/{repo}/rules', reply: notFound })

    await expect(fetchRenamePermissions('release/v1.2.3', 'release/v1.2.4')).resolves.toEqual({
      canPush: false,
      oldProtected: false,
      oldRules: [],
      newRules: [],
    })
  })

  it('rethrows a failure that is not a 404', async () => {
    zx.responders.push({
      prefix: 'gh api repos/{owner}/{repo} --jq',
      reply: () => {
        throw Object.assign(new Error('boom'), { stderr: 'HTTP 500' })
      },
    })

    await expect(fetchRenamePermissions('a', 'b')).rejects.toThrow('boom')
  })
})

describe('fetchActiveRuns', () => {
  it('keeps queued, in_progress and waiting runs and drops completed ones', async () => {
    const runs = [
      { status: 'completed', workflowName: 'ci', databaseId: 1 },
      { status: 'queued', workflowName: 'ci', databaseId: 2 },
      { status: 'in_progress', workflowName: 'deploy', databaseId: 3 },
      { status: 'waiting', workflowName: 'deploy', databaseId: 4 },
    ]

    reply('gh run list', JSON.stringify(runs))

    await expect(fetchActiveRuns('release/v1')).resolves.toEqual(runs.slice(1))

    expect(zx.commands).toEqual(['gh run list --branch release/v1 --json status,workflowName,databaseId --limit 50'])
  })
})

describe('compareContains', () => {
  it.each([
    ['identical', true],
    ['ahead', true],
    ['behind', false],
    ['diverged', false],
  ])('maps %s to %s', async (status, expected) => {
    reply('gh api', `${status}\n`)

    await expect(compareContains('aaa', 'bbb')).resolves.toBe(expected)

    expect(zx.commands).toEqual(['gh api repos/{owner}/{repo}/compare/aaa...bbb --jq .status'])
  })

  it('exposes the raw status for callers that tell diverged from behind', async () => {
    reply('gh api', 'diverged\n')

    await expect(fetchCompareStatus('aaa', 'bbb')).resolves.toBe('diverged')
  })
})

describe('list probes', () => {
  it('lists open PR bodies', async () => {
    reply('gh pr list', '[{"number":1,"headRefName":"h","body":"b"}]')

    await expect(listOpenPRBodies()).resolves.toEqual([{ number: 1, headRefName: 'h', body: 'b' }])

    expect(zx.commands).toEqual(['gh pr list --state open --limit 200 --json number,headRefName,body'])
  })

  it('lists open PRs by base', async () => {
    reply('gh pr list', '[{"number":2,"headRefName":"feat"}]')

    await expect(listOpenPRsByBase('release/v1')).resolves.toEqual([{ number: 2, headRefName: 'feat' }])

    expect(zx.commands).toEqual(['gh pr list --base release/v1 --state open --json number,headRefName'])
  })
})
