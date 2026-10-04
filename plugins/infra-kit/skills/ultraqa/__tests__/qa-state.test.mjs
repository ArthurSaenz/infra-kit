import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  adfToText,
  correlate,
  mergeState,
  newState,
  parseCommits,
  patchError,
  releaseFromBranch,
  releaseWorktrees,
} from '../scripts/lib.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/qa-state.mjs', import.meta.url))
const run = promisify(execFile)

test('releaseFromBranch maps both release branch shapes to their Jira fix version', () => {
  assert.deepEqual(releaseFromBranch('release/v1.2.3'), {
    branch: 'release/v1.2.3',
    label: '1.2.3',
    jiraName: 'v1.2.3',
  })
  assert.deepEqual(releaseFromBranch('refs/heads/release/spring-sale'), {
    branch: 'release/spring-sale',
    label: 'spring-sale',
    jiraName: 'spring-sale',
  })
  assert.deepEqual(releaseFromBranch('release/vouchers'), {
    branch: 'release/vouchers',
    label: 'vouchers',
    jiraName: 'vouchers',
  })
  assert.equal(releaseFromBranch('release/hotfix'), null)
  assert.equal(releaseFromBranch(`release/${'a'.repeat(51)}`), null)
  assert.equal(releaseFromBranch('main'), null)
  assert.equal(releaseFromBranch('feature/release-notes'), null)
  assert.equal(releaseFromBranch('release/v1.2'), null)
})

test('releaseWorktrees keeps only release checkouts, with their paths', () => {
  const porcelain = [
    'worktree /r/main\nHEAD aaa\nbranch refs/heads/main',
    'worktree /r-worktrees/release/v1.4.0\nHEAD bbb\nbranch refs/heads/release/v1.4.0',
    'worktree /r-worktrees/feature/x\nHEAD ccc\nbranch refs/heads/feature/x',
    'worktree /r/detached\nHEAD ddd\ndetached',
  ].join('\n\n')

  assert.deepEqual(releaseWorktrees(porcelain), [
    { path: '/r-worktrees/release/v1.4.0', branch: 'release/v1.4.0', label: '1.4.0' },
  ])
})

test('adfToText keeps lists, links and mentions readable', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Coupon applies' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Total updates' }] }] },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { text: '@Dana' } },
          { type: 'text', text: ' see ' },
          { type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://x.test/spec' } }] },
        ],
      },
    ],
  }

  assert.equal(
    adfToText(doc).trim(),
    '## Acceptance\n- Coupon applies\n- Total updates\n@Dana see spec (https://x.test/spec)',
  )
  assert.equal(adfToText(null), '')

  const criteria = {
    type: 'doc',
    content: [
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'A works' }] },
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'B works' }] },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'status', attrs: { text: 'BLOCKED' } },
          { type: 'text', text: ' until ' },
          { type: 'date', attrs: { timestamp: '1791158400000' } },
        ],
      },
    ],
  }

  assert.equal(adfToText(criteria).trim(), '- [ ] A works\n- [x] B works\n[BLOCKED] until 2026-10-05')
})

test('correlate flags tickets with no commit and commits naming no release ticket', () => {
  const commits = parseCommits(
    [
      'a1\tp0\t[FE] QA-1 coupon field',
      'b2\tp0 p9\tMerge branch dev into release/v1.4.0',
      'c3\tp0\t[BE] QA-1 QA-3 totals',
      'd4\tp0\t[DO] bump node',
      'e5\tp0\t[FE] OTHER-9 unrelated ticket',
      'f6\tp0 p8\tMerge pull request #12 from org/feature/QA-4-search',
    ].join('\n'),
  )
  const result = correlate(['QA-1', 'QA-2', 'QA-3', 'QA-4'], commits)

  assert.deepEqual(result.commitsByTicket, { 'QA-1': ['a1', 'c3'], 'QA-2': [], 'QA-3': ['c3'], 'QA-4': ['f6'] })
  assert.deepEqual(result.withoutCommits, ['QA-2'])
  assert.deepEqual(
    result.untrackedCommits.map((commit) => commit.sha),
    ['d4', 'e5'],
  )
})

test('mergeState merges objects and replaces arrays', () => {
  const base = { phases: { env: 'pending', runs: 'pending' }, runs: [{ app: 'a' }], env: null }
  const merged = mergeState(base, { phases: { env: 'done' }, runs: [{ app: 'b' }], env: 'dev' })

  assert.deepEqual(merged, { phases: { env: 'done', runs: 'pending' }, runs: [{ app: 'b' }], env: 'dev' })
})

// End to end: a throwaway repo on a release branch, HOME redirected so nothing lands in the real
// ~/.infra-kit, and a fake Jira serving one fix version with two tickets.
const fakeJira = () => {
  const adf = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const issue = (key, summary) => ({
    key,
    fields: {
      summary,
      status: { name: 'Ready for QA' },
      issuetype: { name: 'Story' },
      description: adf(`${summary} body`),
    },
  })
  const routes = {
    'GET /rest/api/3/project/10001/versions': [
      { id: '501', name: 'v1.4.0', projectId: 10001, releaseDate: '2026-10-10' },
    ],
    'POST /rest/api/3/search/jql': { issues: [issue('QA-1', 'Coupon field'), issue('QA-2', 'Totals')], isLast: true },
    'GET /rest/api/3/issue/QA-1/comment?startAt=0': {
      total: 2,
      comments: [
        { author: { displayName: 'Dana' }, created: '2026-10-01T10:00:00Z', body: adf('Edge: expired coupon') },
      ],
    },
    'GET /rest/api/3/issue/QA-1/comment?startAt=1': {
      total: 2,
      comments: [{ author: { displayName: 'Omer' }, created: '2026-10-02T10:00:00Z', body: adf('Also: RTL layout') }],
    },
    'GET /rest/api/3/issue/QA-2/comment?startAt=0': { total: 0, comments: [] },
  }
  const seen = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://jira.test')
    const startAt = url.searchParams.get('startAt')
    const key = `${request.method} ${url.pathname}${startAt === null ? '' : `?startAt=${startAt}`}`
    let body = ''

    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      seen.push({ key, auth: request.headers.authorization, body })
      response.writeHead(routes[key] ? 200 : 404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(routes[key] ?? { errorMessages: ['nope'] }))
    })
  })

  return { server, seen }
}

test('patchError refuses the patches that would wedge a resume', () => {
  const state = newState({ release: {}, repo: 'r', worktree: '/w', headSha: 'a', base: 'b', lang: 'en', now: 'n' })

  assert.equal(patchError(state, { phases: { env: 'done' }, mode: 'local', runs: [] }), null)
  assert.match(patchError(state, [1]), /JSON object/)
  assert.match(patchError(state, { phase: { env: 'done' } }), /unknown key "phase"/)
  assert.match(patchError(state, { phases: 'done' }), /must be an object/)
  assert.match(patchError(state, { phases: { enviro: 'done' } }), /unknown phase "enviro"/)
  assert.match(patchError(state, { phases: { env: 'ok' } }), /pending, done or skipped/)
  assert.match(patchError(state, { runs: null }), /"runs" must be an array/)
  assert.match(patchError(state, { headSha: 'x' }), /written by the script/)
})

test('init → tickets → update writes the state outside the repo and correlates commits', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ultraqa-')))
  const home = join(root, 'home')
  const repo = join(root, 'shop-monorepo')
  const sh = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })

  t.after(() => rmSync(root, { recursive: true, force: true }))

  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  sh('branch', 'base-ref')
  sh('switch', '-q', '-c', 'release/v1.4.0')
  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', '[FE] QA-1 coupon')
  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', '[DO] ci tweak')

  const { server, seen } = fakeJira()

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())

  const env = {
    ...process.env,
    HOME: home,
    JIRA_BASE_URL: `http://127.0.0.1:${server.address().port}/`,
    JIRA_EMAIL: 'qa@test',
    JIRA_TOKEN: 'secret-token',
    JIRA_PROJECT_ID: '10001',
  }
  const qa = async (...args) => JSON.parse((await run('node', [SCRIPT, ...args], { cwd: repo, env })).stdout)

  const opened = await qa('init', '--lang', 'he', '--base', 'base-ref')
  const stateDir = join(home, '.infra-kit', 'qa', 'shop-monorepo', '1.4.0')

  assert.equal(opened.resumed, false)
  assert.equal(opened.stateDir, stateDir)
  assert.equal(opened.state.release.jiraName, 'v1.4.0')
  assert.equal(opened.state.phases.release, 'done')

  const fetched = await qa('tickets')

  assert.equal(fetched.count, 2)
  assert.deepEqual(
    fetched.rows.map((row) => [row.key, row.commits, row.comments]),
    [
      ['QA-1', 1, 2],
      ['QA-2', 0, 0],
    ],
  )
  assert.deepEqual(fetched.withoutCommits, ['QA-2'])
  assert.equal(fetched.untrackedCount, 1)
  assert.deepEqual(
    fetched.untrackedSample.map((commit) => commit.subject),
    ['[DO] ci tweak'],
  )
  assert.match(JSON.parse(seen.find((hit) => hit.key.startsWith('POST')).body).jql, /fixVersion = 501/)
  assert.equal(JSON.stringify(fetched).includes('secret-token'), false)

  const notes = readFileSync(join(stateDir, 'tickets.md'), 'utf-8')

  assert.match(notes, /Edge: expired coupon/)
  assert.match(notes, /Also: RTL layout/)

  await qa(
    'update',
    JSON.stringify({ mode: 'local', env: 'dev', phases: { env: 'done', runs: 'done' }, runs: [{ app: 'shop' }] }),
  )

  const refused = await qa('update', JSON.stringify({ phases: 'done' })).catch((error) => JSON.parse(error.stdout))

  assert.equal(refused.status, 'invalid_patch')

  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'))

  assert.equal(state.mode, 'local')
  assert.deepEqual(state.phases, {
    release: 'done',
    apps: 'pending',
    env: 'done',
    tickets: 'done',
    scope: 'pending',
    runs: 'done',
    report: 'pending',
    artifact: 'pending',
  })
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' }), '')

  const resumed = await qa('init', '--lang', 'en')

  assert.equal(resumed.resumed, true)
  assert.equal(resumed.sameHead, true)
  assert.equal(resumed.state.lang, 'en')
  assert.equal(resumed.state.runs, 1)

  sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', '[BE] QA-2 totals')

  assert.equal((await qa('init', '--lang', 'en')).sameHead, false)

  const mismatch = await qa('init', '--lang', 'en', '--base', 'main').catch((error) => JSON.parse(error.stdout))

  assert.deepEqual(mismatch, { status: 'base_mismatch', stateBase: 'base-ref', requested: 'main' })

  const rebased = await qa('init', '--lang', 'en', '--rebase')
  const afterRebase = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'))

  assert.equal(rebased.rebased, true)
  assert.equal(afterRebase.headSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim())
  assert.equal(afterRebase.mode, 'local')
  assert.deepEqual(afterRebase.runs, [])
  assert.equal(afterRebase.phases.runs, 'pending')
  assert.equal(afterRebase.phases.tickets, 'done')
  assert.deepEqual(afterRebase.tickets.withoutCommits, [])
  assert.equal(afterRebase.tickets.fetchedAt, state.tickets.fetchedAt, 'a rebase does not re-fetch, so fetchedAt stays')
  assert.equal(seen.filter((hit) => hit.key.startsWith('POST')).length, 1, 'a rebase must not call Jira again')

  const fresh = await qa('init', '--lang', 'he', '--fresh', '--base', 'base-ref')

  assert.equal(fresh.resumed, false)
  assert.equal(fresh.state.phases.tickets, 'pending')
  assert.ok(existsSync(join(stateDir, 'tickets.md')))

  writeFileSync(join(stateDir, 'state.json'), '{"half": ')

  const corrupt = await qa('init', '--lang', 'en').catch((error) => JSON.parse(error.stdout))

  assert.equal(corrupt.status, 'state_corrupt')
  assert.equal((await qa('init', '--lang', 'en', '--fresh', '--base', 'base-ref')).resumed, false)
})

test('tickets refuses with the missing variable names only', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ultraqa-')))
  const repo = join(root, 'repo')

  t.after(() => rmSync(root, { recursive: true, force: true }))

  execFileSync('git', ['init', '-q', '-b', 'release/v2.0.0', repo])
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], {
    cwd: repo,
  })

  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), JIRA_EMAIL: 'qa@test' }

  await run('node', [SCRIPT, 'init', '--lang', 'en', '--base', 'HEAD'], { cwd: repo, env })

  const refusal = await run('node', [SCRIPT, 'tickets'], { cwd: repo, env }).catch((error) => error)

  assert.equal(refusal.code, 1)
  assert.deepEqual(JSON.parse(refusal.stdout), {
    status: 'env_missing',
    missing: ['JIRA_BASE_URL', 'JIRA_TOKEN', 'JIRA_PROJECT_ID'],
  })
})
