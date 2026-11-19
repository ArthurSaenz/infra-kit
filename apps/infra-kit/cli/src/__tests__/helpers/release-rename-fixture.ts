import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { KILL_SWITCHES } from 'src/__tests__/helpers/build-cli-bundle'
import { buildJiraVersionUrl } from 'src/integrations/jira'
import { formatJiraName, formatPrTitle, parseBranchName } from 'src/lib/release-id'
import { buildReleasePrBody } from 'src/lib/release-utils'

import { runCli as spawnCli } from './agent-cli-fixture'
import type { AgentCliFixture, SpawnedRun } from './agent-cli-fixture'
import { writeJsonAtomic } from './release-rename-fake-gh'
import type {
  FailRule,
  FakeGhConfig,
  FakePr,
  FakeRun,
  GhLogEntry,
  GhState,
  SideEffectRule,
} from './release-rename-fake-gh'
import type { FakeOrcaConfig, OrcaMode, OrcaState } from './release-rename-fake-orca'

/**
 * @fileoverview
 * The spawned-CLI fixture for `release rename` (plan §4 Step 5): a real clone and bare origin, a stateful
 * fake `gh` and `orca` on PATH, and a fake Jira `node:http` server in the test process. GitHub, Jira and
 * Orca keep state, and refs live only in the bare origin, so a re-run re-probes what earlier steps
 * actually wrote. The child env is built from scratch, as in `agent-cli-fixture.ts`: inheriting the
 * parent would hand the CLI the developer's real tokens.
 */

export type { FakePr, FakeRun, GhState, OrcaMode, OrcaState }

export interface FakeJiraVersion {
  id: string
  self: string
  name: string
  description?: string
  releaseDate?: string
  released: boolean
  archived: boolean
  projectId: number
}

export interface JiraRequest {
  method: string
  /** Pathname plus query string, as sent. */
  path: string
  /** Parsed JSON, the raw text when it is not JSON, `null` when empty. */
  body: unknown
}

export interface JiraFailure {
  method: string
  pathPrefix: string
  status: number
  /** How many matching requests fail before the route answers normally again. */
  times?: number
  body?: unknown
}

export interface ReleaseRenameFixtureOptions {
  /** `cli.js` from `buildCliBundle`; required only by `runCli`. */
  cliPath?: string
  /** The part after `release/`: `v1.2.0` (versioned) or a name such as `checkout-redesign`. */
  release?: string
  type?: 'regular' | 'hotfix'
  /** A local branch tracking origin (no worktree). Default true; forced on by `worktree`. */
  localBranch?: boolean
  /** A linked worktree at `<repo>-worktrees/release/<suffix>` with one untracked and one modified file. */
  worktree?: boolean
  /** Seed the open release PR #1. Default true. */
  pr?: boolean
  /** Seed the Jira version (patched over the defaults), or `false` for none. */
  jiraVersion?: Partial<FakeJiraVersion> | false
  /** `mypermissions` answer; default `{ ADMINISTER_PROJECTS: true }`. */
  jiraPermissions?: Record<string, boolean>
  orca?: OrcaMode
  /** Merged over the root `infra-kit.json` the fixture commits. */
  infraKitConfig?: Record<string, unknown>
}

export interface RunCliOverrides {
  cwd?: string
  /** Spread over the hermetic env; `undefined` deletes a key. */
  env?: Record<string, string | undefined>
  deadlineMs?: number
}

export interface ReleaseRenameFixture {
  root: string
  repoDir: string
  originDir: string
  homeDir: string
  binDir: string
  worktreesDir: string
  /** `release/<suffix>` */
  branch: string
  suffix: string
  type: 'regular' | 'hotfix'
  /** `dev` for regular, `main` for hotfix. */
  baseBranch: string
  /** Where the release worktree lives (or would) — `<repo>-worktrees/release/<suffix>`. */
  worktreeDir: string
  /** The seeded Jira version id, `null` when none was seeded. */
  jiraVersionId: string | null
  jiraBaseUrl: string
  /** The four `JIRA_*` variables pointing at the fake server — for in-process callers too. */
  jiraEnv: Record<string, string>
  /** The hermetic base env every spawn starts from. */
  env: Record<string, string>
  worktreePathFor: (suffix: string) => string

  runCli: (args: string[], overrides?: RunCliOverrides) => Promise<SpawnedRun>

  ghLog: () => string[][]
  ghLogEntries: () => GhLogEntry[]
  ghUnhandled: () => string[][]
  ghState: () => GhState
  mutatingGhCalls: () => string[][]
  jiraRequests: () => JiraRequest[]
  jiraVersions: () => FakeJiraVersion[]
  orcaLog: () => string[][]
  orcaUnhandled: () => string[][]
  orcaState: () => OrcaState
  originRefs: () => Record<string, string>
  cloneRefs: () => Record<string, string>
  /** Spawn the fake `gh` directly, with the fixture env — for probing it without the CLI. */
  gh: (argv: string[]) => { code: number | null; stdout: string; stderr: string }

  addPr: (pr: Partial<FakePr> & Pick<FakePr, 'headRefName' | 'baseRefName'>) => number
  patchPr: (number: number, patch: Partial<FakePr>) => void
  addRun: (run: Partial<FakeRun> & Pick<FakeRun, 'headBranch'>) => void
  setPermissions: (permissions: Record<string, boolean>) => void
  setProtected: (branch: string, isProtected: boolean) => void
  setRules: (branch: string, rules: string[]) => void
  failGhOn: (match: string, options?: Omit<FailRule, 'match'>) => void
  /** Run `exec` (absolute argv) just before the fake answers a call whose argv contains `match`. */
  onGhCall: (match: string, exec: string[], options?: Pick<SideEffectRule, 'once'>) => void
  setJiraPermission: (key: string, granted: boolean) => void
  addJiraVersion: (version: Partial<FakeJiraVersion> & Pick<FakeJiraVersion, 'name'>) => FakeJiraVersion
  patchJiraVersion: (id: string, patch: Partial<FakeJiraVersion>) => void
  failJira: (failure: JiraFailure) => void
  /**
   * Called with each request after it is recorded and before it is answered — the in-run staging seam.
   * Returns the unsubscribe.
   */
  onJiraRequest: (observer: (request: JiraRequest) => void) => () => void
  /**
   * Make origin's receive-pack refuse one ref update, as a server-side hook or ruleset would: `create`
   * (old sha all zeros), `delete` (new sha all zeros) or `update` of the full ref name.
   */
  rejectOnOrigin: (operation: OriginRefOperation, ref: string) => void
  clearOriginRejections: () => void
  setOrcaMode: (mode: OrcaMode) => void
  addOrcaTerminal: (worktree: string, title?: string) => string
  failOrcaOn: (match: string, options?: Omit<FailRule, 'match'>) => void
  /** A second clone commits on `branch` and pushes it to origin (forced); returns the new sha. */
  pushAsTeammate: (branch: string, options?: { ancestorOf?: string }) => string
  /** Point (or create) `refs/heads/<branch>` on origin at `sha`, as a push from elsewhere would. */
  recreateBranchOnOrigin: (branch: string, sha: string) => void
  originSha: (branch: string) => string | null
  cloneSha: (ref: string) => string | null

  cleanup: () => Promise<void>
}

const GIT = '/usr/bin/git'
const HELPERS_DIR = resolve(import.meta.dirname)
const FIXTURE_SESSION = 'b0d1e5c0'
const JIRA_PROJECT_ID = 10_000
const DEFAULT_VERSION_ID = '10001'
const DEFAULT_SPAWN_DEADLINE_MS = 30_000
const MAX_TEAMMATES = 1_000

const JIRA_IDENTITY = { email: 'fixture@example.invalid', token: 'fixture-jira-token' } as const

const gitIn = (cwd: string, env: Record<string, string>, args: string[]): string => {
  const result = spawnSync(GIT, args, { cwd, env, encoding: 'utf8' })

  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)

  return result.stdout.trim()
}

const tryGit = (cwd: string, env: Record<string, string>, args: string[]): string | null => {
  const result = spawnSync(GIT, args, { cwd, env, encoding: 'utf8' })

  return result.status === 0 ? result.stdout.trim() : null
}

const readJsonLines = <T>(path: string): T[] => {
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as T
    })
}

const readJson = <T>(path: string): T => {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

const refsMap = (output: string): Record<string, string> => {
  return Object.fromEntries(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(' ')

        return [ref!, sha!] as const
      })
      .toSorted(([a], [b]) => {
        return a.localeCompare(b)
      }),
  )
}

const API_WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']

const isApiWriteFlag = (token: string): boolean => {
  return API_WRITE_FLAGS.some((flag) => {
    return token === flag || token.startsWith(`${flag}=`) || (flag.length === 2 && token.startsWith(flag))
  })
}

const isReadOnlyApiCall = (argv: string[]): boolean => {
  const [, path, ...rest] = argv

  if (path === undefined || !path.startsWith('repos/')) return false
  if (argv.some(isApiWriteFlag)) return false

  return rest.length === 0 || (rest.length === 2 && rest[0] === '--jq')
}

const READ_ONLY_VERBS = new Set(['pr list', 'pr view', 'run list'])

/**
 * Plan §5 AC 1's read-only allowlist, exactly: `--version`, `auth status`, `pr list …`, `pr view …`,
 * `run list …`, and `api repos/… [--jq <expr>]` with no method or field flag. Everything else is a write.
 */
export const isReadOnlyGhCall = (argv: string[]): boolean => {
  const joined = argv.join(' ')

  if (joined === '--version' || joined === 'auth status') return true
  if (READ_ONLY_VERBS.has(argv.slice(0, 2).join(' '))) return true
  if (argv[0] === 'api') return isReadOnlyApiCall(argv)

  return false
}

/** The `infra-kit.json` of `agent-cli-fixture.ts`: the minimum `getInfraKitConfig` accepts. */
const baseInfraKitConfig = {
  envManagement: { provider: 'doppler', config: { name: 'fixture' } },
  protectedEnvs: 'cli-only',
}

interface JiraServer {
  server: Server
  versions: Map<string, FakeJiraVersion>
  permissions: Record<string, boolean>
  requests: JiraRequest[]
  failures: (JiraFailure & { remaining: number })[]
  observers: ((request: JiraRequest) => void)[]
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const parseBody = (text: string): unknown => {
  if (text === '') return null

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const VERSION_FIELDS = ['name', 'description', 'releaseDate', 'released', 'archived'] as const

// Jira's PUT is a partial update: an absent field keeps its value, a `null` date clears it.
const applyVersionPatch = (version: FakeJiraVersion, patch: Record<string, unknown>): FakeJiraVersion => {
  const next: Record<string, unknown> = { ...version }

  for (const field of VERSION_FIELDS) {
    if (!(field in patch)) continue

    if (patch[field] === null) {
      delete next[field]
    } else {
      next[field] = patch[field]
    }
  }

  return next as unknown as FakeJiraVersion
}

const nameTaken = (jira: JiraServer, name: unknown, exceptId: string | null): boolean => {
  return [...jira.versions.values()].some((other) => {
    return other.name === name && other.id !== exceptId
  })
}

const NAME_TAKEN_BODY = {
  errorMessages: [],
  errors: { name: 'A version with this name already exists in this project.' },
}

const putVersion = (jira: JiraServer, id: string, body: unknown, response: ServerResponse): void => {
  const version = jira.versions.get(id)

  if (!version) return sendJson(response, 404, { errorMessages: [`Could not find version for id '${id}'`] })

  const patch = (body ?? {}) as Record<string, unknown>

  if ('name' in patch && nameTaken(jira, patch.name, id)) return sendJson(response, 400, NAME_TAKEN_BODY)

  const updated = applyVersionPatch(version, patch)

  jira.versions.set(id, updated)
  sendJson(response, 200, updated)
}

const createVersion = (jira: JiraServer, baseUrl: string, body: unknown, response: ServerResponse): void => {
  const fields = (body ?? {}) as Record<string, unknown>

  if (nameTaken(jira, fields.name, null)) return sendJson(response, 400, NAME_TAKEN_BODY)

  const id = String(Math.max(Number(DEFAULT_VERSION_ID) - 1, ...[...jira.versions.keys()].map(Number)) + 1)

  const version = applyVersionPatch(
    {
      id,
      self: `${baseUrl}/rest/api/3/version/${id}`,
      name: '',
      released: false,
      archived: false,
      projectId: Number(fields.projectId),
    },
    fields,
  )

  jira.versions.set(id, version)
  sendJson(response, 201, version)
}

const myPermissions = (jira: JiraServer, url: URL, response: ServerResponse): void => {
  const keys = (url.searchParams.get('permissions') ?? '').split(',').filter(Boolean)

  sendJson(response, 200, {
    permissions: Object.fromEntries(
      keys.map((key) => {
        return [key, { key, havePermission: jira.permissions[key] === true }]
      }),
    ),
  })
}

const VERSION_PATH = /^\/rest\/api\/3\/version\/(\d+)$/
const PROJECT_VERSIONS_PATH = /^\/rest\/api\/3\/project\/(\d+)\/versions$/

const routeJira = (jira: JiraServer, baseUrl: string, request: JiraRequest, response: ServerResponse): void => {
  const url = new URL(request.path, baseUrl)
  const versionId = VERSION_PATH.exec(url.pathname)?.[1]
  const projectId = PROJECT_VERSIONS_PATH.exec(url.pathname)?.[1]
  const route = `${request.method} ${versionId === undefined ? url.pathname : '/rest/api/3/version/:id'}`

  if (request.method === 'GET' && projectId !== undefined) {
    return sendJson(
      response,
      200,
      [...jira.versions.values()].filter((version) => {
        return version.projectId === Number(projectId)
      }),
    )
  }

  if (route === 'GET /rest/api/3/version/:id' && jira.versions.has(versionId!)) {
    return sendJson(response, 200, jira.versions.get(versionId!))
  }

  if (route === 'PUT /rest/api/3/version/:id') return putVersion(jira, versionId!, request.body, response)
  if (route === 'POST /rest/api/3/version') return createVersion(jira, baseUrl, request.body, response)
  if (route === 'GET /rest/api/3/mypermissions') return myPermissions(jira, url, response)

  sendJson(response, 404, { errorMessages: [`fake jira: unhandled ${request.method} ${request.path}`] })
}

const takeInjectedFailure = (jira: JiraServer, request: JiraRequest): JiraFailure | undefined => {
  const failure = jira.failures.find((candidate) => {
    return (
      candidate.remaining > 0 && candidate.method === request.method && request.path.startsWith(candidate.pathPrefix)
    )
  })

  if (failure) failure.remaining -= 1

  return failure
}

const JIRA_CREDENTIALS = `${JIRA_IDENTITY.email}:${JIRA_IDENTITY.token}`
const EXPECTED_AUTH = `Basic ${Buffer.from(JIRA_CREDENTIALS).toString('base64')}`

const handleJira = (jira: JiraServer, baseUrl: () => string, raw: IncomingMessage, response: ServerResponse): void => {
  const chunks: Buffer[] = []

  raw.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  raw.on('end', () => {
    const request: JiraRequest = {
      method: raw.method ?? 'GET',
      path: raw.url ?? '/',
      body: parseBody(Buffer.concat(chunks).toString('utf8')),
    }

    jira.requests.push(request)

    for (const observer of jira.observers) observer(structuredClone(request))

    // Only the fixture's credentials are accepted — a request carrying anything else leaked from elsewhere.
    if (raw.headers.authorization !== EXPECTED_AUTH) return sendJson(response, 401, { errorMessages: ['unauthorized'] })

    const failure = takeInjectedFailure(jira, request)

    if (failure)
      return sendJson(response, failure.status, failure.body ?? { errorMessages: ['fake jira: injected failure'] })

    routeJira(jira, baseUrl(), request, response)
  })
}

const startJira = async (permissions: Record<string, boolean>): Promise<{ jira: JiraServer; baseUrl: string }> => {
  let baseUrl = ''

  const jira: JiraServer = {
    server: createServer((raw, response) => {
      handleJira(
        jira,
        () => {
          return baseUrl
        },
        raw,
        response,
      )
    }),
    versions: new Map(),
    permissions,
    requests: [],
    failures: [],
    observers: [],
  }

  await new Promise<void>((resolvePromise) => {
    jira.server.listen(0, '127.0.0.1', resolvePromise)
  })

  baseUrl = `http://127.0.0.1:${(jira.server.address() as AddressInfo).port}`

  return { jira, baseUrl }
}

export type OriginRefOperation = 'create' | 'update' | 'delete'

const REJECTIONS_FILE = 'rejections'

// `update` runs once per ref with <ref> <old> <new>; an all-zero sha marks a create or a delete.
const UPDATE_HOOK = `#!/bin/sh
case "$2" in *[!0]*) op=update ;; *) op=create ;; esac
case "$3" in *[!0]*) ;; *) op=delete ;; esac
if grep -qxF "$op $1" "$(dirname "$0")/${REJECTIONS_FILE}"; then
  echo "fixture: $op of $1 rejected by a server-side hook" >&2
  exit 1
fi
`

/** The global gitconfig points `core.hooksPath` at /dev/null, so origin names its own hooks dir. */
const installOriginHook = (originDir: string, env: Record<string, string>): void => {
  const hooksDir = join(originDir, 'hooks')
  const hook = join(hooksDir, 'update')

  if (existsSync(hook) && existsSync(join(hooksDir, REJECTIONS_FILE))) return

  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(hook, UPDATE_HOOK)
  chmodSync(hook, 0o755)
  writeFileSync(join(hooksDir, REJECTIONS_FILE), '')
  gitIn(originDir, env, ['--git-dir', originDir, 'config', 'core.hooksPath', hooksDir])
}

interface Layout {
  root: string
  homeDir: string
  binDir: string
  repoDir: string
  originDir: string
}

const writeFakeBin = (layout: Layout, name: string, script: string, config: object): void => {
  const configPath = join(layout.binDir, `${name}-config.json`)

  writeFileSync(configPath, JSON.stringify(config))
  // An absolute node and script: the child's PATH holds only the fakes and the system dirs.
  writeFileSync(
    join(layout.binDir, name),
    `#!/bin/sh\nexec '${process.execPath}' '${join(HELPERS_DIR, script)}' '${configPath}' "$@"\n`,
  )
  chmodSync(join(layout.binDir, name), 0o755)
}

const buildEnv = (layout: Layout, jiraEnv: Record<string, string>): Record<string, string> => {
  return {
    PATH: `${layout.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: layout.homeDir,
    XDG_CACHE_HOME: join(layout.homeDir, '.cache'),
    INFRA_KIT_SESSION: FIXTURE_SESSION,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: join(layout.homeDir, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...KILL_SWITCHES,
    ...jiraEnv,
  }
}

interface RepoPlan {
  branch: string
  baseBranch: string
  localBranch: boolean
  worktree: boolean
  worktreeDir: string
  infraKitConfig: Record<string, unknown>
}

const buildRepos = (layout: Layout, env: Record<string, string>, plan: RepoPlan): void => {
  const { repoDir, originDir } = layout

  const git = (args: string[]): string => {
    return gitIn(repoDir, env, args)
  }

  writeFileSync(
    join(repoDir, 'infra-kit.json'),
    `${JSON.stringify({ ...baseInfraKitConfig, ...plan.infraKitConfig }, null, 2)}\n`,
  )
  writeFileSync(join(repoDir, 'package.json'), `${JSON.stringify({ name: 'fixture-repo', private: true }, null, 2)}\n`)
  writeFileSync(join(repoDir, '.gitignore'), '.omc/\n')

  git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'fixture: initial'])
  git(['branch', 'dev'])
  git(['switch', '-q', '-c', plan.branch, plan.baseBranch])
  writeFileSync(join(repoDir, 'release.txt'), 'release work\n')
  git(['add', 'release.txt'])
  git(['commit', '-q', '-m', 'fixture: release work'])
  git(['switch', '-q', 'dev'])
  gitIn(layout.root, env, ['init', '-q', '--bare', originDir])
  git(['remote', 'add', 'origin', originDir])
  git(['push', '-q', '-u', 'origin', 'main', 'dev', plan.branch])
  git(['fetch', '-q', 'origin'])

  if (plan.worktree) {
    mkdirSync(join(plan.worktreeDir, '..'), { recursive: true })
    git(['worktree', 'add', '-q', plan.worktreeDir, plan.branch])
    writeFileSync(join(plan.worktreeDir, 'untracked.txt'), 'not yet added\n')
    writeFileSync(join(plan.worktreeDir, 'release.txt'), 'release work, edited\n')
  } else if (!plan.localBranch) {
    git(['branch', '-q', '-D', plan.branch])
  }
}

const defaultPr = (options: { branch: string; baseBranch: string; title: string; body: string }): FakePr => {
  return {
    number: 1,
    state: 'OPEN',
    title: options.title,
    body: options.body,
    baseRefName: options.baseBranch,
    headRefName: options.branch,
    createdAt: '2026-10-01T00:00:00Z',
    isDraft: false,
    labels: [{ name: 'release' }],
    assignees: [{ login: 'fixture-dev' }],
    milestone: null,
    comments: [],
    reviewRequests: [{ login: 'reviewer-a' }],
    latestReviews: [{ author: { login: 'reviewer-b' }, state: 'APPROVED' }],
  }
}

/**
 * Build the fixture. Async because the fake Jira must be listening before any spawn reads its URL;
 * everything else is created synchronously under one realpath'd `mkdtemp`.
 */
export const makeReleaseRenameFixture = async (
  options: ReleaseRenameFixtureOptions = {},
): Promise<ReleaseRenameFixture> => {
  const suffix = options.release ?? 'v1.2.0'
  const branch = `release/${suffix}`
  const releaseId = parseBranchName(branch)

  if (!releaseId) throw new Error(`fixture: "${branch}" is not a release branch`)

  const type = options.type ?? 'regular'
  const baseBranch = type === 'hotfix' ? 'main' : 'dev'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-rename-')))

  const layout: Layout = {
    root,
    homeDir: join(root, 'home'),
    binDir: join(root, 'bin'),
    repoDir: join(root, 'repo'),
    originDir: join(root, 'origin.git'),
  }

  for (const dir of [layout.homeDir, layout.binDir, layout.repoDir]) mkdirSync(dir, { recursive: true })

  const { jira, baseUrl: jiraBaseUrl } = await startJira({ ADMINISTER_PROJECTS: true, ...options.jiraPermissions })

  const jiraEnv = {
    JIRA_BASE_URL: jiraBaseUrl,
    JIRA_TOKEN: JIRA_IDENTITY.token,
    JIRA_EMAIL: JIRA_IDENTITY.email,
    JIRA_PROJECT_ID: String(JIRA_PROJECT_ID),
  }

  const env = buildEnv(layout, jiraEnv)
  const worktreesDir = `${layout.repoDir}-worktrees`

  const worktreePathFor = (name: string): string => {
    return join(worktreesDir, 'release', name)
  }

  writeFileSync(
    join(layout.homeDir, '.gitconfig'),
    '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n',
  )

  buildRepos(layout, env, {
    branch,
    baseBranch,
    localBranch: options.localBranch ?? true,
    worktree: options.worktree ?? false,
    worktreeDir: worktreePathFor(suffix),
    infraKitConfig: options.infraKitConfig ?? {},
  })

  let jiraVersionId: string | null = null
  let jiraDescription: string | undefined

  if (options.jiraVersion !== false) {
    const version: FakeJiraVersion = {
      id: DEFAULT_VERSION_ID,
      self: `${jiraBaseUrl}/rest/api/3/version/${DEFAULT_VERSION_ID}`,
      name: formatJiraName(releaseId),
      description: 'Fixture release',
      releaseDate: '2026-12-01',
      released: false,
      archived: false,
      projectId: JIRA_PROJECT_ID,
      ...options.jiraVersion,
    }

    jira.versions.set(version.id, version)
    jiraVersionId = version.id
    jiraDescription = version.description
  }

  const jiraUrl = buildJiraVersionUrl(
    { baseUrl: jiraBaseUrl, token: JIRA_IDENTITY.token, email: JIRA_IDENTITY.email, projectId: JIRA_PROJECT_ID },
    { id: jiraVersionId ?? DEFAULT_VERSION_ID, projectId: JIRA_PROJECT_ID },
  )

  const ghConfig: FakeGhConfig = {
    statePath: join(layout.binDir, 'gh-state.json'),
    logPath: join(layout.binDir, 'gh.log'),
    unhandledPath: join(layout.binDir, 'gh-unhandled.log'),
    originDir: layout.originDir,
    gitBin: GIT,
  }

  const orcaConfig: FakeOrcaConfig = {
    statePath: join(layout.binDir, 'orca-state.json'),
    logPath: join(layout.binDir, 'orca.log'),
    unhandledPath: join(layout.binDir, 'orca-unhandled.log'),
    gitBin: GIT,
  }

  const initialGh: GhState = {
    prs:
      options.pr === false
        ? []
        : [
            defaultPr({
              branch,
              baseBranch,
              title: formatPrTitle(releaseId, type),
              body: buildReleasePrBody(jiraUrl, jiraDescription),
            }),
          ],
    runs: [],
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    protectedBranches: ['main'],
    rules: {},
    failOn: [],
    onCall: [],
  }

  const initialOrca: OrcaState = {
    mode: options.orca ?? 'ready',
    terminals: [],
    repos: [{ path: layout.repoDir, externalWorktreeVisibility: 'show' }],
    nextHandle: 1,
    failOn: [],
  }

  writeJsonAtomic(ghConfig.statePath, initialGh)
  writeJsonAtomic(orcaConfig.statePath, initialOrca)

  for (const path of [ghConfig.logPath, ghConfig.unhandledPath, orcaConfig.logPath, orcaConfig.unhandledPath]) {
    writeFileSync(path, '')
  }

  writeFakeBin(layout, 'gh', 'release-rename-fake-gh.ts', ghConfig)
  writeFakeBin(layout, 'orca', 'release-rename-fake-orca.ts', orcaConfig)
  // `worktrees add`-style paths run `pnpm install`; a real one would dirty every worktree.
  writeFileSync(join(layout.binDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(layout.binDir, 'pnpm'), 0o755)

  const ghState = (): GhState => {
    return readJson<GhState>(ghConfig.statePath)
  }

  const editGh = (edit: (state: GhState) => void): void => {
    const state = ghState()

    edit(state)
    writeJsonAtomic(ghConfig.statePath, state)
  }

  const orcaState = (): OrcaState => {
    return readJson<OrcaState>(orcaConfig.statePath)
  }

  const editOrca = (edit: (state: OrcaState) => void): void => {
    const state = orcaState()

    edit(state)
    writeJsonAtomic(orcaConfig.statePath, state)
  }

  const ghLog = (): string[][] => {
    return readJsonLines<GhLogEntry>(ghConfig.logPath).map((entry) => {
      return entry.argv
    })
  }

  const originRefs = (): Record<string, string> => {
    return refsMap(
      gitIn(root, env, ['--git-dir', layout.originDir, 'for-each-ref', '--format=%(objectname) %(refname)']),
    )
  }

  const cloneRefs = (): Record<string, string> => {
    return refsMap(
      gitIn(layout.repoDir, env, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']),
    )
  }

  const agentFixture: AgentCliFixture = {
    repoDir: layout.repoDir,
    worktreesDir,
    releaseWorktreeDir: worktreePathFor(suffix),
    ghLog: ghConfig.logPath,
    homeDir: layout.homeDir,
    env,
  }

  const runCli = (args: string[], overrides: RunCliOverrides = {}): Promise<SpawnedRun> => {
    if (!options.cliPath) throw new Error('fixture: pass `cliPath` (from buildCliBundle) to use runCli')

    return spawnCli({
      cliPath: options.cliPath,
      fixture: agentFixture,
      args,
      env: overrides.env,
      cwd: overrides.cwd,
      deadlineMs: overrides.deadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS,
    })
  }

  const gh = (argv: string[]) => {
    const result = spawnSync(join(layout.binDir, 'gh'), argv, { cwd: layout.repoDir, env, encoding: 'utf8' })

    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  const teammateDirs = Array.from({ length: MAX_TEAMMATES }, (_, index) => {
    return join(root, `teammate-${index + 1}`)
  })

  const pushAsTeammate = (target: string, pushOptions: { ancestorOf?: string } = {}): string => {
    const dir = teammateDirs.find((candidate) => {
      return !existsSync(candidate)
    })

    if (!dir) throw new Error('fixture: out of teammate clones')

    gitIn(root, env, ['clone', '-q', layout.originDir, dir])

    const parent = pushOptions.ancestorOf ?? tryGit(dir, env, ['rev-parse', '--verify', `origin/${target}`])

    if (parent === null) throw new Error(`fixture: ${target} is not on origin — pass ancestorOf`)

    gitIn(dir, env, ['switch', '-q', '--detach', parent])
    writeFileSync(join(dir, `teammate-${teammateDirs.indexOf(dir) + 1}.txt`), 'teammate work\n')
    gitIn(dir, env, ['add', '-A'])
    gitIn(dir, env, ['commit', '-q', '-m', `teammate: work on ${target}`])
    gitIn(dir, env, ['push', '-q', 'origin', `+HEAD:refs/heads/${target}`])

    return gitIn(dir, env, ['rev-parse', 'HEAD'])
  }

  return {
    root,
    repoDir: layout.repoDir,
    originDir: layout.originDir,
    homeDir: layout.homeDir,
    binDir: layout.binDir,
    worktreesDir,
    branch,
    suffix,
    type,
    baseBranch,
    worktreeDir: worktreePathFor(suffix),
    jiraVersionId,
    jiraBaseUrl,
    jiraEnv,
    env,
    worktreePathFor,
    runCli,
    ghLog,
    ghLogEntries: () => {
      return readJsonLines<GhLogEntry>(ghConfig.logPath)
    },
    ghUnhandled: () => {
      return readJsonLines<GhLogEntry>(ghConfig.unhandledPath).map((entry) => {
        return entry.argv
      })
    },
    ghState,
    mutatingGhCalls: () => {
      return ghLog().filter((argv) => {
        return !isReadOnlyGhCall(argv)
      })
    },
    jiraRequests: () => {
      return structuredClone(jira.requests)
    },
    jiraVersions: () => {
      return structuredClone([...jira.versions.values()])
    },
    orcaLog: () => {
      return readJsonLines<GhLogEntry>(orcaConfig.logPath).map((entry) => {
        return entry.argv
      })
    },
    orcaUnhandled: () => {
      return readJsonLines<GhLogEntry>(orcaConfig.unhandledPath).map((entry) => {
        return entry.argv
      })
    },
    orcaState,
    originRefs,
    cloneRefs,
    gh,
    addPr: (pr) => {
      let number = 0

      editGh((state) => {
        number =
          Math.max(
            0,
            ...state.prs.map((existing) => {
              return existing.number
            }),
          ) + 1
        state.prs.push({
          ...defaultPr({ branch: pr.headRefName, baseBranch: pr.baseRefName, title: `PR ${number}`, body: '' }),
          labels: [],
          assignees: [],
          reviewRequests: [],
          latestReviews: [],
          createdAt: new Date(Date.parse('2026-10-01T00:00:00Z') + number * 1_000).toISOString(),
          ...pr,
          number,
        })
      })

      return number
    },
    patchPr: (number, patch) => {
      editGh((state) => {
        const pr = state.prs.find((candidate) => {
          return candidate.number === number
        })

        if (!pr) throw new Error(`fixture: no PR #${number}`)

        Object.assign(pr, patch)
      })
    },
    addRun: (run) => {
      editGh((state) => {
        state.runs.push({
          databaseId: 9_000 + state.runs.length + 1,
          status: 'in_progress',
          conclusion: '',
          workflowName: 'deploy-all',
          ...run,
        })
      })
    },
    setPermissions: (permissions) => {
      editGh((state) => {
        state.permissions = { ...state.permissions, ...permissions }
      })
    },
    setProtected: (target, isProtected) => {
      editGh((state) => {
        const others = state.protectedBranches.filter((name) => {
          return name !== target
        })

        state.protectedBranches = isProtected ? [...others, target] : others
      })
    },
    setRules: (target, rules) => {
      editGh((state) => {
        state.rules[target] = rules
      })
    },
    failGhOn: (match, failOptions = {}) => {
      editGh((state) => {
        state.failOn.push({ match, ...failOptions })
      })
    },
    onGhCall: (match, exec, ruleOptions = {}) => {
      editGh((state) => {
        state.onCall = [...(state.onCall ?? []), { match, exec, ...ruleOptions }]
      })
    },
    setJiraPermission: (key, granted) => {
      jira.permissions[key] = granted
    },
    addJiraVersion: (version) => {
      const id =
        version.id ?? String(Math.max(...[...jira.versions.keys()].map(Number), Number(DEFAULT_VERSION_ID)) + 1)

      const created: FakeJiraVersion = {
        self: `${jiraBaseUrl}/rest/api/3/version/${id}`,
        released: false,
        archived: false,
        projectId: JIRA_PROJECT_ID,
        ...version,
        id,
      }

      jira.versions.set(id, created)

      return structuredClone(created)
    },
    patchJiraVersion: (id, patch) => {
      const version = jira.versions.get(id)

      if (!version) throw new Error(`fixture: no Jira version ${id}`)

      jira.versions.set(id, { ...version, ...patch, id })
    },
    failJira: (failure) => {
      jira.failures.push({ ...failure, remaining: failure.times ?? 1 })
    },
    onJiraRequest: (observer) => {
      jira.observers.push(observer)

      return () => {
        jira.observers = jira.observers.filter((candidate) => {
          return candidate !== observer
        })
      }
    },
    rejectOnOrigin: (operation, ref) => {
      installOriginHook(layout.originDir, env)
      appendFileSync(join(layout.originDir, 'hooks', REJECTIONS_FILE), `${operation} ${ref}\n`)
    },
    clearOriginRejections: () => {
      writeFileSync(join(layout.originDir, 'hooks', REJECTIONS_FILE), '')
    },
    setOrcaMode: (mode) => {
      editOrca((state) => {
        state.mode = mode
      })
    },
    addOrcaTerminal: (worktree, title = 'fixture') => {
      let handle = ''

      editOrca((state) => {
        handle = `term-${state.nextHandle}`
        state.nextHandle += 1
        state.terminals.push({ handle, title, worktree })
      })

      return handle
    },
    failOrcaOn: (match, failOptions = {}) => {
      editOrca((state) => {
        state.failOn.push({ match, ...failOptions })
      })
    },
    pushAsTeammate,
    recreateBranchOnOrigin: (target, sha) => {
      gitIn(root, env, ['--git-dir', layout.originDir, 'update-ref', `refs/heads/${target}`, sha])
    },
    originSha: (target) => {
      return tryGit(root, env, [
        '--git-dir',
        layout.originDir,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${target}`,
      ])
    },
    cloneSha: (ref) => {
      return tryGit(layout.repoDir, env, ['rev-parse', '--verify', '--quiet', ref])
    },
    cleanup: async () => {
      await new Promise<void>((resolvePromise) => {
        jira.server.close(() => {
          resolvePromise()
        })
        jira.server.closeAllConnections()
      })
      rmSync(root, { force: true, recursive: true })
      rmSync(worktreesDir, { force: true, recursive: true })
    },
  }
}
