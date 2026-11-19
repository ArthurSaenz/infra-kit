import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import { isReadOnlyGhCall } from 'src/__tests__/helpers/release-rename-fixture'

import { STEP_ORDER } from '../rename-classifier'
import type { RenameStep } from '../rename-classifier'
import {
  FORWARD_LINE,
  HALF_RENAMED_WARNING,
  NEW_BRANCH,
  NEW_JIRA_NAME,
  NEW_SUFFIX,
  OLD_BRANCH,
  UNDO_LINE,
  addChildPr,
  captureBaseline,
  expectAlreadyRenamed,
  expectConverged,
  expectNothingMutated,
  jiraVersion,
  markerComments,
  openPrsOn,
  output,
  prByNumber,
  registerCliBundle,
  renameOk,
  reportText,
  runRename,
  snapshot,
  withFixture,
} from './rename-spawn'
import type { RenameBaseline } from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 8 and AC 9 through the spawned CLI: a failure at each step k leaves a per-place residue
 * report and no rollback; re-running the identical command skips what is done and converges to AC 4-7;
 * a third run is "already renamed" with nothing mutated. Plus the named resume states of plan §4 Step 5:
 * both PRs open, a teammate's push to `<old>`, `<old>` recreated as an ancestor, the reverse rename,
 * the Jira-only residue and the old PR closed without the marker.
 */

const cliPath = registerCliBundle('release-rename-resume-')

/** Three spawned runs, one of them waiting out the ~3 s post-move quiet period. */
const RESUME_TEST_TIMEOUT_MS = 150_000

const ARGS = ['1.2.0', '1.3.0']

const stepIndex = (step: RenameStep): number => {
  return STEP_ORDER.indexOf(step)
}

interface StepFailure {
  step: RenameStep
  /** How the step is made to fail for real; reported in the case name. */
  how: string
  inject: (fixture: ReleaseRenameFixture) => void
  clear: (fixture: ReleaseRenameFixture) => void
}

// A held ref lock is what a concurrent git process leaves; `git branch -m` refuses to take it.
const newBranchLock = (fixture: ReleaseRenameFixture): string => {
  return join(fixture.repoDir, '.git', 'refs', 'heads', 'release', `${NEW_SUFFIX}.lock`)
}

const releaseWorktreesDir = (fixture: ReleaseRenameFixture): string => {
  return join(fixture.worktreesDir, 'release')
}

const noop = (): void => {}

const STEP_FAILURES: StepFailure[] = [
  {
    step: 'jira',
    how: 'the fake Jira answers the PUT with a 500',
    inject: (fixture) => {
      fixture.failJira({ method: 'PUT', pathPrefix: '/rest/api/3/version/', status: 500 })
    },
    clear: noop,
  },
  {
    step: 'remote-push',
    how: "origin's update hook rejects creating release/<new>",
    inject: (fixture) => {
      fixture.rejectOnOrigin('create', `refs/heads/${NEW_BRANCH}`)
    },
    clear: (fixture) => {
      fixture.clearOriginRejections()
    },
  },
  {
    step: 'pr-open',
    how: 'the fake gh fails `pr create` once',
    inject: (fixture) => {
      fixture.failGhOn('pr create', { once: true })
    },
    clear: noop,
  },
  {
    step: 'pr-retarget',
    how: 'the fake gh fails `pr edit` once',
    inject: (fixture) => {
      fixture.failGhOn('pr edit', { once: true })
    },
    clear: noop,
  },
  {
    step: 'pr-close',
    how: 'the fake gh fails `pr close` once',
    inject: (fixture) => {
      fixture.failGhOn('pr close', { once: true })
    },
    clear: noop,
  },
  {
    step: 'remote-delete',
    how: "origin's update hook rejects deleting release/<old>",
    inject: (fixture) => {
      fixture.rejectOnOrigin('delete', `refs/heads/${OLD_BRANCH}`)
    },
    clear: (fixture) => {
      fixture.clearOriginRejections()
    },
  },
  {
    step: 'local-branch',
    how: 'a held refs/heads/release/<new>.lock in the clone',
    inject: (fixture) => {
      mkdirSync(join(newBranchLock(fixture), '..'), { recursive: true })
      writeFileSync(newBranchLock(fixture), '')
    },
    clear: (fixture) => {
      rmSync(newBranchLock(fixture))
    },
  },
  {
    step: 'worktree',
    how: 'the worktrees parent directory is read-only, so the rename(2) of the move fails',
    inject: (fixture) => {
      chmodSync(releaseWorktreesDir(fixture), 0o555)
    },
    clear: (fixture) => {
      chmodSync(releaseWorktreesDir(fixture), 0o755)
    },
  },
]

const expectedWord = (index: number, failedAt: number): string => {
  if (index < failedAt) return 'renamed'
  if (index === failedAt) return 'NOT renamed \\(failed here\\)'

  return 'not renamed'
}

const expectResidueReport = (text: string, failedAt: number): void => {
  for (const [index, step] of STEP_ORDER.entries()) {
    expect(text).toMatch(new RegExp(`^  ${step}: ${expectedWord(index, failedAt)}$`, 'mu'))
  }

  expect(text).toContain(FORWARD_LINE)
  expect(text).toContain(UNDO_LINE)

  const jiraDone = failedAt > stepIndex('jira')
  const deleteDone = failedAt > stepIndex('remote-delete')

  expect(text.includes(HALF_RENAMED_WARNING)).toBe(jiraDone && !deleteDone)
}

type EffectCheck = (fixture: ReleaseRenameFixture, baseline: RenameBaseline, done: boolean) => void

/** Each step's observable effect, asserted present when `done` and absent otherwise. */
const EFFECTS: Record<RenameStep, EffectCheck> = {
  jira: (fixture, _baseline, done) => {
    expect(jiraVersion(fixture).name).toBe(done ? NEW_JIRA_NAME : 'v1.2.0')
  },
  'remote-push': (fixture, baseline, done) => {
    expect(fixture.originSha(NEW_BRANCH)).toBe(done ? baseline.remoteSha : null)
  },
  'pr-open': (fixture, _baseline, done) => {
    expect(openPrsOn(fixture, [NEW_BRANCH])).toHaveLength(done ? 1 : 0)
  },
  'pr-retarget': (fixture, baseline, done) => {
    for (const child of baseline.children) {
      expect(prByNumber(fixture, child)).toMatchObject({ state: 'OPEN', baseRefName: done ? NEW_BRANCH : OLD_BRANCH })
    }
  },
  'pr-close': (fixture, _baseline, done) => {
    expect(prByNumber(fixture, 1).state).toBe(done ? 'CLOSED' : 'OPEN')
    expect(markerComments(prByNumber(fixture, 1))).toHaveLength(done ? 1 : 0)
  },
  'remote-delete': (fixture, baseline, done) => {
    expect(fixture.originSha(OLD_BRANCH)).toBe(done ? null : baseline.remoteSha)
  },
  'local-branch': (fixture, baseline, done) => {
    expect(fixture.cloneSha(`refs/heads/${NEW_BRANCH}`)).toBe(done ? baseline.localSha : null)
    expect(fixture.cloneSha(`refs/heads/${OLD_BRANCH}`)).toBe(done ? null : baseline.localSha)
  },
  worktree: (fixture, _baseline, done) => {
    expect(existsSync(fixture.worktreePathFor(NEW_SUFFIX))).toBe(done)
    expect(existsSync(fixture.worktreeDir)).toBe(!done)
  },
}

const expectEffectsThrough = (fixture: ReleaseRenameFixture, baseline: RenameBaseline, failedAt: number): void => {
  for (const [index, step] of STEP_ORDER.entries()) {
    EFFECTS[step](fixture, baseline, index < failedAt)
  }
}

/** Every write is a forward one: a rollback would close the new PR, retarget back, or PUT the old name. */
const isForwardGhWrite = (argv: string[], children: number[]): boolean => {
  const [group, verb, target, flag, value] = argv

  if (group !== 'pr') return false
  if (verb === 'create') return argv.at(argv.indexOf('--head') + 1) === NEW_BRANCH
  if (verb === 'edit') return children.includes(Number(target)) && flag === '--base' && value === NEW_BRANCH
  if (verb === 'close') return target === '1'

  return false
}

const expectNoCompensation = (fixture: ReleaseRenameFixture, children: number[]): void => {
  const backward = fixture.mutatingGhCalls().filter((argv) => {
    return !isForwardGhWrite(argv, children)
  })

  expect(backward).toStrictEqual([])

  const writes = fixture.jiraRequests().filter((request) => {
    return request.method !== 'GET'
  })

  for (const write of writes) {
    expect(write).toMatchObject({ method: 'PUT', body: { name: NEW_JIRA_NAME } })
  }
}

const GH_VERB_OF_STEP: Partial<Record<RenameStep, string>> = {
  'pr-open': 'create',
  'pr-retarget': 'edit',
  'pr-close': 'close',
}

/** Earlier steps are done, so the re-run performs exactly the suffix of the order from the failed one. */
const remainingSteps = (failedAt: number): RenameStep[] => {
  return STEP_ORDER.slice(failedAt)
}

const expectRerunSkipsDone = (
  fixture: ReleaseRenameFixture,
  before: ReturnType<typeof snapshot>,
  steps: RenameStep[],
): void => {
  const ghWrites = fixture
    .ghLog()
    .slice(before.ghCalls)
    .filter((argv) => {
      return !isReadOnlyGhCall(argv)
    })
    .map((argv) => {
      return argv[1]
    })

  const expectedVerbs = steps.flatMap((step) => {
    const verb = GH_VERB_OF_STEP[step]

    return verb === undefined ? [] : [verb]
  })

  expect(ghWrites).toStrictEqual(expectedVerbs)

  const puts = fixture
    .jiraRequests()
    .slice(before.jiraCalls)
    .filter((request) => {
      return request.method === 'PUT'
    })

  expect(puts).toHaveLength(steps.includes('jira') ? 1 : 0)
}

const runStepFailureCase = async ({ step, inject, clear }: StepFailure): Promise<void> => {
  await withFixture(cliPath(), { worktree: true }, async (fixture) => {
    const baseline = captureBaseline(fixture, [addChildPr(fixture)])
    const failedAt = stepIndex(step)

    inject(fixture)

    const failed = await runRename(fixture, ARGS, { yes: true })

    clear(fixture)

    expect(failed.code, output(failed)).toBe(1)
    expectResidueReport(reportText(failed), failedAt)
    expectEffectsThrough(fixture, baseline, failedAt)
    expectNoCompensation(fixture, baseline.children)
    // Principle 2: a release PR stays open at every step boundary, the failed one included.
    expect(openPrsOn(fixture, [OLD_BRANCH, NEW_BRANCH]).length).toBeGreaterThanOrEqual(1)

    const before = snapshot(fixture)
    const rerun = await renameOk(fixture, ARGS)
    const steps = remainingSteps(failedAt)

    // A conflict ("changed by hand") would have exited non-zero: this is the resume classification.
    expect(rerun.json, output(rerun)).toMatchObject({ outcome: 'renamed', renamedSteps: steps })
    expectRerunSkipsDone(fixture, before, steps)
    expectConverged(fixture, baseline)
    expectNoCompensation(fixture, baseline.children)

    await expectAlreadyRenamed(fixture)
  })
}

describe('release rename: failure at step k, then resume (AC 8, AC 9)', () => {
  it.each(STEP_FAILURES)(
    'step $step fails ($how): residue report, no rollback, the re-run converges, a third run is a no-op',
    runStepFailureCase,
    RESUME_TEST_TIMEOUT_MS,
  )
})

const failAt = async (fixture: ReleaseRenameFixture, failure: StepFailure): Promise<void> => {
  failure.inject(fixture)

  const failed = await runRename(fixture, ARGS, { yes: true })

  failure.clear(fixture)

  expect(failed.code, output(failed)).toBe(1)
  expect(reportText(failed), output(failed)).toContain(`${failure.step}: NOT renamed (failed here)`)
}

const failureAt = (step: RenameStep): StepFailure => {
  return STEP_FAILURES.find((failure) => {
    return failure.step === step
  })!
}

const MERGE_REMEDIATION_PATTERN = /git merge origin\/release\/v1\.2\.0/u

describe('release rename: named resume states (plan §4 Step 5)', () => {
  it(
    '{old PR open, new PR open}: a failure at pr-close leaves both open, the re-run closes the old one',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)

        await failAt(fixture, failureAt('pr-close'))

        expect(openPrsOn(fixture, [OLD_BRANCH, NEW_BRANCH])).toHaveLength(2)

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['pr-close', 'remote-delete', 'local-branch'])
        expectConverged(fixture, baseline)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )

  it(
    'a teammate pushes to release/<old> between runs: the re-run refuses with the merge remediation and deletes nothing',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        await failAt(fixture, failureAt('remote-delete'))

        const teammateSha = fixture.pushAsTeammate(OLD_BRANCH)
        const before = snapshot(fixture)
        const run = await runRename(fixture, ARGS, { yes: true })

        expect(run.code, output(run)).not.toBe(0)
        expect(run.code, output(run)).not.toBeNull()
        expect(reportText(run), output(run)).toMatch(MERGE_REMEDIATION_PATTERN)
        expect(fixture.originSha(OLD_BRANCH)).toBe(teammateSha)
        expectNothingMutated(fixture, before)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )

  it(
    'release/<old> recreated as an ancestor after convergence: the next run only deletes it again',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        const baseline = captureBaseline(fixture)

        await renameOk(fixture, ARGS)
        fixture.recreateBranchOnOrigin(OLD_BRANCH, baseline.remoteSha)

        const run = await renameOk(fixture, ARGS)

        expect(run.json, output(run)).toMatchObject({ outcome: 'renamed', renamedSteps: ['remote-delete'] })
        expectConverged(fixture, baseline)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )

  it(
    'reverse rename after convergence converges back, and a later preview anchors on the newest PR on the head',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        const baseline = captureBaseline(fixture)

        await renameOk(fixture, ARGS)

        const back = await renameOk(fixture, ['1.3.0', '1.2.0'])

        expect(back.json, output(back)).toMatchObject({ outcome: 'renamed', oldPrNumber: 2 })

        const onOldHead = fixture.ghState().prs.filter((pr) => {
          return pr.headRefName === OLD_BRANCH
        })

        expect(
          onOldHead.map((pr) => {
            return [pr.number, pr.state]
          }),
        ).toStrictEqual([
          [1, 'CLOSED'],
          [3, 'OPEN'],
        ])
        expect(jiraVersion(fixture).name).toBe('v1.2.0')
        expect(fixture.originSha(OLD_BRANCH)).toBe(baseline.remoteSha)
        expect(fixture.originSha(NEW_BRANCH)).toBeNull()
        expect(fixture.cloneSha(`refs/heads/${OLD_BRANCH}`)).toBe(baseline.localSha)
        expect(existsSync(fixture.worktreeDir)).toBe(true)
        expect(existsSync(fixture.worktreePathFor(NEW_SUFFIX))).toBe(false)

        const preview = await runRename(fixture, ['1.2.0', '1.4.0'])

        expect(preview.code, output(preview)).toBe(2)
        expect(preview.json?.plan, output(preview)).toMatchObject({ oldPr: 3, newPr: null })
        expect(String(preview.json?.message)).toMatch(/PR old: +#3 closed/u)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )

  it(
    'a Jira-only residue warns against release remove <old> / release create <new>',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const failure = failureAt('remote-push')

        failure.inject(fixture)

        const failed = await runRename(fixture, ARGS, { yes: true })

        failure.clear(fixture)

        expect(failed.code, output(failed)).toBe(1)
        expect(reportText(failed)).toMatch(/^ {2}jira: renamed$/mu)
        expect(reportText(failed)).toContain(HALF_RENAMED_WARNING)
        expect(jiraVersion(fixture).name).toBe(NEW_JIRA_NAME)
        expect(fixture.originSha(NEW_BRANCH)).toBeNull()
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )

  it(
    'the old PR closed without the marker: refused with the runnable gh pr comment line; adding it converges',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)

        await failAt(fixture, failureAt('pr-close'))
        fixture.patchPr(1, { state: 'CLOSED' })

        const newPr = openPrsOn(fixture, [NEW_BRANCH])[0]!.number
        const before = snapshot(fixture)
        const refused = await runRename(fixture, ARGS, { yes: true })
        const expectedBody = `Superseded by #${newPr}: release renamed v1.2.0 → ${NEW_JIRA_NAME} by infra-kit release rename.`

        expect(refused.code, output(refused)).not.toBe(0)
        expect(refused.code, output(refused)).not.toBeNull()
        expect(reportText(refused)).toContain(`gh pr comment 1 --body '${expectedBody}', then re-run`)
        expectNothingMutated(fixture, before)

        fixture.patchPr(1, { comments: [{ body: expectedBody, author: { login: 'release-manager' } }] })

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['remote-delete', 'local-branch'])
        expectConverged(fixture, baseline)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )
})

// Held on the tracking ref only: `git branch -m` succeeds, then the step's tracking fetch cannot write.
const newTrackingLock = (fixture: ReleaseRenameFixture): string => {
  return join(fixture.repoDir, '.git', 'refs', 'remotes', 'origin', 'release', `${NEW_SUFFIX}.lock`)
}

describe('release rename: a failure inside the local-branch step', () => {
  it(
    'the branch is renamed but its upstream is not yet set: the re-run finishes the step and tracks origin/<new>',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const baseline = captureBaseline(fixture)

        mkdirSync(join(newTrackingLock(fixture), '..'), { recursive: true })
        writeFileSync(newTrackingLock(fixture), '')

        const failed = await runRename(fixture, ARGS, { yes: true })

        rmSync(newTrackingLock(fixture))

        expect(failed.code, output(failed)).toBe(1)
        expect(reportText(failed), output(failed)).toContain('local-branch: NOT renamed (failed here)')
        expect(fixture.cloneSha(`refs/heads/${NEW_BRANCH}`)).toBe(baseline.localSha)

        const rerun = await renameOk(fixture, ARGS)

        expect(rerun.json?.renamedSteps, output(rerun)).toStrictEqual(['local-branch'])
        expectConverged(fixture, baseline)
        await expectAlreadyRenamed(fixture)
      })
    },
    RESUME_TEST_TIMEOUT_MS,
  )
})
