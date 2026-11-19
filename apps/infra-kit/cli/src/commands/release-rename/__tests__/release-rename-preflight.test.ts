import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  ReleaseRenameFixture,
  ReleaseRenameFixtureOptions,
  RunCliOverrides,
} from 'src/__tests__/helpers/release-rename-fixture'
import { branchSlug } from 'src/lib/git-utils/scratch-worktree'

import {
  SPAWN_TEST_TIMEOUT_MS,
  expectNothingMutated,
  git,
  output,
  registerCliBundle,
  runRename,
  snapshot,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 3 through the spawned CLI: every preflight refusal, each run WITH `--yes`, must exit
 * non-zero naming its cause and leave nothing mutated by the AC 1 measures.
 */

const cliPath = registerCliBundle('release-rename-preflight-')

const NEW_BRANCH = 'release/v1.3.0'

const listeners: Server[] = []

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map((server) => {
      return new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise()
        })
      })
    }),
  )
})

const listenOnLoopback = async (): Promise<number> => {
  const server = createServer()

  listeners.push(server)
  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise)
  })

  return (server.address() as AddressInfo).port
}

const anchorBody = (fixture: ReleaseRenameFixture): string => {
  return fixture.ghState().prs[0]!.body
}

/** A branch on origin plus an open PR on it, as GitHub requires for an OPEN PR to stay open. */
const addOpenPr = (fixture: ReleaseRenameFixture, head: string, base: string, body = ''): number => {
  if (fixture.originSha(head) === null) fixture.recreateBranchOnOrigin(head, fixture.originSha(fixture.branch)!)

  return fixture.addPr({ headRefName: head, baseRefName: base, body })
}

interface RefusalCase {
  name: string
  options?: ReleaseRenameFixtureOptions
  args?: string[]
  arrange?: (fixture: ReleaseRenameFixture) => Promise<RunCliOverrides | void> | RunCliOverrides | void
  cause: RegExp
}

const ARGUMENT_CASES: RefusalCase[] = [
  { name: '<new> is "next"', args: ['1.2.0', 'next'], cause: /"next" is not accepted as <new>/u },
  { name: '<new> equals <old>', args: ['1.2.0', '1.2.0'], cause: /<old> and <new> both name 1\.2\.0/u },
  { name: '<new> is not a valid name', args: ['1.2.0', 'Not A Name!'], cause: /Not A Name!/u },
]

const TAKEN_CASES: RefusalCase[] = [
  {
    name: '<new> is taken as a branch this rename does not own',
    arrange: (fixture) => {
      fixture.recreateBranchOnOrigin(NEW_BRANCH, fixture.originSha('main')!)
    },
    cause: /release\/v1\.3\.0 is taken/u,
  },
  {
    name: '<new> is taken as a Jira version with another id',
    arrange: (fixture) => {
      fixture.addJiraVersion({ id: '10050', name: 'v1.3.0' })
    },
    cause: /a different Jira version is already named v1\.3\.0/u,
  },
]

const ACTIVE_CASES: RefusalCase[] = [
  { name: 'the release has no PR (not active)', options: { pr: false }, cause: /not an active release/u },
  {
    name: 'the release PR is merged (not active)',
    arrange: (fixture) => {
      fixture.patchPr(1, { state: 'MERGED' })
    },
    cause: /PR #1 is merged/u,
  },
  { name: 'the Jira version is released', options: { jiraVersion: { released: true } }, cause: /released/u },
  { name: 'the Jira version is archived', options: { jiraVersion: { archived: true } }, cause: /archived/u },
]

const PERMISSION_CASES: RefusalCase[] = [
  {
    name: 'Jira is not configured',
    arrange: () => {
      return {
        env: { JIRA_BASE_URL: undefined, JIRA_TOKEN: undefined, JIRA_EMAIL: undefined, JIRA_PROJECT_ID: undefined },
      }
    },
    cause: /Jira is not configured/u,
  },
  {
    name: 'the Jira user lacks Administer Projects / Administer Jira',
    options: { jiraPermissions: { ADMINISTER_PROJECTS: false } },
    cause: /neither Administer Projects nor Administer Jira/u,
  },
  {
    name: 'the gh token has no push permission',
    arrange: (fixture) => {
      fixture.setPermissions({ push: false })
    },
    cause: /no push permission/u,
  },
  {
    name: '<old> is protected',
    arrange: (fixture) => {
      fixture.setProtected(fixture.branch, true)
    },
    cause: /release\/v1\.2\.0 is protected/u,
  },
  {
    name: 'a ruleset forbids deleting <old>',
    arrange: (fixture) => {
      fixture.setRules(fixture.branch, ['deletion'])
    },
    cause: /a ruleset forbids deleting release\/v1\.2\.0/u,
  },
  {
    name: 'a ruleset forbids creating <new>',
    arrange: (fixture) => {
      fixture.setRules(NEW_BRANCH, ['creation'])
    },
    cause: /a ruleset forbids creating release\/v1\.3\.0/u,
  },
]

const GITHUB_STATE_CASES: RefusalCase[] = [
  {
    name: '<old> has no commits ahead of its base',
    options: { localBranch: false },
    arrange: (fixture) => {
      fixture.recreateBranchOnOrigin(fixture.branch, fixture.originSha('dev')!)
    },
    cause: /no commits ahead of dev/u,
  },
  {
    name: 'a workflow run is active on <old>',
    arrange: (fixture) => {
      fixture.addRun({ headBranch: fixture.branch, status: 'in_progress' })
    },
    cause: /workflow runs are active on release\/v1\.2\.0/u,
  },
  {
    name: 'a merge-dev resolution for <old> is pending',
    arrange: (fixture) => {
      const dir = join(fixture.repoDir, '.git', 'infra-kit', 'merge-dev-resolutions')

      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${branchSlug(fixture.branch)}.json`), JSON.stringify({ branch: fixture.branch }))
    },
    cause: /merge-dev resolution for release\/v1\.2\.0 is pending/u,
  },
  {
    name: 'dual base: two open PRs on head <old>',
    arrange: (fixture) => {
      fixture.addPr({ headRefName: fixture.branch, baseRefName: 'main', body: anchorBody(fixture) })
    },
    cause: /release\/v1\.2\.0 has 2 open PRs/u,
  },
  {
    name: 'dual base: two open PRs on head <new>',
    arrange: (fixture) => {
      fixture.recreateBranchOnOrigin(NEW_BRANCH, fixture.originSha(fixture.branch)!)
      fixture.addPr({ headRefName: NEW_BRANCH, baseRefName: 'dev', body: anchorBody(fixture) })
      fixture.addPr({ headRefName: NEW_BRANCH, baseRefName: 'main', body: anchorBody(fixture) })
    },
    cause: /release\/v1\.3\.0 has 2 open PRs/u,
  },
]

const ANCHOR_CASES: RefusalCase[] = [
  {
    name: 'the PR body has no Jira link',
    arrange: (fixture) => {
      fixture.patchPr(1, { body: 'no link here' })
    },
    cause: /does not link a Jira fix version/u,
  },
  {
    name: 'the PR body links a different Jira version than the one named <old>',
    arrange: (fixture) => {
      fixture.addJiraVersion({ id: '10002', name: 'v9.9.9' })
      fixture.patchPr(1, { body: anchorBody(fixture).replace('/versions/10001/', '/versions/10002/') })
    },
    cause: /Jira version 10002 is named v9\.9\.9, neither v1\.2\.0 nor v1\.3\.0/u,
  },
  {
    name: 'the PR body links a Jira id that does not exist',
    arrange: (fixture) => {
      fixture.patchPr(1, { body: anchorBody(fixture).replace('/versions/10001/', '/versions/10099/') })
    },
    cause: /the Jira version linked from PR #1 was not found/u,
  },
  {
    name: 'another open release PR links the same Jira id',
    arrange: (fixture) => {
      addOpenPr(fixture, 'release/v1.5.0', 'dev', anchorBody(fixture))
    },
    cause: /other release PRs link the same Jira version: #2 \(release\/v1\.5\.0\)/u,
  },
  {
    name: 'a hand-edited, non-prefix state (origin <new> pushed, Jira untouched)',
    arrange: (fixture) => {
      fixture.recreateBranchOnOrigin(NEW_BRANCH, fixture.originSha(fixture.branch)!)
    },
    cause: /inconsistent state/u,
  },
]

const WORKTREE_CASES: RefusalCase[] = [
  {
    name: 'dev servers are live in the worktree',
    options: { worktree: true },
    arrange: async (fixture) => {
      const port = await listenOnLoopback()
      const dir = join(fixture.worktreeDir, '.infra-kit', 'dev-context')

      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'api.json'), JSON.stringify({ package: 'api', port, pid: process.pid }))
    },
    cause: /dev servers are listening from .*release\/v1\.2\.0 on port/u,
  },
  {
    name: 'the caller cwd is inside the worktree',
    options: { worktree: true },
    arrange: (fixture) => {
      return { cwd: fixture.worktreeDir }
    },
    // The management-context guard answers before the move guard's own cwd check can run.
    cause: /command run from inside a linked worktree/u,
  },
  {
    name: 'the caller runs in an Orca terminal of the worktree',
    options: { worktree: true },
    arrange: (fixture) => {
      return { env: { ORCA_WORKTREE_ID: `repo-1::${fixture.worktreeDir}` } }
    },
    cause: /inside an Orca terminal of/u,
  },
  {
    name: 'the worktree is locked',
    options: { worktree: true },
    arrange: (fixture) => {
      git(fixture, fixture.repoDir, ['worktree', 'lock', fixture.worktreeDir])
    },
    cause: /it is locked/u,
  },
  {
    name: 'the worktree has a submodule',
    options: { worktree: true },
    arrange: (fixture) => {
      git(fixture, fixture.worktreeDir, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        // The bare origin's HEAD names a branch it never had, so the default checkout would be unborn.
        '-b',
        'main',
        fixture.originDir,
        'vendored',
      ])
    },
    cause: /it has submodules/u,
  },
  {
    name: 'the worktree has an operation in progress',
    options: { worktree: true },
    arrange: (fixture) => {
      git(fixture, fixture.worktreeDir, ['bisect', 'start'])
    },
    cause: /a rebase, merge or bisect is in progress there/u,
  },
]

const runRefusal = async (refusal: RefusalCase): Promise<void> => {
  await withFixture(cliPath(), refusal.options ?? {}, async (fixture) => {
    const overrides = (await refusal.arrange?.(fixture)) ?? {}
    const before = snapshot(fixture)
    const run = await runRename(fixture, refusal.args ?? ['1.2.0', '1.3.0'], { yes: true, overrides })

    expect(run.code, output(run)).not.toBe(0)
    expect(run.code, output(run)).not.toBeNull()
    expect(`${run.stdout}\n${run.stderr}`, output(run)).toMatch(refusal.cause)
    expectNothingMutated(fixture, before)
  })
}

describe('release rename: preflight refusals (with --yes, zero mutation)', () => {
  it.each([
    ...ARGUMENT_CASES,
    ...TAKEN_CASES,
    ...ACTIVE_CASES,
    ...PERMISSION_CASES,
    ...GITHUB_STATE_CASES,
    ...ANCHOR_CASES,
    ...WORKTREE_CASES,
  ])('refuses: $name', runRefusal, SPAWN_TEST_TIMEOUT_MS)
})
