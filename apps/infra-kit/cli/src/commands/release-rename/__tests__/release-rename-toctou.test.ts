import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

import type { JiraRequest, ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'

import {
  HALF_RENAMED_WARNING,
  NEW_BRANCH,
  NEW_JIRA_NAME,
  NEW_SUFFIX,
  OLD_BRANCH,
  addChildPr,
  captureBaseline,
  expectAlreadyRenamed,
  expectConverged,
  expectFailedAt,
  expectNothingMutated,
  git,
  jiraVersion,
  output,
  prByNumber,
  registerCliBundle,
  renameOk,
  runRename,
  snapshot,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §2 principle 4: the four guards that re-run right before the step they protect. Each condition
 * is staged INSIDE one run, after preflight passed and before the guarded step — through the fake
 * Jira's request observer (in this process) or the fake gh's side-effect rule (a separate process) —
 * so only the mid-run guard can catch it. Each case asserts the residue report, and that the re-run
 * converges once the condition is cleared, or once the printed remediation is followed.
 */

const cliPath = registerCliBundle('release-rename-toctou-')

const TOCTOU_TEST_TIMEOUT_MS = 150_000
const ARGS = ['1.2.0', '1.3.0']

/** Run `effect` once, on the first Jira request `matches` accepts. */
const onceOnJira = (
  fixture: ReleaseRenameFixture,
  matches: (request: JiraRequest) => boolean,
  effect: () => void,
): void => {
  let fired = false

  const stop = fixture.onJiraRequest((request) => {
    if (fired || !matches(request)) return

    fired = true
    stop()
    effect()
  })
}

// `mypermissions` is preflight's last Jira read, after the classifier has already judged the version.
const isPermissionProbe = (request: JiraRequest): boolean => {
  return request.path.startsWith('/rest/api/3/mypermissions')
}

// The `jira` step's PUT: preflight is over, and every later step is still ahead.
const isJiraRename = (request: JiraRequest): boolean => {
  return request.method === 'PUT'
}

const listenOnLoopback = async (): Promise<Server> => {
  const server = createServer()

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise)
  })

  return server
}

const closeServer = (server: Server): Promise<void> => {
  return new Promise((resolvePromise) => {
    server.close(() => {
      resolvePromise()
    })
  })
}

/** The printed `git fetch origin && …` remediation, run as printed from the main checkout. */
const followMergeRemediation = (fixture: ReleaseRenameFixture, text: string): void => {
  const command = /(git fetch origin && .+?), then re-run/u.exec(text)?.[1]

  expect(command, text).toBeDefined()

  const result = spawnSync('/bin/sh', ['-c', command!], { cwd: fixture.repoDir, env: fixture.env, encoding: 'utf8' })

  expect(result.status, `${command}\n${result.stdout}\n${result.stderr}`).toBe(0)
}

const isAncestorOnOrigin = (fixture: ReleaseRenameFixture, ancestor: string, descendant: string): boolean => {
  return (
    spawnSync('/usr/bin/git', ['--git-dir', fixture.originDir, 'merge-base', '--is-ancestor', ancestor, descendant], {
      env: fixture.env,
    }).status === 0
  )
}

/** A teammate commit on top of `parent` that exists on origin but no branch points at yet. */
const stageTeammateCommit = (fixture: ReleaseRenameFixture, parent: string): string => {
  const sha = fixture.pushAsTeammate('teammate/staged', { ancestorOf: parent })

  git(fixture, fixture.root, ['--git-dir', fixture.originDir, 'update-ref', '-d', 'refs/heads/teammate/staged'])

  return sha
}

describe('release rename: mid-run guards (plan §2 principle 4)', () => {
  it.each(['archived', 'released'] as const)(
    'the version is %s between preflight and the jira step: refused there, nothing changed; un-doing it converges',
    async (flag) => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)
        const id = fixture.jiraVersionId!

        onceOnJira(fixture, isPermissionProbe, () => {
          fixture.patchJiraVersion(id, { [flag]: true })
        })

        const before = snapshot(fixture)
        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'jira')

        expect(text).toContain(`it was ${flag} after preflight`)
        expect(text).not.toContain(HALF_RENAMED_WARNING)
        expectNothingMutated(fixture, before)

        fixture.patchJiraVersion(id, { [flag]: false })

        await renameOk(fixture, ARGS)
        expectConverged(fixture, baseline)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'origin release/<old> moves between preflight and remote-push: the push refuses, the re-run carries the new tip',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)
        let teammateSha = ''

        onceOnJira(fixture, isJiraRename, () => {
          teammateSha = fixture.pushAsTeammate(OLD_BRANCH)
        })

        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'remote-push')

        expect(text).toMatch(/origin release\/v1\.2\.0 moved since preflight/u)
        expect(text).toContain(HALF_RENAMED_WARNING)
        expect(jiraVersion(fixture).name).toBe(NEW_JIRA_NAME)
        expect(fixture.originSha(NEW_BRANCH)).toBeNull()
        expect(fixture.originSha(OLD_BRANCH)).toBe(teammateSha)

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual([
          'remote-push',
          'pr-open',
          'pr-close',
          'remote-delete',
          'local-branch',
        ])
        expectConverged(fixture, baseline, teammateSha)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'release/<old> stops being an ancestor of release/<new> before remote-delete: refused with the merge remediation; following it converges',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)
        const teammateSha = stageTeammateCommit(fixture, baseline.remoteSha)

        // `pr close` is the last call before remote-delete: the teammate's push lands after pr-retarget.
        fixture.onGhCall(
          'pr close',
          ['/usr/bin/git', '--git-dir', fixture.originDir, 'update-ref', `refs/heads/${OLD_BRANCH}`, teammateSha],
          { once: true },
        )

        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'remote-delete')

        expect(text).toMatch(/git merge origin\/release\/v1\.2\.0/u)
        expect(text).toContain(HALF_RENAMED_WARNING)
        expect(fixture.originSha(OLD_BRANCH)).toBe(teammateSha)
        expect(fixture.originSha(NEW_BRANCH)).toBe(baseline.remoteSha)

        followMergeRemediation(fixture, text)

        const mergedTip = fixture.originSha(NEW_BRANCH)!

        expect(isAncestorOnOrigin(fixture, teammateSha, mergedTip)).toBe(true)

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['remote-delete', 'local-branch'])
        expectConverged(fixture, baseline, mergedTip)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'a dev server starts in the worktree between preflight and the worktree step: not moved; stopping it lets the re-run finish',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        const baseline = captureBaseline(fixture)
        const server = await listenOnLoopback()
        const stateDir = join(fixture.worktreeDir, '.infra-kit')

        try {
          const { port } = server.address() as AddressInfo

          // The fragment the `infra-kit dev` runner writes, plus a socket really listening on its port.
          onceOnJira(fixture, isJiraRename, () => {
            mkdirSync(join(stateDir, 'dev-context'), { recursive: true })
            writeFileSync(
              join(stateDir, 'dev-context', 'api.json'),
              JSON.stringify({ package: 'api', port, pid: process.pid }),
            )
          })

          const run = await runRename(fixture, ARGS, { yes: true })
          const text = expectFailedAt(run, 'worktree')

          expect(text).toMatch(
            new RegExp(`dev servers are listening from .*release/v1\\.2\\.0 on port\\(s\\) ${port}`, 'u'),
          )
          expect(text).not.toContain(HALF_RENAMED_WARNING)
          expect(existsSync(fixture.worktreeDir)).toBe(true)
          expect(existsSync(fixture.worktreePathFor(NEW_SUFFIX))).toBe(false)
          expect(git(fixture, fixture.worktreeDir, ['branch', '--show-current']).trim()).toBe(NEW_BRANCH)
        } finally {
          await closeServer(server)
        }

        rmSync(stateDir, { recursive: true, force: true })

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['worktree'])
        expectConverged(fixture, baseline)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'the new worktree path appears between preflight and the worktree step: not moved into it; removing it lets the re-run finish',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        const baseline = captureBaseline(fixture)
        const newPath = fixture.worktreePathFor(NEW_SUFFIX)
        const obstacle = join(newPath, 'obstacle.txt')

        onceOnJira(fixture, isJiraRename, () => {
          mkdirSync(newPath, { recursive: true })
          writeFileSync(obstacle, 'not a worktree\n')
        })

        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'worktree')

        expect(text).toContain(`${newPath} already exists`)
        expect(git(fixture, fixture.worktreeDir, ['branch', '--show-current']).trim()).toBe(NEW_BRANCH)
        expect(git(fixture, fixture.worktreeDir, ['status', '--porcelain'])).toBe(baseline.porcelain)
        expect(readdirSync(newPath)).toStrictEqual(['obstacle.txt'])

        rmSync(newPath, { recursive: true, force: true })

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['worktree'])
        expectConverged(fixture, baseline)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'a child PR is opened on release/<old> after pr-retarget: the delete refuses naming it; the re-run retargets it and converges',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const head = 'feature/late-child'

        fixture.recreateBranchOnOrigin(head, fixture.originSha(OLD_BRANCH)!)
        fixture.pushAsTeammate(head)

        // Opened on the integration branch, so preflight and pr-retarget see no child; retargeted onto
        // `<old>` by a teammate as `pr close` lands — after pr-retarget, before remote-delete.
        const child = fixture.addPr({ headRefName: head, baseRefName: fixture.baseBranch })
        const baseline = captureBaseline(fixture, [child])

        fixture.onGhCall('pr close', [join(fixture.binDir, 'gh'), 'pr', 'edit', String(child), '--base', OLD_BRANCH], {
          once: true,
        })

        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'remote-delete')

        expect(text).toContain(`#${child}`)
        expect(text).toContain(HALF_RENAMED_WARNING)
        expect(fixture.originSha(OLD_BRANCH)).toBe(baseline.remoteSha)
        expect(prByNumber(fixture, child)).toMatchObject({ state: 'OPEN', baseRefName: OLD_BRANCH })

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['pr-retarget', 'remote-delete', 'local-branch'])
        expectConverged(fixture, baseline)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )

  it(
    'release/<old> gains a teammate commit before pr-retarget with a child PR open: refused with the merge remediation; following it converges',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const child = addChildPr(fixture)
        const baseline = captureBaseline(fixture, [child])
        const teammateSha = stageTeammateCommit(fixture, baseline.remoteSha)

        // `pr create` is pr-open's call: remote-push has already pushed `<new>` at the preflight tip.
        fixture.onGhCall(
          'pr create',
          ['/usr/bin/git', '--git-dir', fixture.originDir, 'update-ref', `refs/heads/${OLD_BRANCH}`, teammateSha],
          { once: true },
        )

        const run = await runRename(fixture, ARGS, { yes: true })
        const text = expectFailedAt(run, 'pr-retarget')

        expect(text).toMatch(/git merge origin\/release\/v1\.2\.0/u)
        expect(text).toContain(HALF_RENAMED_WARNING)
        expect(prByNumber(fixture, child)).toMatchObject({ state: 'OPEN', baseRefName: OLD_BRANCH })
        expect(fixture.originSha(OLD_BRANCH)).toBe(teammateSha)
        expect(fixture.originSha(NEW_BRANCH)).toBe(baseline.remoteSha)

        followMergeRemediation(fixture, text)

        const mergedTip = fixture.originSha(NEW_BRANCH)!

        expect(isAncestorOnOrigin(fixture, teammateSha, mergedTip)).toBe(true)

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual([
          'pr-retarget',
          'pr-close',
          'remote-delete',
          'local-branch',
        ])
        expectConverged(fixture, baseline, mergedTip)
        await expectAlreadyRenamed(fixture)
      })
    },
    TOCTOU_TEST_TIMEOUT_MS,
  )
})
