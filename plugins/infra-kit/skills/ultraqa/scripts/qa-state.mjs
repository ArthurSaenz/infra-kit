#!/usr/bin/env node
// The ultraqa state file and the release's Jira context.
//
//   init --lang <en|he> [--base <ref>] [--fresh | --rebase]
//                                                  open (or start) the state of the checked-out release
//   tickets [--version <name>]                     pull the fix version's tickets, write tickets.{json,md}
//   update '<json>' | update -                     merge a partial state (stdin with `-`)
//
// Every write lands under ~/.infra-kit/qa/<repo>/<release>/ — never in the repo, so a QA pass cannot
// dirty the branch it is testing. Output is one JSON object on stdout; `status` other than `ok` is a
// refusal the skill relays, not a crash.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  correlate,
  mergeState,
  newState,
  parseCommits,
  rebaseState,
  releaseFromBranch,
  releaseWorktrees,
  stateDirFor,
  stateSummary,
  ticketsMarkdown,
  toTicket,
} from './lib.mjs'

const JIRA_PAGE_SIZE = 100
const COMMENT_FETCH_CONCURRENCY = 5
const RATE_LIMIT_RETRIES = 2
const DEFAULT_RETRY_AFTER_SECONDS = 5
const PRINTED_UNTRACKED_COMMITS = 5
const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'labels',
  'components',
  'parent',
  'description',
]

const print = (payload) => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

const fail = (payload) => {
  print(payload)
  process.exit(1)
}

const git = (...args) => {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const flag = (argv, name) => {
  const index = argv.indexOf(name)

  return index === -1 ? undefined : argv[index + 1]
}

/** The main checkout's directory name — the same in every worktree of the repo, so a pass started in
 * a release worktree and resumed from the main checkout finds one state. */
const repoName = () => {
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir')

  return basename(basename(commonDir) === '.git' ? dirname(commonDir) : commonDir)
}

const currentRelease = () => {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const release = releaseFromBranch(branch)

  if (!release) {
    fail({
      status: 'not_release_branch',
      branch,
      releaseWorktrees: releaseWorktrees(git('worktree', 'list', '--porcelain')),
    })
  }

  return release
}

const statePaths = (release) => {
  const dir = stateDirFor(homedir(), repoName(), release.label)

  return {
    dir,
    state: join(dir, 'state.json'),
    ticketsJson: join(dir, 'tickets.json'),
    ticketsMd: join(dir, 'tickets.md'),
  }
}

const readState = (paths) => {
  return existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, 'utf-8')) : null
}

const writeState = (paths, state) => {
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`)
}

/** Ticket ↔ commit links against the current HEAD. Re-derived from the cached fetch on a rebase, so
 * a moved release costs no Jira call. */
const commitLinks = (ticketKeys, base) => {
  return correlate(ticketKeys, parseCommits(git('log', '--format=%h%x09%p%x09%s', `${base}..HEAD`)))
}

const ticketsField = (version, count, links, paths) => {
  return {
    version,
    count,
    fetchedAt: new Date().toISOString(),
    withoutCommits: links.withoutCommits,
    untrackedCount: links.untrackedCommits.length,
    files: { json: paths.ticketsJson, markdown: paths.ticketsMd },
  }
}

const assertBase = (base) => {
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
  } catch {
    fail({ status: 'base_missing', base, hint: 'git fetch, or init with another --base' })
  }
}

const rebase = (paths, existing, headSha, base) => {
  assertBase(base)

  const rebased = rebaseState(existing, { headSha, base })

  if (!existsSync(paths.ticketsJson) || existing.phases.tickets !== 'done') return rebased

  const cache = JSON.parse(readFileSync(paths.ticketsJson, 'utf-8'))
  const links = commitLinks(
    cache.tickets.map((ticket) => ticket.key),
    base,
  )

  writeFileSync(paths.ticketsJson, `${JSON.stringify({ ...cache, ...links }, null, 2)}\n`)

  return mergeState(rebased, { tickets: ticketsField(cache.version, cache.tickets.length, links, paths) })
}

const init = (argv) => {
  const lang = flag(argv, '--lang')

  if (lang !== 'en' && lang !== 'he') fail({ status: 'argument_required', argument: 'lang', choices: ['en', 'he'] })

  const release = currentRelease()
  const paths = statePaths(release)
  const headSha = git('rev-parse', 'HEAD')
  const requestedBase = flag(argv, '--base')
  const existing = readState(paths)

  if (existing && !argv.includes('--fresh')) {
    const base = requestedBase ?? existing.base
    const sameHead = existing.headSha === headSha

    if (argv.includes('--rebase')) {
      const state = mergeState(rebase(paths, existing, headSha, base), { lang, updatedAt: new Date().toISOString() })

      writeState(paths, state)
      print({ status: 'ok', resumed: true, rebased: true, stateDir: paths.dir, state: stateSummary(state) })

      return
    }

    // A silently kept old base would split the pass: tickets on one base, the scope on another.
    if (base !== existing.base) fail({ status: 'base_mismatch', stateBase: existing.base, requested: base })

    const state = mergeState(existing, { lang, updatedAt: new Date().toISOString() })

    writeState(paths, state)
    print({ status: 'ok', resumed: true, sameHead, stateDir: paths.dir, state: stateSummary(state) })

    return
  }

  if (existing) renameSync(paths.state, join(paths.dir, `state.${existing.startedAt.replace(/[:.]/g, '-')}.json`))

  const state = newState({
    release,
    repo: repoName(),
    worktree: git('rev-parse', '--show-toplevel'),
    headSha,
    base: requestedBase ?? 'origin/main',
    lang,
    now: new Date().toISOString(),
  })

  writeState(paths, state)
  print({ status: 'ok', resumed: false, stateDir: paths.dir, state: stateSummary(state) })
}

const jiraConfig = () => {
  const config = {
    baseUrl: process.env.JIRA_BASE_URL?.replace(/\/+$/, ''),
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_TOKEN || process.env.JIRA_API_TOKEN,
    projectId: process.env.JIRA_PROJECT_ID,
  }
  // Names only — a value printed here would land in the transcript.
  const missing = [
    !config.baseUrl && 'JIRA_BASE_URL',
    !config.email && 'JIRA_EMAIL',
    !config.token && 'JIRA_TOKEN',
    !config.projectId && 'JIRA_PROJECT_ID',
  ].filter(Boolean)

  if (missing.length > 0) fail({ status: 'env_missing', missing })

  return config
}

const jira = async (config, path, init = {}, retriesLeft = RATE_LIMIT_RETRIES) => {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`,
    },
  })

  // Jira Cloud rate-limits bursts (https://developer.atlassian.com/cloud/jira/platform/rate-limiting/);
  // one 429 must not throw away a whole release's fetch.
  if (response.status === 429 && retriesLeft > 0) {
    const seconds = Number(response.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_SECONDS

    await new Promise((done) => setTimeout(done, seconds * 1000))

    return jira(config, path, init, retriesLeft - 1)
  }

  if (!response.ok) {
    fail({
      status: 'jira_error',
      http: response.status,
      path: path.split('?')[0],
      body: (await response.text()).slice(0, 300),
    })
  }

  return response.json()
}

const searchIssues = async (config, jql, pageToken, collected = []) => {
  const page = await jira(config, '/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: ISSUE_FIELDS, maxResults: JIRA_PAGE_SIZE, nextPageToken: pageToken }),
  })
  const issues = [...collected, ...(page.issues ?? [])]

  return page.isLast !== true && page.nextPageToken ? searchIssues(config, jql, page.nextPageToken, issues) : issues
}

const commentPages = async (config, key, startAt = 0, collected = []) => {
  const page = await jira(
    config,
    `/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=${JIRA_PAGE_SIZE}&orderBy=created`,
  )
  const comments = [...collected, ...(page.comments ?? [])]
  const fetchedAll = (page.comments ?? []).length === 0 || comments.length >= (page.total ?? comments.length)

  return fetchedAll ? comments : commentPages(config, key, comments.length, comments)
}

const commentsOf = async (config, issues) => {
  const results = []
  const queue = [...issues]
  const worker = async () => {
    while (queue.length > 0) {
      const issue = queue.shift()
      results.push([issue.key, await commentPages(config, issue.key)])
    }
  }

  await Promise.all(Array.from({ length: COMMENT_FETCH_CONCURRENCY }, worker))

  return new Map(results)
}

const tickets = async (argv) => {
  const release = currentRelease()
  const paths = statePaths(release)
  const state = readState(paths)

  if (!state) fail({ status: 'no_state', hint: 'run init first' })

  // Checked before any network call: a missing base only surfaces at the commit correlation, after
  // every Jira request has already been paid for.
  assertBase(state.base)

  const config = jiraConfig()
  const versions = await jira(config, `/rest/api/3/project/${config.projectId}/versions`)
  const jiraName = flag(argv, '--version') ?? release.jiraName
  const version = versions.find((candidate) => candidate.name === jiraName)

  if (!version) fail({ status: 'version_not_found', jiraName })

  const issues = await searchIssues(
    config,
    `project = ${config.projectId} AND fixVersion = ${version.id} ORDER BY key ASC`,
  )
  const comments = await commentsOf(config, issues)
  const ticketList = issues.map((issue) => toTicket(issue, comments.get(issue.key) ?? [], config.baseUrl))
  const links = commitLinks(
    ticketList.map((ticket) => ticket.key),
    state.base,
  )
  const versionInfo = {
    id: version.id,
    name: version.name,
    description: version.description ?? null,
    releaseDate: version.releaseDate ?? null,
    url: `${config.baseUrl}/projects/${version.projectId}/versions/${version.id}/tab/release-report-all-issues`,
  }

  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(
    paths.ticketsJson,
    `${JSON.stringify({ version: versionInfo, tickets: ticketList, ...links }, null, 2)}\n`,
  )
  writeFileSync(paths.ticketsMd, `${ticketsMarkdown({ jiraName: version.name }, ticketList)}\n`)

  const rows = ticketList.map((ticket) => ({
    key: ticket.key,
    url: ticket.url,
    type: ticket.type,
    status: ticket.status,
    summary: ticket.summary,
    commits: links.commitsByTicket[ticket.key].length,
    comments: ticket.comments.length,
  }))

  writeState(
    paths,
    mergeState(state, {
      updatedAt: new Date().toISOString(),
      phases: { tickets: 'done' },
      tickets: ticketsField(versionInfo, rows.length, links, paths),
    }),
  )
  print({
    status: 'ok',
    version: versionInfo,
    count: rows.length,
    rows,
    withoutCommits: links.withoutCommits,
    // The full list stays in tickets.json: after a `dev` merge it can run to hundreds of commits.
    untrackedCount: links.untrackedCommits.length,
    untrackedSample: links.untrackedCommits.slice(0, PRINTED_UNTRACKED_COMMITS),
    files: { json: paths.ticketsJson, markdown: paths.ticketsMd },
  })
}

const update = (argv) => {
  const source = argv[0] === '-' ? readFileSync(0, 'utf-8') : argv[0]

  if (!source) fail({ status: 'argument_required', argument: 'patch' })

  const release = currentRelease()
  const paths = statePaths(release)
  const state = readState(paths)

  if (!state) fail({ status: 'no_state', hint: 'run init first' })

  const next = mergeState(state, { ...JSON.parse(source), updatedAt: new Date().toISOString() })

  writeState(paths, next)
  print({ status: 'ok', state: paths.state, phases: next.phases, updatedAt: next.updatedAt })
}

const [command, ...rest] = process.argv.slice(2)

try {
  if (command === 'init') init(rest)
  else if (command === 'tickets') await tickets(rest)
  else if (command === 'update') update(rest)
  else fail({ status: 'argument_required', argument: 'command', choices: ['init', 'tickets', 'update'] })
} catch (error) {
  fail({ status: 'error', command, message: error instanceof Error ? error.message : String(error) })
}
