import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildCliBundle } from 'src/__tests__/helpers/build-cli-bundle'

import { isReadOnlyGhCall, makeReleaseRenameFixture } from './helpers/release-rename-fixture'
import type { ReleaseRenameFixture } from './helpers/release-rename-fixture'

/**
 * @fileoverview
 * Proves the release-rename harness itself, before any handler exists: the fakes answer the exact argv
 * `src/integrations/gh/pr-status.ts` and `pr-lifecycle.ts` build, mutate state only on writes, read refs
 * from the bare origin, fail loudly on holes, and the spawned CLI really runs against them with a
 * scrubbed env.
 */

const RELEASE = 'release/v1.2.0'
const PR_FIELDS = 'number,state,title,baseRefName,headRefName'

const parse = (stdout: string): unknown => {
  return JSON.parse(stdout) as unknown
}

let fixture: ReleaseRenameFixture
let outDir = ''
let cliPath = ''

beforeAll(async () => {
  const built = await buildCliBundle('release-rename-fixture-')

  outDir = built.outDir
  cliPath = built.cliPath
  fixture = await makeReleaseRenameFixture({ cliPath, worktree: true })
}, 90_000)

afterAll(async () => {
  await fixture?.cleanup()
  if (outDir) rmSync(outDir, { force: true, recursive: true })
})

describe('fake gh: read helpers', () => {
  it('answers fetchOpenPRsByHead / fetchPRByHead / fetchPRByNumber with only the requested fields', () => {
    const open = fixture.gh(['pr', 'list', '--head', RELEASE, '--state', 'open', '--limit', '5', '--json', PR_FIELDS])

    expect(open.code).toBe(0)
    expect(parse(open.stdout)).toStrictEqual([
      { number: 1, state: 'OPEN', title: 'Release v1.2.0', baseRefName: 'dev', headRefName: RELEASE },
    ])

    const byHead = fixture.gh(['pr', 'list', '--head', RELEASE, '--state', 'all', '--json', PR_FIELDS, '--limit', '1'])

    expect(parse(byHead.stdout)).toHaveLength(1)

    const byNumber = fixture.gh(['pr', 'view', '1', '--json', PR_FIELDS])

    expect(parse(byNumber.stdout)).toStrictEqual({
      number: 1,
      state: 'OPEN',
      title: 'Release v1.2.0',
      baseRefName: 'dev',
      headRefName: RELEASE,
    })
  })

  it('answers fetchPRMetadata, fetchPRComments and fetchPRReviewState in gh object shapes', () => {
    const metadata = parse(
      fixture.gh(['pr', 'view', '1', '--json', 'title,body,baseRefName,isDraft,labels,assignees,milestone']).stdout,
    ) as Record<string, unknown>

    expect(metadata).toMatchObject({
      title: 'Release v1.2.0',
      baseRefName: 'dev',
      isDraft: false,
      labels: [{ name: 'release' }],
      assignees: [{ login: 'fixture-dev' }],
      milestone: null,
    })
    expect(metadata.body).toContain(`/versions/${fixture.jiraVersionId}/`)
    expect(parse(fixture.gh(['pr', 'view', '1', '--json', 'comments']).stdout)).toStrictEqual({ comments: [] })
    expect(parse(fixture.gh(['pr', 'view', '1', '--json', 'reviewRequests,latestReviews']).stdout)).toStrictEqual({
      reviewRequests: [{ login: 'reviewer-a' }],
      latestReviews: [{ author: { login: 'reviewer-b' }, state: 'APPROVED' }],
    })
  })

  it('filters by --base and --state and lists newest first (fetchPRsByHeadAllStates, listOpenPRsByBase, discovery)', () => {
    fixture.recreateBranchOnOrigin('feature/child', fixture.originSha(RELEASE)!)
    fixture.pushAsTeammate('feature/child')

    const child = fixture.addPr({ headRefName: 'feature/child', baseRefName: RELEASE })

    const older = fixture.addPr({
      headRefName: RELEASE,
      baseRefName: 'dev',
      state: 'CLOSED',
      createdAt: '2026-09-01T00:00:00Z',
    })

    const all = parse(
      fixture.gh([
        'pr',
        'list',
        '--head',
        RELEASE,
        '--state',
        'all',
        '--limit',
        '20',
        '--json',
        'number,state,title,body,baseRefName,headRefName,createdAt',
      ]).stdout,
    ) as { number: number }[]

    expect(
      all.map((pr) => {
        return pr.number
      }),
    ).toStrictEqual([1, older])

    expect(
      parse(fixture.gh(['pr', 'list', '--base', RELEASE, '--state', 'open', '--json', 'number,headRefName']).stdout),
    ).toStrictEqual([{ number: child, headRefName: 'feature/child' }])

    const discovery = parse(
      fixture.gh([
        'pr',
        'list',
        '--limit',
        '200',
        '--base',
        'dev',
        '--json',
        'number,title,headRefName,state,baseRefName,createdAt',
      ]).stdout,
    ) as { number: number }[]

    expect(
      discovery.map((pr) => {
        return pr.number
      }),
    ).toStrictEqual([1])

    const bodies = parse(
      fixture.gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,body']).stdout,
    ) as { number: number }[]

    expect(
      bodies
        .map((pr) => {
          return pr.number
        })
        .toSorted(),
    ).toStrictEqual([1, child])
  })

  it('answers fetchRenamePermissions and fetchActiveRuns', () => {
    const encoded = encodeURIComponent(RELEASE)

    expect(parse(fixture.gh(['api', 'repos/{owner}/{repo}', '--jq', '.permissions']).stdout)).toMatchObject({
      push: true,
    })
    expect(fixture.gh(['api', `repos/{owner}/{repo}/branches/${encoded}`, '--jq', '.protected']).stdout.trim()).toBe(
      'false',
    )

    fixture.setProtected(RELEASE, true)
    fixture.setRules('release/v1.3.0', ['creation'])

    expect(fixture.gh(['api', `repos/{owner}/{repo}/branches/${encoded}`, '--jq', '.protected']).stdout.trim()).toBe(
      'true',
    )
    expect(
      parse(fixture.gh(['api', `repos/{owner}/{repo}/rules/branches/${encodeURIComponent('release/v1.3.0')}`]).stdout),
    ).toStrictEqual([{ type: 'creation' }])

    fixture.setProtected(RELEASE, false)
    fixture.addRun({ headBranch: RELEASE, status: 'in_progress' })

    expect(
      parse(
        fixture.gh(['run', 'list', '--branch', RELEASE, '--json', 'status,workflowName,databaseId', '--limit', '50'])
          .stdout,
      ),
    ).toStrictEqual([{ status: 'in_progress', workflowName: 'deploy-all', databaseId: 9001 }])
  })
})

describe('fake gh: refs come from the bare origin', () => {
  const compare = (base: string, head: string): string => {
    return fixture.gh(['api', `repos/{owner}/{repo}/compare/${base}...${head}`, '--jq', '.status']).stdout.trim()
  }

  it('reports identical / ahead / behind / diverged against real commits', () => {
    const tip = fixture.originSha(RELEASE)!
    const dev = fixture.originSha('dev')!

    fixture.recreateBranchOnOrigin('scratch/a', tip)

    const diverged = fixture.pushAsTeammate('scratch/b', { ancestorOf: dev })

    expect(compare(tip, tip)).toBe('identical')
    expect(compare(dev, tip)).toBe('ahead')
    expect(compare(tip, dev)).toBe('behind')
    expect(compare('scratch/a', diverged)).toBe('diverged')
  })

  it('answers a missing branch with the HTTP 404 shape', () => {
    const missing = fixture.gh(['api', `repos/{owner}/{repo}/branches/${encodeURIComponent('release/nope')}`])

    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('HTTP 404')
  })
})

describe('fake gh: writes', () => {
  it('pr create / pr edit --base / pr close --comment mutate state and are the only calls flagged mutating', () => {
    const tip = fixture.originSha(RELEASE)!

    fixture.recreateBranchOnOrigin('release/v1.3.0', tip)

    const callsBefore = fixture.ghLog().length

    const created = fixture.gh([
      'pr',
      'create',
      '--title',
      'Release v1.3.0',
      '--body',
      'body',
      '--base',
      'dev',
      '--head',
      'release/v1.3.0',
      '--label',
      'a,b',
      '--assignee',
      'fixture-dev',
      '--draft',
    ])

    expect(created.code, created.stderr).toBe(0)

    const number = Number(/\/pull\/(\d+)\s*$/.exec(created.stdout.trim())![1])

    const pr = fixture.ghState().prs.find((candidate) => {
      return candidate.number === number
    })!

    expect(pr).toMatchObject({ state: 'OPEN', isDraft: true, labels: [{ name: 'a,b' }], headRefName: 'release/v1.3.0' })
    expect(Date.parse(pr.createdAt)).toBeGreaterThan(
      Math.max(
        ...fixture
          .ghState()
          .prs.filter((other) => {
            return other.number !== number
          })
          .map((other) => {
            return Date.parse(other.createdAt)
          }),
      ),
    )

    const child = fixture.ghState().prs.find((candidate) => {
      return candidate.baseRefName === RELEASE
    })!

    expect(fixture.gh(['pr', 'edit', String(child.number), '--base', 'release/v1.3.0']).code).toBe(0)
    expect(fixture.gh(['pr', 'close', '1', '--comment', `Superseded by #${number}`]).code).toBe(0)

    const after = fixture.ghState()

    expect(
      after.prs.find((candidate) => {
        return candidate.number === child.number
      })!.baseRefName,
    ).toBe('release/v1.3.0')
    expect(
      after.prs.find((candidate) => {
        return candidate.number === 1
      }),
    ).toMatchObject({
      state: 'CLOSED',
      comments: [{ body: `Superseded by #${number}` }],
    })
    expect(
      fixture
        .ghLog()
        .slice(callsBefore)
        .filter((argv) => {
          return !isReadOnlyGhCall(argv)
        })
        .map((argv) => {
          return argv.slice(0, 2).join(' ')
        }),
    ).toStrictEqual(['pr create', 'pr edit', 'pr close'])
  })

  it('classifies the AC 1 allowlist exactly', () => {
    expect(isReadOnlyGhCall(['--version'])).toBe(true)
    expect(isReadOnlyGhCall(['auth', 'status'])).toBe(true)
    expect(isReadOnlyGhCall(['pr', 'list', '--head', RELEASE])).toBe(true)
    expect(isReadOnlyGhCall(['pr', 'view', '1', '--json', 'comments'])).toBe(true)
    expect(isReadOnlyGhCall(['run', 'list', '--branch', RELEASE])).toBe(true)
    expect(isReadOnlyGhCall(['api', 'repos/{owner}/{repo}'])).toBe(true)
    expect(isReadOnlyGhCall(['api', 'repos/{owner}/{repo}', '--jq', '.permissions'])).toBe(true)
    expect(isReadOnlyGhCall(['api', 'repos/{owner}/{repo}/git/refs', '-X', 'POST'])).toBe(false)
    expect(isReadOnlyGhCall(['api', '-XDELETE', 'repos/{owner}/{repo}/git/refs/heads/x'])).toBe(false)
    expect(isReadOnlyGhCall(['api', 'repos/{owner}/{repo}/pulls', '-f', 'title=x'])).toBe(false)
    expect(isReadOnlyGhCall(['api', 'graphql', '--jq', '.data'])).toBe(false)
    expect(isReadOnlyGhCall(['pr', 'edit', '1', '--base', 'dev'])).toBe(false)
    expect(isReadOnlyGhCall(['workflow', 'run', 'deploy-all.yml'])).toBe(false)
  })

  it('fails loudly and logs an unknown invocation', () => {
    const unknown = fixture.gh(['repo', 'view', '--json', 'name'])
    const apiWrite = fixture.gh(['api', 'repos/{owner}/{repo}/git/refs', '-X', 'POST'])
    const unknownJq = fixture.gh(['api', 'repos/{owner}/{repo}', '--jq', '.full_name'])

    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('fake gh: unhandled invocation')
    expect(apiWrite.code).not.toBe(0)
    expect(unknownJq.code).not.toBe(0)
    expect(fixture.ghUnhandled()).toStrictEqual([
      ['repo', 'view', '--json', 'name'],
      ['api', 'repos/{owner}/{repo}/git/refs', '-X', 'POST'],
      ['api', 'repos/{owner}/{repo}', '--jq', '.full_name'],
    ])
    expect(fixture.ghLog()).toContainEqual(['repo', 'view', '--json', 'name'])
  })

  it('failOn once fails the first match without mutating, then succeeds', () => {
    fixture.failGhOn('pr edit 1 --title', { once: true })

    const first = fixture.gh(['pr', 'edit', '1', '--title', 'Renamed'])

    expect(first.code).toBe(1)
    expect(first.stderr).toContain('injected failure')
    expect(
      fixture.ghState().prs.find((pr) => {
        return pr.number === 1
      })!.title,
    ).toBe('Release v1.2.0')
    expect(fixture.ghState().failOn).toStrictEqual([])
    expect(fixture.gh(['pr', 'edit', '1', '--title', 'Renamed']).code).toBe(0)
    expect(
      fixture.ghState().prs.find((pr) => {
        return pr.number === 1
      })!.title,
    ).toBe('Renamed')

    fixture.patchPr(1, { title: 'Release v1.2.0' })
  })

  it('onGhCall runs its argv before the matching call is answered, once', () => {
    const sha = fixture.originSha(RELEASE)!
    const branchApi = ['api', 'repos/{owner}/{repo}/branches/side-effect', '--jq', '.protected']

    fixture.onGhCall(
      'branches/side-effect',
      ['/usr/bin/git', '--git-dir', fixture.originDir, 'update-ref', 'refs/heads/side-effect', sha],
      { once: true },
    )

    // The branch did not exist before the call, so a found answer proves the effect ran first.
    expect(fixture.gh(branchApi)).toMatchObject({ code: 0, stdout: 'false\n' })
    expect(fixture.ghState().onCall).toStrictEqual([])

    spawnSync('/usr/bin/git', ['--git-dir', fixture.originDir, 'update-ref', '-d', 'refs/heads/side-effect'], {
      env: fixture.env,
    })

    expect(fixture.gh(branchApi).code).toBe(1)
  })
})

describe('origin: server-side ref rejection', () => {
  const push = (refspec: string[]): number | null => {
    return spawnSync('/usr/bin/git', ['push', '-q', 'origin', ...refspec], { cwd: fixture.repoDir, env: fixture.env })
      .status
  }

  it('rejects exactly the configured create / delete until cleared', () => {
    const sha = fixture.originSha(RELEASE)!

    fixture.rejectOnOrigin('create', 'refs/heads/hook-probe')

    expect(push([`${sha}:refs/heads/hook-probe`])).not.toBe(0)
    expect(fixture.originSha('hook-probe')).toBeNull()
    expect(push([`${sha}:refs/heads/hook-other`])).toBe(0)

    fixture.clearOriginRejections()

    expect(push([`${sha}:refs/heads/hook-probe`])).toBe(0)

    fixture.rejectOnOrigin('delete', 'refs/heads/hook-probe')

    expect(push(['--delete', 'hook-probe'])).not.toBe(0)
    expect(fixture.originSha('hook-probe')).toBe(sha)
    expect(push(['--delete', 'hook-other'])).toBe(0)

    fixture.clearOriginRejections()

    expect(push(['--delete', 'hook-probe'])).toBe(0)
    expect(fixture.originSha('hook-probe')).toBeNull()
  })
})

describe('fake jira', () => {
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const credentials = Buffer.from(`${fixture.jiraEnv.JIRA_EMAIL}:${fixture.jiraEnv.JIRA_TOKEN}`).toString('base64')

    return fetch(`${fixture.jiraBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it('serves versions, applies a partial PUT, records requests and honours failure injection', async () => {
    const id = fixture.jiraVersionId!
    const before = fixture.jiraRequests().length
    const listed = (await (await call('GET', '/rest/api/3/project/10000/versions')).json()) as { name: string }[]

    expect(
      listed.map((version) => {
        return version.name
      }),
    ).toStrictEqual(['v1.2.0'])

    fixture.failJira({ method: 'PUT', pathPrefix: '/rest/api/3/version/', status: 503 })

    expect((await call('PUT', `/rest/api/3/version/${id}`, { name: 'v1.3.0' })).status).toBe(503)
    expect(fixture.jiraVersions()[0]!.name).toBe('v1.2.0')

    const put = await call('PUT', `/rest/api/3/version/${id}`, { name: 'v1.3.0' })

    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      id,
      name: 'v1.3.0',
      description: 'Fixture release',
      releaseDate: '2026-12-01',
    })

    const permissions = await call('GET', '/rest/api/3/mypermissions?projectId=10000&permissions=ADMINISTER_PROJECTS')

    expect(await permissions.json()).toStrictEqual({
      permissions: { ADMINISTER_PROJECTS: { key: 'ADMINISTER_PROJECTS', havePermission: true } },
    })
    expect((await call('GET', '/rest/api/3/issue/X-1')).status).toBe(404)
    expect(
      fixture
        .jiraRequests()
        .slice(before)
        .map((request) => {
          return `${request.method} ${request.path}`
        }),
    ).toStrictEqual([
      'GET /rest/api/3/project/10000/versions',
      `PUT /rest/api/3/version/${id}`,
      `PUT /rest/api/3/version/${id}`,
      'GET /rest/api/3/mypermissions?projectId=10000&permissions=ADMINISTER_PROJECTS',
      'GET /rest/api/3/issue/X-1',
    ])
    expect(fixture.jiraRequests()[before + 2]!.body).toStrictEqual({ name: 'v1.3.0' })

    fixture.patchJiraVersion(id, { name: 'v1.2.0' })
  })

  it('onJiraRequest observes each request before it is answered', async () => {
    const id = fixture.jiraVersionId!
    const seen: string[] = []

    const stop = fixture.onJiraRequest((request) => {
      seen.push(`${request.method} ${request.path}`)

      if (request.path === `/rest/api/3/version/${id}` && request.method === 'GET') {
        fixture.patchJiraVersion(id, { archived: true })
      }
    })

    expect(await (await call('GET', `/rest/api/3/version/${id}`)).json()).toMatchObject({ archived: true })
    expect(seen).toStrictEqual([`GET /rest/api/3/version/${id}`])

    stop()
    await call('GET', `/rest/api/3/version/${id}`)

    expect(seen).toHaveLength(1)

    fixture.patchJiraVersion(id, { archived: false })
  })
})

describe('fake orca', () => {
  it('answers envelopes, and reports not-running through the status probe', () => {
    const orca = (argv: string[]) => {
      const result = spawnSync(`${fixture.binDir}/orca`, [...argv, '--json'], { env: fixture.env, encoding: 'utf8' })

      return { code: result.status, envelope: result.stdout ? (JSON.parse(result.stdout) as unknown) : undefined }
    }

    expect(orca(['status']).envelope).toMatchObject({ ok: true, result: { app: { running: true } } })

    const created = orca(['terminal', 'create', '--worktree', `path:${fixture.worktreeDir}`, '--title', 't'])

    expect(created.envelope).toStrictEqual({ ok: true, result: { terminal: { handle: 'term-1' } } })
    expect(
      orca(['terminal', 'list', '--worktree', `path:${fixture.worktreeDir}`, '--limit', '200']).envelope,
    ).toMatchObject({ ok: true, result: { terminals: [{ handle: 'term-1' }] } })
    expect(orca(['terminal', 'close', '--terminal', 'term-1']).envelope).toMatchObject({ ok: true })
    expect(
      orca(['terminal', 'create', '--worktree', `path:${fixture.worktreePathFor('gone')}`, '--title', 't']).envelope,
    ).toMatchObject({ ok: false, error: { code: 'selector_not_found' } })
    expect(orca(['worktree', 'rm', '--worktree', 'path:/x']).code).not.toBe(0)
    expect(fixture.orcaUnhandled()).toStrictEqual([['worktree', 'rm', '--worktree', 'path:/x', '--json']])

    fixture.setOrcaMode('not-running')

    expect(orca(['status']).envelope).toMatchObject({ ok: true, result: { app: { running: false } } })

    fixture.setOrcaMode('ready')

    expect(fixture.orcaLog()[0]).toStrictEqual(['status', '--json'])
  })
})

describe('spawned CLI against the fakes', () => {
  // Its own fixture: the cases above leave closed and extra PRs behind, and this one asserts the listing.
  let fresh: ReleaseRenameFixture

  beforeAll(async () => {
    fresh = await makeReleaseRenameFixture({ cliPath })
  })

  afterAll(async () => {
    await fresh?.cleanup()
  })

  it('`release list --agent --json` exits 0, lists the fixture release, and the child env carries none of the parent credentials', async () => {
    const leaked = {
      GH_TOKEN: 'parent-leak',
      GITHUB_TOKEN: 'parent-leak',
      JIRA_TOKEN: 'parent-leak',
      DOPPLER_TOKEN: 'parent-leak',
      ORCA_WORKTREE_ID: 'parent-leak',
      INFRA_KIT_SESSION: 'parent-leak',
    }

    const saved = Object.fromEntries(
      Object.keys(leaked).map((key) => {
        return [key, process.env[key]]
      }),
    )

    Object.assign(process.env, leaked)

    const callsBefore = fresh.ghLogEntries().length
    const jiraBefore = fresh.jiraRequests().length

    try {
      const run = await fresh.runCli(['release', 'list', '--agent', '--json'])

      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)
      expect(run.json).toMatchObject({
        releases: [{ version: '1.2.0', type: 'regular', description: 'Fixture release', releaseDate: '2026-12-01' }],
        count: 1,
      })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    const entries = fresh.ghLogEntries().slice(callsBefore)

    expect(entries.length).toBeGreaterThan(0)
    expect(fresh.ghUnhandled()).toStrictEqual([])
    expect(fresh.mutatingGhCalls()).toStrictEqual([])

    for (const entry of entries) {
      expect(Object.values(entry.env)).not.toContain('parent-leak')
      expect(entry.env.JIRA_BASE_URL).toBe(fresh.jiraBaseUrl)
    }

    expect(Object.values(fresh.env)).not.toContain('parent-leak')
    // The fake Jira answers 401 to any credential but the fixture's, so a GET reaching it proves the env.
    expect(fresh.jiraRequests().slice(jiraBefore)).toStrictEqual([
      { method: 'GET', path: '/rest/api/3/project/10000/versions', body: null },
    ])
  })
})
