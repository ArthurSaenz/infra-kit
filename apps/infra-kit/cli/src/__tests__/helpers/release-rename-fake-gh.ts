import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @fileoverview
 * The stateful fake `gh` of the release-rename fixture, run as `node <this file> <config.json> ...argv`
 * (node strips the types) by the wrapper `release-rename-fixture.ts` puts on PATH. GitHub's server is
 * the JSON state file; refs are read from the bare origin on every call and never copied, so a re-run
 * re-probes exactly what earlier steps pushed. Anything it does not implement exits non-zero and is
 * logged to the unhandled log — a silent success would let a test pass against a hole.
 */

export type FakePrState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface FakePr {
  number: number
  state: FakePrState
  title: string
  body: string
  baseRefName: string
  headRefName: string
  createdAt: string
  isDraft: boolean
  labels: { name: string }[]
  assignees: { login: string }[]
  milestone: { title: string } | null
  comments: { body: string; author: { login: string } }[]
  /** A team request carries `slug` and no `login`, as gh reports it. */
  reviewRequests: { login?: string; slug?: string }[]
  latestReviews: { author: { login: string }; state: string }[]
}

export interface FakeRun {
  databaseId: number
  status: string
  conclusion: string
  workflowName: string
  headBranch: string
}

export interface FailRule {
  /** Substring of the space-joined argv. */
  match: string
  /** Removed after the first hit, so a re-run succeeds. */
  once?: boolean
  message?: string
}

/**
 * Something that happens elsewhere (a teammate's push, a dev server starting) just before a matching
 * call reaches GitHub — the only way to stage a change between two steps of ONE spawned run.
 */
export interface SideEffectRule {
  /** Substring of the space-joined argv. */
  match: string
  /** Absolute argv, run to completion before the call is answered; a non-zero exit crashes the fake. */
  exec: string[]
  /** Removed after the first hit. */
  once?: boolean
}

export interface GhState {
  prs: FakePr[]
  runs: FakeRun[]
  permissions: Record<string, boolean>
  protectedBranches: string[]
  /** Branch name → ruleset rule types (`deletion`, `creation`, …) that apply to it. */
  rules: Record<string, string[]>
  failOn: FailRule[]
  onCall?: SideEffectRule[]
}

export interface FakeGhConfig {
  statePath: string
  logPath: string
  unhandledPath: string
  originDir: string
  gitBin: string
}

export interface GhLogEntry {
  argv: string[]
  /** The service-credential variables the fake saw — a scrubbed env leaves only the fixture's own. */
  env: Record<string, string>
}

export const SCRUBBED_ENV_PATTERN = /^(?:GH_|GITHUB_|JIRA_|DOPPLER_|ORCA_|INFRA_KIT_)/

export const FAKE_REPO_URL = 'https://github.com/fixture/repo'

interface Reply {
  code: number
  stdout?: string
  stderr?: string
}

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string[]>
}

interface Context {
  state: GhState
  config: FakeGhConfig
  args: ParsedArgs
  /** Set by a handler that changed `state`, so only mutations rewrite the file. */
  dirty: boolean
}

class Unhandled extends Error {}

const BOOLEAN_FLAGS = new Set(['--draft'])

const PR_FIELDS = new Set([
  'number',
  'state',
  'title',
  'body',
  'baseRefName',
  'headRefName',
  'createdAt',
  'isDraft',
  'labels',
  'assignees',
  'milestone',
  'comments',
  'reviewRequests',
  'latestReviews',
  'url',
])

const RUN_FIELDS = new Set(['databaseId', 'status', 'conclusion', 'workflowName', 'headBranch'])

/** The only `--jq` expressions `src/integrations/gh` passes; any other is a new call to implement. */
const JQ_KEYS = new Map([
  ['.permissions', 'permissions'],
  ['.protected', 'protected'],
  ['.status', 'status'],
])

const DEFAULT_PR_LIST_LIMIT = 30
const PR_CREATED_STEP_MS = 60_000

const ok = (stdout = ''): Reply => {
  return { code: 0, stdout }
}

const fail = (stderr: string): Reply => {
  return { code: 1, stderr }
}

const notFound = (): Reply => {
  return {
    code: 1,
    stdout: JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }),
    stderr: 'gh: Not Found (HTTP 404)',
  }
}

const pushFlag = (flags: Map<string, string[]>, name: string, value: string): void => {
  flags.set(name, [...(flags.get(name) ?? []), value])
}

const parseArgs = (tokens: string[]): ParsedArgs => {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  let pending: string | undefined

  for (const token of tokens) {
    if (pending !== undefined) {
      pushFlag(flags, pending, token)
      pending = undefined
    } else if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
    } else if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=')

      pushFlag(flags, token.slice(0, at), token.slice(at + 1))
    } else if (BOOLEAN_FLAGS.has(token)) {
      pushFlag(flags, token, 'true')
    } else {
      pending = token
    }
  }

  if (pending !== undefined) throw new Unhandled(`flag ${pending} has no value`)

  return { positionals, flags }
}

const assertFlags = (args: ParsedArgs, allowed: string[]): void => {
  const unknown = [...args.flags.keys()].filter((flag) => {
    return !allowed.includes(flag)
  })

  if (unknown.length > 0) throw new Unhandled(`unsupported flag(s) ${unknown.join(', ')}`)
}

const one = (args: ParsedArgs, flag: string): string | undefined => {
  const values = args.flags.get(flag)

  if (values && values.length > 1) throw new Unhandled(`flag ${flag} given ${values.length} times`)

  return values?.[0]
}

const required = (args: ParsedArgs, flag: string): string => {
  const value = one(args, flag)

  if (value === undefined) throw new Unhandled(`missing ${flag}`)

  return value
}

const jsonFields = (args: ParsedArgs, known: Set<string>): string[] => {
  const fields = required(args, '--json').split(',')

  const unknown = fields.filter((field) => {
    return !known.has(field)
  })

  if (unknown.length > 0) throw new Unhandled(`unknown JSON field(s) ${unknown.join(', ')}`)

  return fields
}

const project = (row: object, fields: string[]): Record<string, unknown> => {
  return Object.fromEntries(
    fields.map((field) => {
      return [field, (row as Record<string, unknown>)[field]]
    }),
  )
}

const withUrl = (pr: FakePr): FakePr & { url: string } => {
  return { ...pr, url: `${FAKE_REPO_URL}/pull/${pr.number}` }
}

const originGit = (config: FakeGhConfig, args: string[]): { status: number | null; stdout: string } => {
  const result = spawnSync(config.gitBin, ['--git-dir', config.originDir, ...args], { encoding: 'utf8' })

  return { status: result.status, stdout: result.stdout.trim() }
}

const originBranches = (config: FakeGhConfig): Set<string> => {
  const { stdout } = originGit(config, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])

  return new Set(stdout.split('\n').filter(Boolean))
}

const resolveCommit = (config: FakeGhConfig, ref: string): string | null => {
  const { status, stdout } = originGit(config, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

  return status === 0 ? stdout : null
}

const countCommits = (config: FakeGhConfig, range: string): number => {
  return Number(originGit(config, ['rev-list', '--count', range]).stdout)
}

/**
 * GitHub closes an open PR whose head or base branch is deleted; applied lazily on every call, because
 * the deletion happens in git, out of this fake's sight.
 */
const reconcileWithOrigin = (context: Context): void => {
  const branches = originBranches(context.config)

  for (const pr of context.state.prs) {
    if (pr.state === 'OPEN' && (!branches.has(pr.headRefName) || !branches.has(pr.baseRefName))) {
      pr.state = 'CLOSED'
      context.dirty = true
    }
  }
}

const newestFirst = (a: FakePr, b: FakePr): number => {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt)
}

const findPr = (state: GhState, selector: string): FakePr | undefined => {
  if (/^\d+$/.test(selector)) {
    return state.prs.find((pr) => {
      return pr.number === Number(selector)
    })
  }

  // gh resolves a branch selector to its open PR first, else the newest one.
  const onHead = state.prs
    .filter((pr) => {
      return pr.headRefName === selector
    })
    .toSorted(newestFirst)

  return (
    onHead.find((pr) => {
      return pr.state === 'OPEN'
    }) ?? onHead[0]
  )
}

const selectPr = (context: Context): FakePr => {
  const selector = context.args.positionals[2]

  if (selector === undefined) throw new Unhandled('no PR selector')

  const pr = findPr(context.state, selector)

  if (!pr) throw new PrNotFound(selector)

  return pr
}

class PrNotFound extends Error {}

const STATE_FILTERS = new Set(['open', 'closed', 'merged', 'all'])

const prList = (context: Context): Reply => {
  const { args, state } = context

  assertFlags(args, ['--head', '--base', '--state', '--limit', '--json'])

  const fields = jsonFields(args, PR_FIELDS)
  const stateFilter = (one(args, '--state') ?? 'open').toLowerCase()
  const head = one(args, '--head')
  const base = one(args, '--base')
  const limit = Number(one(args, '--limit') ?? DEFAULT_PR_LIST_LIMIT)

  if (!STATE_FILTERS.has(stateFilter)) throw new Unhandled(`unknown --state ${stateFilter}`)

  const rows = state.prs
    .filter((pr) => {
      return (
        (head === undefined || pr.headRefName === head) &&
        (base === undefined || pr.baseRefName === base) &&
        (stateFilter === 'all' || pr.state.toLowerCase() === stateFilter)
      )
    })
    .toSorted(newestFirst)
    .slice(0, limit)

  return ok(
    JSON.stringify(
      rows.map((pr) => {
        return project(withUrl(pr), fields)
      }),
    ),
  )
}

const prView = (context: Context): Reply => {
  assertFlags(context.args, ['--json'])

  const fields = jsonFields(context.args, PR_FIELDS)

  return ok(JSON.stringify(project(withUrl(selectPr(context)), fields)))
}

const nextCreatedAt = (state: GhState): string => {
  const latest = Math.max(
    Date.parse('2026-10-01T00:00:00Z'),
    ...state.prs.map((pr) => {
      return Date.parse(pr.createdAt)
    }),
  )

  return new Date(latest + PR_CREATED_STEP_MS).toISOString()
}

const createRefusal = (context: Context, head: string, base: string): Reply | null => {
  const branches = originBranches(context.config)

  if (!branches.has(head))
    return fail(`pull request create failed: GraphQL: Head ref must be a branch (createPullRequest)`)
  if (!branches.has(base))
    return fail(`pull request create failed: GraphQL: Base ref must be a branch (createPullRequest)`)

  const duplicate = context.state.prs.find((pr) => {
    return pr.state === 'OPEN' && pr.headRefName === head && pr.baseRefName === base
  })

  if (duplicate) {
    return fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${withUrl(duplicate).url}`)
  }

  if (countCommits(context.config, `${base}..${head}`) === 0) {
    return fail(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`)
  }

  return null
}

const prCreate = (context: Context): Reply => {
  const { args, state } = context

  assertFlags(args, ['--title', '--body', '--base', '--head', '--label', '--assignee', '--milestone', '--draft'])

  const head = required(args, '--head')
  const base = required(args, '--base')
  const refusal = createRefusal(context, head, base)

  if (refusal) return refusal

  const milestone = one(args, '--milestone')

  const pr: FakePr = {
    number:
      Math.max(
        0,
        ...state.prs.map((existing) => {
          return existing.number
        }),
      ) + 1,
    state: 'OPEN',
    title: required(args, '--title'),
    body: required(args, '--body'),
    baseRefName: base,
    headRefName: head,
    createdAt: nextCreatedAt(state),
    isDraft: one(args, '--draft') === 'true',
    labels: (args.flags.get('--label') ?? []).map((name) => {
      return { name }
    }),
    assignees: (args.flags.get('--assignee') ?? []).map((login) => {
      return { login }
    }),
    milestone: milestone === undefined ? null : { title: milestone },
    comments: [],
    reviewRequests: [],
    latestReviews: [],
  }

  state.prs.push(pr)
  context.dirty = true

  return ok(`${withUrl(pr).url}\n`)
}

const prEdit = (context: Context): Reply => {
  const { args } = context

  assertFlags(args, ['--base', '--body', '--title'])

  if (args.flags.size === 0) throw new Unhandled('pr edit with nothing to edit')

  const pr = selectPr(context)
  const base = one(args, '--base')

  if (base !== undefined && !originBranches(context.config).has(base)) {
    return fail(`GraphQL: Proposed base branch '${base}' was not found (updatePullRequest)`)
  }

  pr.baseRefName = base ?? pr.baseRefName
  pr.body = one(args, '--body') ?? pr.body
  pr.title = one(args, '--title') ?? pr.title
  context.dirty = true

  return ok(`${withUrl(pr).url}\n`)
}

const prClose = (context: Context): Reply => {
  assertFlags(context.args, ['--comment'])

  const pr = selectPr(context)

  if (pr.state !== 'OPEN') return { code: 0, stderr: `! Pull request #${pr.number} is already closed` }

  const comment = one(context.args, '--comment')

  if (comment !== undefined) pr.comments.push({ body: comment, author: { login: 'fixture-bot' } })

  pr.state = 'CLOSED'
  context.dirty = true

  return { code: 0, stderr: `✓ Closed pull request #${pr.number}` }
}

const runList = (context: Context): Reply => {
  const { args, state } = context

  assertFlags(args, ['--branch', '--json', '--limit'])

  const fields = jsonFields(args, RUN_FIELDS)
  const branch = one(args, '--branch')
  const limit = Number(one(args, '--limit') ?? '20')

  const rows = state.runs
    .filter((run) => {
      return branch === undefined || run.headBranch === branch
    })
    .slice(0, limit)

  return ok(
    JSON.stringify(
      rows.map((run) => {
        return project(run, fields)
      }),
    ),
  )
}

type ApiAnswer = { body: object } | 'not-found'

const repoInfo = (context: Context): ApiAnswer => {
  return { body: { full_name: 'fixture/repo', permissions: context.state.permissions } }
}

const branchInfo = (context: Context, [encoded]: string[]): ApiAnswer => {
  const branch = decodeURIComponent(encoded ?? '')
  const sha = resolveCommit(context.config, `refs/heads/${branch}`)

  if (sha === null) return 'not-found'

  return { body: { name: branch, commit: { sha }, protected: context.state.protectedBranches.includes(branch) } }
}

const rulesInfo = (context: Context, [encoded]: string[]): ApiAnswer => {
  const branch = decodeURIComponent(encoded ?? '')

  // The rules endpoint answers for a branch NAME, existing or not — which is what a `creation` rule needs.
  return {
    body: (context.state.rules[branch] ?? []).map((type) => {
      return { type }
    }),
  }
}

const compareStatus = (aheadBy: number, behindBy: number): string => {
  if (aheadBy === 0 && behindBy === 0) return 'identical'
  if (behindBy === 0) return 'ahead'
  if (aheadBy === 0) return 'behind'

  return 'diverged'
}

const compareInfo = (context: Context, [range]: string[]): ApiAnswer => {
  const [baseRef, headRef, ...rest] = (range ?? '').split('...')

  if (rest.length > 0 || !headRef) throw new Unhandled(`unsupported compare range ${range}`)

  const base = resolveCommit(context.config, decodeURIComponent(baseRef ?? ''))
  const head = resolveCommit(context.config, decodeURIComponent(headRef ?? ''))

  if (base === null || head === null) return 'not-found'

  const aheadBy = countCommits(context.config, `${base}..${head}`)
  const behindBy = countCommits(context.config, `${head}..${base}`)

  return { body: { status: compareStatus(aheadBy, behindBy), ahead_by: aheadBy, behind_by: behindBy } }
}

const REPO_PREFIX = String.raw`^repos/(?:\{owner\}/\{repo\}|fixture/repo)`

const API_ROUTES: [RegExp, (context: Context, captures: string[]) => ApiAnswer][] = [
  [new RegExp(`${REPO_PREFIX}$`), repoInfo],
  [new RegExp(`${REPO_PREFIX}/branches/([^/]+)$`), branchInfo],
  [new RegExp(`${REPO_PREFIX}/rules/branches/([^/]+)$`), rulesInfo],
  [new RegExp(`${REPO_PREFIX}/compare/(.+)$`), compareInfo],
]

// gh prints a jq string result raw and anything else as JSON — `.protected` arrives as `true`, not `"true"`.
const renderJq = (body: object, expression: string): string => {
  const key = JQ_KEYS.get(expression)

  if (key === undefined) throw new Unhandled(`unsupported --jq expression ${expression}`)

  const value = (body as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : JSON.stringify(value)
}

const api = (context: Context): Reply => {
  const { args } = context

  // Only GETs are served: a method or field flag is an API write and must surface as unhandled.
  assertFlags(args, ['--jq'])

  const path = args.positionals[1]

  if (path === undefined || args.positionals.length !== 2) throw new Unhandled('api needs exactly one path')

  const route = API_ROUTES.find(([pattern]) => {
    return pattern.test(path)
  })

  if (!route) throw new Unhandled(`unsupported api path ${path}`)

  const [pattern, handler] = route
  const answer = handler(context, pattern.exec(path)!.slice(1))

  if (answer === 'not-found') return notFound()

  const jq = one(args, '--jq')

  return ok(`${jq === undefined ? JSON.stringify(answer.body) : renderJq(answer.body, jq)}\n`)
}

const HANDLERS = new Map<string, (context: Context) => Reply>([
  ['pr list', prList],
  ['pr view', prView],
  ['pr create', prCreate],
  ['pr edit', prEdit],
  ['pr close', prClose],
  ['run list', runList],
])

const dispatch = (context: Context): Reply => {
  const [group, verb] = context.args.positionals

  if (group === 'api') return api(context)

  const handler = HANDLERS.get(`${group} ${verb}`)

  if (!handler) throw new Unhandled('unsupported command')

  return handler(context)
}

const readState = (config: FakeGhConfig): GhState => {
  return JSON.parse(readFileSync(config.statePath, 'utf8')) as GhState
}

// Write-then-rename, so a concurrent `gh` (discovery issues two lists at once) never reads half a file.
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

const injectedFailure = (state: GhState, joined: string): Reply | null => {
  const rule = state.failOn.find((candidate) => {
    return joined.includes(candidate.match)
  })

  if (!rule) return null

  if (rule.once)
    state.failOn = state.failOn.filter((candidate) => {
      return candidate !== rule
    })

  return fail(rule.message ?? `fake gh: injected failure on "${rule.match}"`)
}

const runSideEffect = (config: FakeGhConfig, joined: string): void => {
  const state = readState(config)

  const rule = state.onCall?.find((candidate) => {
    return joined.includes(candidate.match)
  })

  if (!rule) return

  if (rule.once) {
    state.onCall = state.onCall?.filter((candidate) => {
      return candidate !== rule
    })
    writeJsonAtomic(config.statePath, state)
  }

  const [command, ...args] = rule.exec
  const result = spawnSync(command!, args, { encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`fake gh: side effect ${JSON.stringify(rule.exec)} exited ${result.status}:\n${result.stderr}`)
  }
}

export const collectScrubbedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return SCRUBBED_ENV_PATTERN.test(entry[0]) && entry[1] !== undefined
    }),
  )
}

const answer = (config: FakeGhConfig, argv: string[]): Reply => {
  if (argv.length === 1 && argv[0] === '--version') return ok('gh version 2.99.0 (fixture)\n')
  if (argv.join(' ') === 'auth status')
    return { code: 0, stderr: 'github.com\n  ✓ Logged in to github.com (fixture)\n' }

  runSideEffect(config, argv.join(' '))

  // Read after the side effect: it may have edited the state file itself.
  const state = readState(config)
  const injected = injectedFailure(state, argv.join(' '))

  if (injected) {
    writeJsonAtomic(config.statePath, state)

    return injected
  }

  const context: Context = { state, config, args: parseArgs(argv), dirty: false }

  reconcileWithOrigin(context)

  try {
    return dispatch(context)
  } catch (error) {
    if (error instanceof PrNotFound) return fail(`no pull requests found for "${error.message}"`)

    throw error
  } finally {
    if (context.dirty) writeJsonAtomic(config.statePath, context.state)
  }
}

const main = (): void => {
  const [configPath, ...argv] = process.argv.slice(2)
  const config = JSON.parse(readFileSync(configPath!, 'utf8')) as FakeGhConfig
  const entry: GhLogEntry = { argv, env: collectScrubbedEnv(process.env) }

  appendFileSync(config.logPath, `${JSON.stringify(entry)}\n`)

  let reply: Reply

  try {
    reply = answer(config, argv)
  } catch (error) {
    if (!(error instanceof Unhandled)) throw error

    appendFileSync(config.unhandledPath, `${JSON.stringify(entry)}\n`)
    reply = { code: 1, stderr: `fake gh: unhandled invocation (${error.message}): gh ${JSON.stringify(argv)}` }
  }

  if (reply.stdout) process.stdout.write(reply.stdout)
  if (reply.stderr) process.stderr.write(`${reply.stderr}\n`)

  process.exitCode = reply.code
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
