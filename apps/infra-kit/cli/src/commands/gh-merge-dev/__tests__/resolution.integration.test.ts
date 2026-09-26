import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertRepoWithOrigin } from 'src/lib/git-guard'
import { getMainRepoRoot } from 'src/lib/git-utils'

import { ghMergeDev } from '../gh-merge-dev'
import { commitMerge } from '../resolution'

/**
 * @fileoverview
 *
 * The `--keep-conflicts` / `--continue` / `--abort` hand-off against real repositories with a bare
 * origin. Only the PR listing (network) and the repo-root lookup are mocked; every merge, scope
 * check, commit, hook, pnpm run and push is real — an injected executor would hide exactly the
 * git behaviour these checks depend on.
 */

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

vi.mock('src/lib/git-guard', () => {
  return { assertRepoWithOrigin: vi.fn(), assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return { ...actual, getMainRepoRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const EMPTY_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`

type Edit = (repo: string) => Promise<void>

interface FixtureSpec {
  base: Record<string, string>
  releases: Record<string, Edit>
  dev: Edit
  /** Runs on dev before the first commit, e.g. to generate a lockfile. */
  prepareBase?: Edit
}

interface Fixture {
  root: string
  origin: string
  repo: string
  releases: string[]
}

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  return (await $({ cwd, quiet: true })`git ${args}`).stdout.trim()
}

const write = async (dir: string, file: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await fs.writeFile(path.join(dir, file), content)
}

const exists = async (file: string): Promise<boolean> => {
  return fs.stat(file).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )
}

const makeFixture = async (spec: FixtureSpec): Promise<Fixture> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-res-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${repo}`
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'commit.gpgsign', 'false')

  for (const [file, content] of Object.entries(spec.base)) {
    await write(repo, file, content)
  }

  await spec.prepareBase?.(repo)
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')

  for (const [branch, edit] of Object.entries(spec.releases)) {
    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'switch', '-qc', branch)
    await edit(repo)
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', branch)
    await git(repo, 'push', '-q', '-u', 'origin', branch)
  }

  await git(repo, 'switch', '-q', 'dev')
  await spec.dev(repo)
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'dev work')
  await git(repo, 'push', '-q', 'origin', 'dev')
  await git(repo, 'fetch', '-q', 'origin')

  const releases = Object.keys(spec.releases)

  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue(
    releases.map((branch, index) => {
      return {
        branch,
        number: index + 1,
        title: `Release ${branch.slice('release/'.length)}`,
        createdAt: `2024-01-0${index + 1}T00:00:00Z`,
        baseRefName: 'dev',
        type: 'regular' as const,
        titleMismatch: false,
        dualBase: false,
      }
    }),
  )

  return { root, origin, repo, releases }
}

const conflictOn = (content: string): Edit => {
  return async (repo) => {
    await write(repo, 'conflict.txt', `line1\n${content}\nline3\n`)
  }
}

/** `release/v1.0.0` and `release/v1.1.0` conflict with dev on `conflict.txt`; `release/v1.2.0` merges clean. */
const codeConflictFixture = (): Promise<Fixture> => {
  return makeFixture({
    base: {
      'package.json': '{"name":"fx","private":true}\n',
      'pnpm-lock.yaml': EMPTY_LOCKFILE,
      '.gitignore': 'node_modules\n*.log\n',
      'base.txt': 'base\n',
      'conflict.txt': 'line1\nshared\nline3\n',
    },
    releases: {
      'release/v1.0.0': conflictOn('from release 1.0'),
      'release/v1.1.0': conflictOn('from release 1.1'),
      'release/v1.2.0': async (repo) => {
        await write(repo, 'release-1-2.txt', 'clean\n')
      },
    },
    dev: async (repo) => {
      await conflictOn('from dev')(repo)
      await write(repo, 'from-dev.txt', 'dev work\n')
    },
  })
}

const handOff = async () => {
  return (await ghMergeDev({ all: true, keepConflicts: true, confirmedCommand: true })).structuredContent
}

const worktreeOf = (repo: string, branch: string): string => {
  return path.join(`${repo}-worktrees`, 'merge-dev', branch.replace(/[^\w-]+/g, '-'))
}

const statePathOf = (repo: string, branch: string): string => {
  return path.join(repo, '.git', 'infra-kit', 'merge-dev-resolutions', `${branch.replace(/[^\w-]+/g, '-')}.json`)
}

const resolve = async (repo: string, branch: string, content = 'resolved'): Promise<void> => {
  await write(worktreeOf(repo, branch), 'conflict.txt', `line1\n${content}\nline3\n`)
}

/** The `--tree` value the last preview's `rerun` carried — what the human approved. */
let approvedTree: string | undefined

/** The unconfirmed `--continue` run an agent makes: it always stops with a structured refusal. */
const preview = async (versions: string | undefined, extra: { verify?: string; all?: boolean } = {}) => {
  agentMode.source = 'env'

  const error = await ghMergeDev({ continue: true, versions, ...extra, confirmedCommand: false }).catch(
    (e: unknown) => {
      return e
    },
  )

  expect(error).toBeInstanceOf(StructuredRefusalError)

  const content = (error as StructuredRefusalError).structuredContent as {
    status: string
    rerun?: string[]
    plan: { branches: Record<string, unknown>[] }
  }

  const treeAt = content.rerun?.indexOf('--tree') ?? -1

  if (treeAt >= 0) approvedTree = content.rerun?.[treeAt + 1]

  return { ...content, row: content.plan.branches[0] as Record<string, any> }
}

/** The confirming run, bound to the last preview's approved trees unless `tree` says otherwise. */
const confirmContinue = async (
  versions: string | undefined,
  extra: { verify?: string; all?: boolean; tree?: string } = {},
) => {
  return (await ghMergeDev({ continue: true, versions, tree: approvedTree, ...extra, confirmedCommand: true }))
    .structuredContent
}

const originSha = async (repo: string, branch: string): Promise<string> => {
  return (await git(repo, 'ls-remote', '--heads', 'origin', branch)).split(/\s+/)[0] ?? ''
}

const isRegistered = async (repo: string, worktreePath: string): Promise<boolean> => {
  return (await git(repo, 'worktree', 'list', '--porcelain')).includes(path.basename(worktreePath))
}

const installHook = async (dir: string, name: string, body: string): Promise<void> => {
  const file = path.join(dir, 'hooks', name)

  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

let sessionSeq = 0

beforeEach(() => {
  vi.clearAllMocks()
  sessionSeq += 1
  approvedTree = undefined
  process.env.INFRA_KIT_SESSION = `res${process.pid}x${sessionSeq}`
  vi.mocked(assertRepoWithOrigin).mockResolvedValue(undefined)
})

afterEach(() => {
  agentMode.source = null
})

afterAll(async () => {
  await Promise.all(
    tmpRoots.flatMap((root) => {
      return [
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(`${path.join(root, 'work')}-worktrees`, { recursive: true, force: true }),
      ]
    }),
  )
})

describe('--keep-conflicts hand-off (AC 2)', () => {
  it('pushes the clean branch, leaves each conflict mid-merge with a state file, and refuses a second hand-off', async () => {
    const { repo } = await codeConflictFixture()
    const baseSha = await git(repo, 'rev-parse', 'origin/release/v1.0.0')
    const devSha = await git(repo, 'rev-parse', 'origin/dev')

    const result = await handOff()

    // Exit 1 by design: the hand-off is not a finished run.
    expect(result.failedMerges).toBe(2)
    expect(
      await git(repo, 'merge-base', '--is-ancestor', devSha, 'origin/release/v1.2.0').then(() => {
        return true
      }),
    ).toBe(true)

    const entry = result.results.find((candidate) => {
      return candidate.branch === 'release/v1.0.0'
    })

    expect(entry?.resolution).toMatchObject({ state: 'needs-agent', baseSha, devSha, conflictPaths: ['conflict.txt'] })

    const wt = worktreeOf(repo, 'release/v1.0.0')

    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(baseSha)
    expect(await git(wt, 'rev-parse', 'MERGE_HEAD')).toBe(devSha)

    const state = JSON.parse(await fs.readFile(statePathOf(repo, 'release/v1.0.0'), 'utf8'))

    expect(state.autoMergeTree).toMatch(/^[0-9a-f]{40}$/)

    await resolve(repo, 'release/v1.0.0', 'work in progress')

    const again = await handOff()
    const second = again.results.find((candidate) => {
      return candidate.branch === 'release/v1.0.0'
    })

    expect(second?.resolution?.state).toBe('exists')
    expect(second?.reason).toMatch(/^resolution-exists/)
    expect(await fs.readFile(path.join(wt, 'conflict.txt'), 'utf8')).toBe('line1\nwork in progress\nline3\n')
    expect(await git(wt, 'rev-parse', 'MERGE_HEAD')).toBe(devSha)
  })
})

describe('--continue (AC 3–13)', () => {
  it('commits the previewed tree with parents (baseSha, devSha), pushes it and cleans up (AC 13)', async () => {
    const { repo } = await codeConflictFixture()

    await handOff()

    const baseSha = await git(repo, 'rev-parse', 'origin/release/v1.0.0')
    const devSha = await git(repo, 'rev-parse', 'origin/dev')

    await resolve(repo, 'release/v1.0.0')

    const { status, row } = await preview('1.0.0')

    expect(status).toBe('confirmation_required')
    expect(row).toMatchObject({
      branch: 'release/v1.0.0',
      baseSha,
      devSha,
      conflictPaths: ['conflict.txt'],
      lockfileMerged: false,
      verify: { ok: true },
    })
    expect(row.blocked).toBeUndefined()
    expect(row.treeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(row.diffStat).toContain('conflict.txt')
    expect(row.resolutionDiff).toContain('+resolved')

    const result = await confirmContinue('1.0.0')

    expect(result.results).toMatchObject([{ branch: 'release/v1.0.0', status: 'merged', pushed: true }])
    expect(result.failedMerges).toBe(0)

    const pushed = await originSha(repo, 'release/v1.0.0')

    expect(await git(repo, 'rev-list', '--parents', '-n', '1', pushed)).toBe(`${pushed} ${baseSha} ${devSha}`)
    expect(await git(repo, 'rev-parse', `${pushed}^{tree}`)).toBe(row.treeSha)

    const wt = worktreeOf(repo, 'release/v1.0.0')

    expect(await exists(wt)).toBe(false)
    expect(await isRegistered(repo, wt)).toBe(false)
    expect(await exists(statePathOf(repo, 'release/v1.0.0'))).toBe(false)
  })

  it('--abort removes the worktree, its registration and its state (AC 13)', async () => {
    const { repo } = await codeConflictFixture()

    await handOff()

    const wt = worktreeOf(repo, 'release/v1.1.0')
    const result = await ghMergeDev({ abort: true, versions: '1.1.0', confirmedCommand: true })

    expect(result.structuredContent.results).toMatchObject([{ branch: 'release/v1.1.0', status: 'aborted' }])
    expect(await exists(wt)).toBe(false)
    expect(await isRegistered(repo, wt)).toBe(false)
    expect(await exists(statePathOf(repo, 'release/v1.1.0'))).toBe(false)
    expect(await exists(worktreeOf(repo, 'release/v1.0.0'))).toBe(true)
  })

  describe('scope (AC 4)', () => {
    const cases: [string, Edit, string][] = [
      [
        'an unstaged edit to a non-conflicted tracked file',
        async (wt) => {
          await write(wt, 'base.txt', 'sneaky\n')
        },
        'base.txt',
      ],
      [
        'an untracked new file',
        async (wt) => {
          await write(wt, 'new.txt', 'new\n')
        },
        'new.txt',
      ],
      [
        'a staged out-of-scope edit',
        async (wt) => {
          await write(wt, 'base.txt', 'sneaky\n')
          await git(wt, 'add', 'base.txt')
        },
        'base.txt',
      ],
      [
        'a new ignored file outside node_modules',
        async (wt) => {
          await write(wt, 'debug.log', 'hidden\n')
        },
        'debug.log',
      ],
      [
        'a self-hiding untracked sub/.gitignore',
        async (wt) => {
          await write(wt, 'sub/.gitignore', '*\n')
          await write(wt, 'sub/payload.txt', 'hidden\n')
        },
        'sub/.gitignore',
      ],
      [
        'an edit hidden with --assume-unchanged',
        async (wt) => {
          await git(wt, 'update-index', '--assume-unchanged', 'base.txt')
          await write(wt, 'base.txt', 'sneaky\n')
        },
        'base.txt',
      ],
      [
        'an edit hidden with --skip-worktree',
        async (wt) => {
          await git(wt, 'update-index', '--skip-worktree', 'base.txt')
          await write(wt, 'base.txt', 'sneaky\n')
        },
        'base.txt',
      ],
      [
        'a staged pnpm-lock.yaml when the lockfile did not conflict',
        async (wt) => {
          await write(wt, 'pnpm-lock.yaml', `${EMPTY_LOCKFILE}\n# hand-made\n`)
          await git(wt, 'add', 'pnpm-lock.yaml')
        },
        'pnpm-lock.yaml',
      ],
    ]

    it.each(cases)('%s is out-of-scope-edit, and nothing is pushed', async (_name, tamper, offender) => {
      const { repo } = await codeConflictFixture()

      await handOff()

      const before = await originSha(repo, 'release/v1.0.0')

      await resolve(repo, 'release/v1.0.0')
      await tamper(worktreeOf(repo, 'release/v1.0.0'))

      const { status, row } = await preview('1.0.0')

      expect(status).toBe('refused')
      expect(row.blocked).toMatchObject({ code: 'out-of-scope-edit' })
      expect(row.blocked.paths).toContain(offender)

      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([
        { status: 'blocked', pushed: false, blocked: { code: 'out-of-scope-edit' } },
      ])
      expect(await originSha(repo, 'release/v1.0.0')).toBe(before)
    })

    it('a leftover conflict marker is markers-remaining', async () => {
      await codeConflictFixture()

      await handOff()

      const { status, row } = await preview('1.0.0')

      expect(status).toBe('refused')
      expect(row.blocked).toMatchObject({ code: 'markers-remaining', paths: ['conflict.txt'] })
    })
  })

  it('a --verify that rewrites a tracked file is verify-mutated-tree (AC 5)', async () => {
    const { repo } = await codeConflictFixture()

    await handOff()
    await resolve(repo, 'release/v1.0.0')

    const { status, row } = await preview('1.0.0', { verify: 'echo mutated > base.txt' })

    expect(status).toBe('refused')
    expect(row.blocked).toMatchObject({ code: 'verify-mutated-tree' })
    expect(row.blocked.paths).toContain('base.txt')
  })

  describe('content binding (AC 6)', () => {
    it('an edit after the preview is tree-changed, and nothing is pushed', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()
      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')

      const before = await originSha(repo, 'release/v1.0.0')

      await resolve(repo, 'release/v1.0.0', 'changed after approval')

      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'tree-changed', pushed: false }])
      expect(await originSha(repo, 'release/v1.0.0')).toBe(before)
      expect(await git(worktreeOf(repo, 'release/v1.0.0'), 'rev-parse', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/)
    })

    it('a later preview does not re-bind an earlier approval: rerun A after preview B is tree-changed', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()
      await resolve(repo, 'release/v1.0.0', 'version A')
      await preview('1.0.0')

      const treeA = approvedTree

      await resolve(repo, 'release/v1.0.0', 'version B')
      await preview('1.0.0')

      expect(approvedTree).not.toBe(treeA)

      const before = await originSha(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0', { tree: treeA })

      expect(result.results).toMatchObject([{ status: 'tree-changed', pushed: false }])
      expect(await originSha(repo, 'release/v1.0.0')).toBe(before)
    })

    it('a --yes with no approved tree commits nothing', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()
      await resolve(repo, 'release/v1.0.0')

      const wt = worktreeOf(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'tree-changed', pushed: false }])
      expect(result.results[0]?.reason).toMatch(/^not approved: .*release\/v1\.0\.0/)
      expect(await git(wt, 'rev-parse', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/)
    })

    it('a pre-commit hook that rewrites files is tree-changed, and nothing is pushed', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()
      await installHook(path.join(repo, '.git'), 'pre-commit', 'echo hooked >> conflict.txt && git add conflict.txt')
      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')

      const before = await originSha(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'tree-changed', pushed: false }])
      expect(result.results[0]?.reason).toContain('--abort')
      expect(await originSha(repo, 'release/v1.0.0')).toBe(before)

      // The unapproved commit stays unpushable, and says why, rather than a bare parents-mismatch.
      const { status, row } = await preview('1.0.0')

      expect(status).toBe('refused')
      expect(row.blocked).toMatchObject({ code: 'tree-changed' })
      expect(row.blocked.detail).toContain('--abort')
    })
  })

  it('a commit hook that needs a TTY is hook-failed after exactly one attempt, and the worktree is kept (AC 7)', async () => {
    const { repo, root } = await codeConflictFixture()
    const log = path.join(root, 'hook.log')

    await handOff()
    // Stands in for gpg pinentry or any prompt: opening the controlling terminal.
    await installHook(path.join(repo, '.git'), 'pre-commit', `echo attempt >> ${log}\nexec < /dev/tty\nread answer`)
    await resolve(repo, 'release/v1.0.0')
    await preview('1.0.0')

    const result = await confirmContinue('1.0.0')

    expect(result.results).toMatchObject([{ status: 'hook-failed', pushed: false }])
    expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toEqual(['attempt'])

    const wt = worktreeOf(repo, 'release/v1.0.0')

    expect(await exists(wt)).toBe(true)
    expect(await git(wt, 'rev-parse', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/)
    expect(await exists(statePathOf(repo, 'release/v1.0.0'))).toBe(true)
  })

  it('verify runs before git commit, so a hook that needs node_modules passes (AC 8)', async () => {
    const { repo, root } = await codeConflictFixture()
    const log = path.join(root, 'order.log')

    await handOff()
    await installHook(
      path.join(repo, '.git'),
      'pre-commit',
      `test -d node_modules || { echo "no node_modules" >&2; exit 1; }\necho "commit $(node -e 'console.log(Date.now())')" >> ${log}`,
    )
    await resolve(repo, 'release/v1.0.0')

    const verify = `echo "verify $(node -e 'console.log(Date.now())')" >> ${log}`

    await preview('1.0.0', { verify })

    const result = await confirmContinue('1.0.0', { verify })

    expect(result.results).toMatchObject([{ status: 'merged', pushed: true }])

    const entries = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [kind, at] = line.split(' ')

        return { kind, at: Number(at) }
      })

    expect(
      entries.map((entry) => {
        return entry.kind
      }),
    ).toEqual(['verify', 'verify', 'commit'])
    expect(entries[1]!.at).toBeLessThanOrEqual(entries[2]!.at)
  })

  describe('recorded dev (AC 9)', () => {
    it('pushes with the recorded devSha when origin/dev advanced after the hand-off', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()

      const devSha = await git(repo, 'rev-parse', 'origin/dev')

      await write(repo, 'later.txt', 'later\n')
      await git(repo, 'add', 'later.txt')
      await git(repo, 'commit', '-qm', 'later dev work')
      await git(repo, 'push', '-q', 'origin', 'dev')
      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')

      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'merged', pushed: true }])

      const pushed = await originSha(repo, 'release/v1.0.0')

      expect(await git(repo, 'rev-parse', `${pushed}^2`)).toBe(devSha)
      expect(await originSha(repo, 'dev')).not.toBe(devSha)
    })

    it('reports up-to-date when a teammate merged devSha, and removes the worktree and state', async () => {
      const { repo, root } = await codeConflictFixture()

      await handOff()

      const devSha = await git(repo, 'rev-parse', 'origin/dev')

      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')

      const teammate = path.join(root, 'teammate')

      await git(repo, 'worktree', 'add', '-q', '--detach', teammate, 'origin/release/v1.0.0')
      await git(teammate, 'merge', '-q', '-X', 'ours', '--no-edit', devSha)
      await git(teammate, 'push', '-q', 'origin', 'HEAD:refs/heads/release/v1.0.0')

      const teammateSha = await originSha(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'up-to-date', pushed: false }])
      expect(result.failedMerges).toBe(0)
      expect(await originSha(repo, 'release/v1.0.0')).toBe(teammateSha)

      const wt = worktreeOf(repo, 'release/v1.0.0')

      expect(await exists(wt)).toBe(false)
      expect(await isRegistered(repo, wt)).toBe(false)
      expect(await exists(statePathOf(repo, 'release/v1.0.0'))).toBe(false)
    })
  })

  describe('rewind (AC 10)', () => {
    it('a force-rewind of origin/<b> to an ancestor blocks the branch and pushes nothing', async () => {
      const { repo } = await codeConflictFixture()

      await handOff()

      const baseSha = await git(repo, 'rev-parse', 'origin/release/v1.0.0')

      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')
      await git(repo, 'push', '-q', '-f', 'origin', `${baseSha}~1:refs/heads/release/v1.0.0`)

      const rewound = await originSha(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'blocked', blocked: { code: 'parents-mismatch' } }])
      expect(result.results[0]?.reason).toContain('rewound')
      expect(await originSha(repo, 'release/v1.0.0')).toBe(rewound)
    })

    it('a new commit on origin/<b> blocks the branch too', async () => {
      const { repo, root } = await codeConflictFixture()

      await handOff()
      await resolve(repo, 'release/v1.0.0')
      await preview('1.0.0')

      const other = path.join(root, 'other')

      await git(repo, 'worktree', 'add', '-q', '--detach', other, 'origin/release/v1.0.0')
      await write(other, 'hotfix.txt', 'hotfix\n')
      await git(other, 'add', 'hotfix.txt')
      await git(other, 'commit', '-qm', 'hotfix')
      await git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/release/v1.0.0')

      const moved = await originSha(repo, 'release/v1.0.0')
      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'blocked', blocked: { code: 'parents-mismatch' } }])
      expect(await originSha(repo, 'release/v1.0.0')).toBe(moved)
    })
  })

  describe('conflict kinds (AC 11)', () => {
    it('resolves a modify/delete either way, and the deletion lands', async () => {
      const { repo } = await makeFixture({
        base: {
          'package.json': '{"name":"fx","private":true}\n',
          'pnpm-lock.yaml': EMPTY_LOCKFILE,
          '.gitignore': 'node_modules\n',
          'md.txt': 'keep\n',
        },
        releases: {
          'release/v1.0.0': async (repo) => {
            await fs.rm(path.join(repo, 'md.txt'))
          },
          'release/v1.1.0': async (repo) => {
            await fs.rm(path.join(repo, 'md.txt'))
          },
        },
        dev: async (repo) => {
          await write(repo, 'md.txt', 'modified on dev\n')
        },
      })

      const handed = await handOff()

      expect(handed.results[0]?.resolution?.conflictPaths).toEqual(['md.txt'])

      await fs.rm(path.join(worktreeOf(repo, 'release/v1.0.0'), 'md.txt'))

      await preview('1.0.0,1.1.0', {})

      const result = await confirmContinue('1.0.0,1.1.0')

      expect(result.results).toMatchObject([
        { branch: 'release/v1.0.0', status: 'merged', pushed: true },
        { branch: 'release/v1.1.0', status: 'merged', pushed: true },
      ])
      await git(repo, 'fetch', '-q', 'origin')
      expect(await git(repo, 'ls-tree', '--name-only', 'origin/release/v1.0.0')).not.toContain('md.txt')
      expect(await git(repo, 'show', 'origin/release/v1.1.0:md.txt')).toBe('modified on dev')
    })

    it('puts every rename/rename path in conflictPaths, and the resolution passes the scope check', async () => {
      const { repo } = await makeFixture({
        base: {
          'package.json': '{"name":"fx","private":true}\n',
          'pnpm-lock.yaml': EMPTY_LOCKFILE,
          '.gitignore': 'node_modules\n',
          'ren.txt': 'original\n',
        },
        releases: {
          'release/v1.0.0': async (repo) => {
            await fs.rename(path.join(repo, 'ren.txt'), path.join(repo, 'rel-name.txt'))
          },
        },
        dev: async (repo) => {
          await fs.rename(path.join(repo, 'ren.txt'), path.join(repo, 'dev-name.txt'))
        },
      })

      const handed = await handOff()

      expect(handed.results[0]?.resolution?.conflictPaths).toEqual(
        expect.arrayContaining(['ren.txt', 'rel-name.txt', 'dev-name.txt']),
      )

      await fs.rm(path.join(worktreeOf(repo, 'release/v1.0.0'), 'rel-name.txt'))

      const { row } = await preview('1.0.0')

      expect(row.blocked).toBeUndefined()

      const result = await confirmContinue('1.0.0')

      expect(result.results).toMatchObject([{ status: 'merged', pushed: true }])
      await git(repo, 'fetch', '-q', 'origin')
      expect(await git(repo, 'ls-tree', '--name-only', 'origin/release/v1.0.0')).toContain('dev-name.txt')
    })

    it('labels a rerere pre-resolution as rerere, not agent', async () => {
      const { repo } = await codeConflictFixture()

      await git(repo, 'config', 'rerere.enabled', 'true')

      // Record a resolution once, the way an operator's earlier manual merge would have.
      await git(repo, 'switch', '-q', '--detach', 'origin/release/v1.0.0')
      await git(repo, 'merge', '-q', 'origin/dev').catch(() => {
        return ''
      })
      await write(repo, 'conflict.txt', 'line1\nrecorded\nline3\n')
      await git(repo, 'add', 'conflict.txt')
      await git(repo, 'rerere')
      await git(repo, 'merge', '--abort')
      await git(repo, 'switch', '-q', 'dev')

      const handed = await handOff()
      const entry = handed.results.find((candidate) => {
        return candidate.branch === 'release/v1.0.0'
      })

      expect(entry?.resolution?.rererePreResolved).toEqual(['conflict.txt'])

      const { row } = await preview('1.0.0')

      expect(row.rerereFiles).toEqual(['conflict.txt'])
      expect(row.resolutionDiff).toContain('# rerere (recorded resolution)\ndiff --git a/conflict.txt')
      expect(row.resolutionDiff).toContain('+recorded')
    })
  })

  it('a push that fails once resumes from the committed state and pushes the same sha (AC 12a)', async () => {
    const { repo, origin } = await codeConflictFixture()

    await handOff()
    await installHook(
      origin,
      'pre-receive',
      'if [ ! -f "$GIT_DIR/rejected-once" ]; then touch "$GIT_DIR/rejected-once"; echo "rejected once" >&2; exit 1; fi',
    )
    await resolve(repo, 'release/v1.0.0')
    await preview('1.0.0')

    const first = await confirmContinue('1.0.0')

    expect(first.results).toMatchObject([{ status: 'push-aborted', pushed: false }])

    const wt = worktreeOf(repo, 'release/v1.0.0')
    const mergeSha = first.results[0]?.mergeSha

    expect(await exists(wt)).toBe(true)
    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(mergeSha)

    // Same argv, same approved tree: the resume must push the commit already made, not a new one.
    const second = await confirmContinue('1.0.0')

    expect(second.results).toMatchObject([{ status: 'merged', pushed: true, mergeSha }])
    expect(await originSha(repo, 'release/v1.0.0')).toBe(mergeSha)
  })

  it('pushes only the ready branch when another is blocked (AC 12)', async () => {
    const { repo } = await codeConflictFixture()

    await handOff()
    await resolve(repo, 'release/v1.0.0')

    const before = await originSha(repo, 'release/v1.1.0')
    const { status, plan } = await preview(undefined, { all: true })

    expect(status).toBe('confirmation_required')
    expect(
      plan.branches.map((row) => {
        return [row.branch, (row.blocked as { code?: string } | undefined)?.code]
      }),
    ).toEqual([
      ['release/v1.0.0', undefined],
      ['release/v1.1.0', 'markers-remaining'],
    ])

    const result = await confirmContinue(undefined, { all: true })

    expect(result.results).toMatchObject([
      { branch: 'release/v1.0.0', status: 'merged', pushed: true },
      { branch: 'release/v1.1.0', status: 'blocked', pushed: false },
    ])
    expect(result.failedMerges).toBe(1)
    expect(await originSha(repo, 'release/v1.1.0')).toBe(before)
  })
})

describe('lockfile-only conflict (AC 3, S0-PASS)', () => {
  // Needs the npm registry (or a warm pnpm metadata cache) for ms / is-odd / is-number.
  const lockfileFixture = (): Promise<Fixture> => {
    return makeFixture({
      base: {
        'package.json': '{"name":"root","private":true}\n',
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
        '.gitignore': 'node_modules\n',
        'packages/a/package.json': '{"name":"a","version":"1.0.0","dependencies":{"ms":"2.0.0"}}\n',
        'packages/b/package.json': '{"name":"b","version":"1.0.0"}\n',
      },
      // Lock ms at 2.0.0, then widen the range: a re-resolve from scratch would pick 2.1.x.
      prepareBase: async (repo) => {
        await $({ cwd: repo, quiet: true })`pnpm install --lockfile-only --ignore-scripts`
        await write(repo, 'packages/a/package.json', '{"name":"a","version":"1.0.0","dependencies":{"ms":"^2.0.0"}}\n')
        await $({ cwd: repo, quiet: true })`pnpm install --lockfile-only --ignore-scripts`
      },
      releases: {
        'release/v2.0.0': async (repo) => {
          await write(
            repo,
            'packages/a/package.json',
            '{"name":"a","version":"1.0.0","dependencies":{"ms":"^2.0.0","is-odd":"^3.0.1"}}\n',
          )
          await $({ cwd: repo, quiet: true })`pnpm install --lockfile-only --ignore-scripts`
        },
      },
      dev: async (repo) => {
        await write(
          repo,
          'packages/b/package.json',
          '{"name":"b","version":"1.0.0","dependencies":{"is-number":"^7.0.0"}}\n',
        )
        await $({ cwd: repo, quiet: true })`pnpm install --lockfile-only --ignore-scripts`
      },
    })
  }

  it('merges pnpm-lock.yaml from dev’s side, keeps ranged pins, and pushes with parents (baseSha, devSha)', async () => {
    const { repo } = await lockfileFixture()
    const baseSha = await git(repo, 'rev-parse', 'origin/release/v2.0.0')
    const devSha = await git(repo, 'rev-parse', 'origin/dev')
    const handed = await handOff()

    expect(handed.results[0]?.resolution).toMatchObject({
      state: 'lockfile-only',
      lockfileOnly: true,
      conflictPaths: ['pnpm-lock.yaml'],
    })

    const { row } = await preview('2.0.0')

    expect(row).toMatchObject({ lockfileMerged: true, verify: { ok: true } })
    expect(row.blocked).toBeUndefined()
    expect(row.lockfileDiffStat.vsDev).toContain('pnpm-lock.yaml')

    const result = await confirmContinue('2.0.0')

    expect(result.results).toMatchObject([{ status: 'merged', pushed: true }])

    const pushed = await originSha(repo, 'release/v2.0.0')

    expect(await git(repo, 'rev-list', '--parents', '-n', '1', pushed)).toBe(`${pushed} ${baseSha} ${devSha}`)

    const lockfile = await git(repo, 'show', `${pushed}:pnpm-lock.yaml`)

    expect(lockfile).not.toMatch(/^<{7}|^>{7}/m)
    expect(lockfile).toContain('is-odd@3.0.1')
    expect(lockfile).toMatch(/is-number@7\./)
    expect(lockfile).toContain('ms@2.0.0')
    expect(lockfile).not.toMatch(/ms@2\.1\./)
  })

  it('replaces a lockfile the agent staged by hand, blocks once, and never pushes it', async () => {
    const { repo } = await lockfileFixture()

    await handOff()

    const wt = worktreeOf(repo, 'release/v2.0.0')

    await fs.writeFile(path.join(wt, 'pnpm-lock.yaml'), `${await git(wt, 'show', ':3:pnpm-lock.yaml')}\n# hand-made\n`)
    await git(wt, 'add', 'pnpm-lock.yaml')

    const first = await preview('2.0.0')

    expect(first.status).toBe('refused')
    expect(first.row.blocked).toMatchObject({ code: 'out-of-scope-edit', paths: ['pnpm-lock.yaml'] })
    expect(await git(wt, 'show', ':pnpm-lock.yaml')).not.toContain('hand-made')

    const second = await preview('2.0.0')

    expect(second.row.blocked).toBeUndefined()

    const result = await confirmContinue('2.0.0')

    expect(result.results).toMatchObject([{ status: 'merged', pushed: true }])
    expect(await git(repo, 'show', `${await originSha(repo, 'release/v2.0.0')}:pnpm-lock.yaml`)).not.toContain(
      'hand-made',
    )
  })

  it('names a registry move, not a foreign edit, when the rebuild differs from the CLI’s own last rebuild', async () => {
    const { repo } = await lockfileFixture()

    await handOff()

    const wt = worktreeOf(repo, 'release/v2.0.0')

    expect((await preview('2.0.0')).row.blocked).toBeUndefined()

    // Stand in for "pnpm resolved differently last time": the staged lockfile and the state file's
    // record of the CLI's last rebuild both name a blob the next rebuild will not reproduce.
    await fs.writeFile(
      path.join(wt, 'pnpm-lock.yaml'),
      `${await git(wt, 'show', ':pnpm-lock.yaml')}\n# older resolve\n`,
    )
    await git(wt, 'add', 'pnpm-lock.yaml')

    const stateDir = path.join(
      await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      'infra-kit',
      'merge-dev-resolutions',
    )
    const [stateName] = await fs.readdir(stateDir)
    const stateFile = path.join(stateDir, stateName as string)
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))

    state.lockfileBlob = await git(wt, 'rev-parse', ':pnpm-lock.yaml')
    await fs.writeFile(stateFile, JSON.stringify(state))

    const drifted = await preview('2.0.0')

    expect(drifted.row.blocked).toMatchObject({ code: 'tree-changed', paths: ['pnpm-lock.yaml'] })
    expect(drifted.row.blocked.detail).toContain('registry moved')
    expect(drifted.row.blocked.detail).not.toContain('something other than the CLI')
    expect(await git(wt, 'show', ':pnpm-lock.yaml')).not.toContain('older resolve')
    expect((await preview('2.0.0')).row.blocked).toBeUndefined()
  })
})

describe('commitMerge', () => {
  it('kills a hook that hangs and reports the timeout', async () => {
    const { repo, root } = await codeConflictFixture()

    await handOff()

    const wt = worktreeOf(repo, 'release/v1.0.0')

    await installHook(path.join(repo, '.git'), 'pre-commit', `echo $$ > ${path.join(root, 'hook.pid')}\nsleep 60`)
    await resolve(repo, 'release/v1.0.0')
    await git(wt, 'add', 'conflict.txt')

    const startedAt = Date.now()
    const outcome = await commitMerge(wt, 1000)

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') })
    expect(Date.now() - startedAt).toBeLessThan(15_000)

    const hookPid = Number((await fs.readFile(path.join(root, 'hook.pid'), 'utf8')).trim())

    expect(() => {
      return process.kill(hookPid, 0)
    }).toThrow()
    expect(await git(wt, 'rev-parse', 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/)
    await expect(git(wt, 'add', 'conflict.txt')).resolves.toBeDefined()
  })
})
