import { describe, expect, it } from 'vitest'

import {
  INCONSISTENT_STATE_REASON,
  STEP_ORDER,
  classifyJira,
  classifyLocalBranch,
  classifyPlaces,
  classifyPrClose,
  classifyPrOpen,
  classifyPrRetarget,
  classifyRemoteDelete,
  classifyRemotePush,
  classifyRename,
  classifyWorktree,
  isActive,
  mergeOldIntoNewRemediation,
  shouldWarnHalfRenamed,
  supersededComment,
  supersededMarker,
} from '../rename-classifier'
import type { PlaceResult, RenameProbe, RenameStep } from '../rename-classifier'

const OLD_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const VERSION_ID = '10001'
const OLD_PR = 41
const NEW_PR = 42
const OLD_PATH = '/repo-worktrees/release/v1.0.0'
const NEW_PATH = '/repo-worktrees/release/v1.1.0'

const MERGE_REMEDIATION =
  'git fetch origin && git switch --detach origin/release/v1.1.0 && git merge origin/release/v1.0.0 && git push origin HEAD:refs/heads/release/v1.1.0 && git switch -, then re-run'

type ProbeOverrides = Omit<Partial<RenameProbe>, 'worktree'> & { worktree?: Partial<RenameProbe['worktree']> }

/** An untouched release: open PR, origin `<old>`, a local branch and a worktree, Jira still `<old>`. */
const probe = (overrides: ProbeOverrides = {}): RenameProbe => {
  const { worktree, ...rest } = overrides

  return {
    oldName: 'v1.0.0',
    newName: 'v1.1.0',
    oldBranch: 'release/v1.0.0',
    newBranch: 'release/v1.1.0',
    anchorPr: { number: OLD_PR, state: 'OPEN', bodyJiraId: VERSION_ID, comments: [] },
    openOldPrs: [{ number: OLD_PR, bodyJiraId: VERSION_ID }],
    openNewPrs: [],
    oldRemoteSha: OLD_SHA,
    newRemoteSha: null,
    compareOldToNew: null,
    localOldSha: OLD_SHA,
    localNewSha: null,
    localNewTracksNew: false,
    jiraVersion: { id: VERSION_ID, name: 'v1.0.0', released: false, archived: false },
    jiraByNewName: null,
    childPrs: [],
    ...rest,
    worktree: {
      oldPath: OLD_PATH,
      newPath: NEW_PATH,
      atOldPath: true,
      atNewPath: false,
      oldPathLeftover: 'absent',
      oldPathEntries: [],
      ...worktree,
    },
  }
}

const NO_LOCAL: ProbeOverrides = { localOldSha: null, localNewSha: null, worktree: { atOldPath: false } }
const CHILD = { number: 50, headRefName: 'feature/x' }
const NEW_HEAD_PR = { number: NEW_PR, bodyJiraId: VERSION_ID }
const MARKER_COMMENT = supersededComment(NEW_PR, 'v1.0.0', 'v1.1.0')

/** The world after steps 1..k of STEP_ORDER succeeded, with a child PR, local branch and worktree. */
const afterStep = (k: number): RenameProbe => {
  const jiraDone = k >= 1
  const pushed = k >= 2
  const opened = k >= 3
  const retargeted = k >= 4
  const closed = k >= 5
  const deleted = k >= 6
  const branchRenamed = k >= 7
  const moved = k >= 8

  return probe({
    jiraVersion: { id: VERSION_ID, name: jiraDone ? 'v1.1.0' : 'v1.0.0', released: false, archived: false },
    jiraByNewName: jiraDone ? { id: VERSION_ID } : null,
    newRemoteSha: pushed ? OLD_SHA : null,
    oldRemoteSha: deleted ? null : OLD_SHA,
    compareOldToNew: pushed && !deleted ? 'identical' : null,
    openNewPrs: opened ? [NEW_HEAD_PR] : [],
    childPrs: retargeted ? [] : [CHILD],
    anchorPr: {
      number: OLD_PR,
      state: closed ? 'CLOSED' : 'OPEN',
      bodyJiraId: VERSION_ID,
      comments: closed ? [MARKER_COMMENT] : [],
    },
    openOldPrs: closed ? [] : [{ number: OLD_PR, bodyJiraId: VERSION_ID }],
    localOldSha: branchRenamed ? null : OLD_SHA,
    localNewSha: branchRenamed ? OLD_SHA : null,
    localNewTracksNew: branchRenamed,
    worktree: { atOldPath: !moved, atNewPath: moved },
  })
}

const converged = (overrides: ProbeOverrides = {}): RenameProbe => {
  const base = afterStep(8)

  return probe({ ...base, ...overrides, worktree: { ...base.worktree, ...overrides.worktree } })
}

const state = (result: PlaceResult): string => {
  return result.state
}

describe('marker', () => {
  it('is `Superseded by #<n>` and the comment starts with it', () => {
    expect(supersededMarker(7)).toBe('Superseded by #7')
    expect(supersededComment(7, 'v1', 'v2').startsWith(supersededMarker(7))).toBe(true)
  })
})

describe('jira row', () => {
  const version = (patch: Partial<NonNullable<RenameProbe['jiraVersion']>>): RenameProbe['jiraVersion'] => {
    return { id: VERSION_ID, name: 'v1.0.0', released: false, archived: false, ...patch }
  }

  it.each<[string, ProbeOverrides, string]>([
    ['done when V.name === new', { jiraVersion: version({ name: 'v1.1.0' }) }, 'done'],
    ['pending when V.name === old', {}, 'pending'],
    ['conflict on any other name', { jiraVersion: version({ name: 'v9.9.9' }) }, 'conflict'],
    ['conflict when released', { jiraVersion: version({ released: true }) }, 'conflict'],
    ['conflict when archived', { jiraVersion: version({ archived: true }) }, 'conflict'],
    ['conflict when byName(new) has a different id', { jiraByNewName: { id: '20002' } }, 'conflict'],
    ['not a conflict when byName(new) is V with a numeric id', { jiraByNewName: { id: 10_001 } }, 'pending'],
    ['conflict when V is not found', { jiraVersion: null }, 'conflict'],
    ['conflict when there is no anchor PR', { anchorPr: null }, 'conflict'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyJira(probe(overrides)))).toBe(expected)
  })

  it('compares V.id and byName(new).id as strings', () => {
    expect(
      state(
        classifyJira(probe({ jiraVersion: version({ id: 10_001, name: 'v1.1.0' }), jiraByNewName: { id: '10001' } })),
      ),
    ).toBe('done')
  })
})

describe('remote-push row', () => {
  it.each<[string, ProbeOverrides, string]>([
    ['pending when nR null and oR set', {}, 'pending'],
    ['done when nR === oR', { newRemoteSha: OLD_SHA, compareOldToNew: 'identical' }, 'done'],
    ['done when contains(oR, nR)', { newRemoteSha: OTHER_SHA, compareOldToNew: 'ahead' }, 'done'],
    [
      'done when oR null and the marker names an open PR on the new head',
      {
        oldRemoteSha: null,
        newRemoteSha: OLD_SHA,
        openNewPrs: [NEW_HEAD_PR],
        anchorPr: { number: OLD_PR, state: 'CLOSED', bodyJiraId: VERSION_ID, comments: [MARKER_COMMENT] },
      },
      'done',
    ],
    [
      'conflict (taken) when oR null and the marker names no open new-head PR',
      {
        oldRemoteSha: null,
        newRemoteSha: OLD_SHA,
        openNewPrs: [NEW_HEAD_PR],
        anchorPr: { number: OLD_PR, state: 'CLOSED', bodyJiraId: VERSION_ID, comments: ['Superseded by #420'] },
      },
      'conflict',
    ],
    [
      'conflict (taken) when nR set and not owned',
      { newRemoteSha: OTHER_SHA, compareOldToNew: 'diverged' },
      'conflict',
    ],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyRemotePush(probe(overrides)))).toBe(expected)
  })

  it('both null: release/<old> is gone with no successor', () => {
    expect(classifyRemotePush(probe({ oldRemoteSha: null }))).toEqual({
      state: 'conflict',
      reason: 'release/v1.0.0 is gone with no successor',
    })
  })

  it('an unowned nR is reported as taken', () => {
    expect(classifyRemotePush(probe({ newRemoteSha: OTHER_SHA, compareOldToNew: 'behind' })).reason).toBe(
      'release/v1.1.0 is taken',
    )
  })

  it.each(['diverged', 'behind'] as const)(
    '%s with a new-head PR linking V.id is the single diverged conflict',
    (status) => {
      expect(
        classifyRemotePush(probe({ newRemoteSha: OTHER_SHA, compareOldToNew: status, openNewPrs: [NEW_HEAD_PR] })),
      ).toEqual({
        state: 'conflict',
        reason: 'release/v1.0.0 and release/v1.1.0 have diverged',
        remediation: MERGE_REMEDIATION,
      })
    },
  )
})

describe('pr-open row', () => {
  it.each<[string, ProbeOverrides, string]>([
    ['pending with no new-head PR', {}, 'pending'],
    ['done with one new-head PR linking V.id', { openNewPrs: [NEW_HEAD_PR] }, 'done'],
    [
      'conflict with two new-head PRs (dual base)',
      { openNewPrs: [NEW_HEAD_PR, { number: 43, bodyJiraId: VERSION_ID }] },
      'conflict',
    ],
    ['conflict when the NP body id differs', { openNewPrs: [{ number: NEW_PR, bodyJiraId: '999' }] }, 'conflict'],
    ['conflict when the NP body has no id', { openNewPrs: [{ number: NEW_PR, bodyJiraId: null }] }, 'conflict'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyPrOpen(probe(overrides)))).toBe(expected)
  })
})

describe('pr-retarget row', () => {
  it.each<[string, ProbeOverrides, string]>([
    ['vacuous with no children', {}, 'vacuous'],
    ['pending with children before the push', { childPrs: [CHILD] }, 'pending'],
    [
      'pending with children and contains(oR, nR)',
      { childPrs: [CHILD], newRemoteSha: OLD_SHA, compareOldToNew: 'identical' },
      'pending',
    ],
    ['pending with children and oR null', { childPrs: [CHILD], newRemoteSha: OLD_SHA, oldRemoteSha: null }, 'pending'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyPrRetarget(probe(overrides)))).toBe(expected)
  })

  it('conflict with children and oR not contained in nR, carrying the merge remediation', () => {
    const result = classifyPrRetarget(
      probe({ childPrs: [CHILD], newRemoteSha: OTHER_SHA, compareOldToNew: 'diverged' }),
    )

    expect(result.state).toBe('conflict')
    expect(result.remediation).toBe(MERGE_REMEDIATION)
  })
})

describe('pr-close row', () => {
  const closedAnchor = (comments: string[]): RenameProbe['anchorPr'] => {
    return { number: OLD_PR, state: 'CLOSED', bodyJiraId: VERSION_ID, comments }
  }

  const closed = (comments: string[], openNewPrs: RenameProbe['openNewPrs']): ProbeOverrides => {
    return { anchorPr: closedAnchor(comments), openOldPrs: [], openNewPrs }
  }

  it.each<[string, ProbeOverrides, string]>([
    ['pending with one open old PR', {}, 'pending'],
    ['done when closed with the marker naming the NP', closed([MARKER_COMMENT], [NEW_HEAD_PR]), 'done'],
    ['conflict when the marker names a longer number', closed(['Superseded by #420'], [NEW_HEAD_PR]), 'conflict'],
    [
      'conflict with two open old PRs',
      {
        openOldPrs: [
          { number: OLD_PR, bodyJiraId: VERSION_ID },
          { number: 40, bodyJiraId: VERSION_ID },
        ],
      },
      'conflict',
    ],
    [
      'conflict when the anchor is MERGED',
      { anchorPr: { number: OLD_PR, state: 'MERGED', bodyJiraId: VERSION_ID, comments: [] }, openOldPrs: [] },
      'conflict',
    ],
    ['conflict when there is no anchor', { anchorPr: null, openOldPrs: [] }, 'conflict'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyPrClose(probe(overrides)))).toBe(expected)
  })

  it('closed without the marker and exactly one NP: conflict with the runnable gh pr comment remediation', () => {
    expect(classifyPrClose(probe(closed(['closed by hand'], [NEW_HEAD_PR])))).toEqual({
      state: 'conflict',
      reason: 'PR #41 is closed without the "Superseded by #<n>" marker',
      remediation: `gh pr comment 41 --body 'Superseded by #42: release renamed v1.0.0 → v1.1.0 by infra-kit release rename.', then re-run`,
    })
  })

  it.each<[string, RenameProbe['openNewPrs']]>([
    ['zero', []],
    ['two', [NEW_HEAD_PR, { number: 43, bodyJiraId: VERSION_ID }]],
  ])('closed without the marker and %s NPs: conflict without a remediation', (_name, openNewPrs) => {
    const result = classifyPrClose(probe(closed([], openNewPrs)))

    expect(result.state).toBe('conflict')
    expect(result.remediation).toBeUndefined()
  })
})

describe('remote-delete row', () => {
  it.each<[string, ProbeOverrides, string]>([
    ['done when oR null', { oldRemoteSha: null, newRemoteSha: OLD_SHA }, 'done'],
    ['pending when contains(oR, nR)', { newRemoteSha: OTHER_SHA, compareOldToNew: 'ahead' }, 'pending'],
    ['pending before the push', {}, 'pending'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyRemoteDelete(probe(overrides)))).toBe(expected)
  })

  it('conflict when oR is not contained in nR, carrying the merge remediation', () => {
    const result = classifyRemoteDelete(probe({ newRemoteSha: OTHER_SHA, compareOldToNew: 'behind' }))

    expect(result.state).toBe('conflict')
    expect(result.remediation).toBe(MERGE_REMEDIATION)
  })
})

describe('local-branch row', () => {
  it.each<[string, ProbeOverrides, string]>([
    ['done when new set and old null', { localOldSha: null, localNewSha: OLD_SHA }, 'done'],
    [
      'done when new set, old null and it tracks origin/<new>',
      { localOldSha: null, localNewSha: OLD_SHA, newRemoteSha: OLD_SHA, localNewTracksNew: true },
      'done',
    ],
    [
      'pending when new set and old null but it does not track origin/<new>, which exists (failed after branch -m)',
      { localOldSha: null, localNewSha: OLD_SHA, newRemoteSha: OLD_SHA, localNewTracksNew: false },
      'pending',
    ],
    ['pending when old set and new null', {}, 'pending'],
    ['conflict when both set', { localNewSha: OTHER_SHA }, 'conflict'],
    ['vacuous when both null', { localOldSha: null }, 'vacuous'],
  ])('%s', (_name, overrides, expected) => {
    expect(state(classifyLocalBranch(probe(overrides)))).toBe(expected)
  })
})

describe('worktree row', () => {
  it.each<[string, ProbeOverrides['worktree'], string]>([
    ['done when at the new path and the old path is absent', { atOldPath: false, atNewPath: true }, 'done'],
    ['pending when at the old path', {}, 'pending'],
    ['conflict when at both paths', { atNewPath: true }, 'conflict'],
    ['vacuous with no entry', { atOldPath: false }, 'vacuous'],
  ])('%s', (_name, worktree, expected) => {
    expect(state(classifyWorktree(probe({ worktree })))).toBe(expected)
  })

  it('pending-sweep: moved, old path holds only sweepable entries', () => {
    expect(
      classifyWorktree(
        probe({
          worktree: {
            atOldPath: false,
            atNewPath: true,
            oldPathLeftover: 'sweepable-only',
            oldPathEntries: ['.omc/state'],
          },
        }),
      ),
    ).toEqual({ state: 'pending', sweepOnly: true })
  })

  it('conflict naming the path and its entries when the old path holds non-sweepable entries', () => {
    const result = classifyWorktree(
      probe({
        worktree: {
          atOldPath: false,
          atNewPath: true,
          oldPathLeftover: 'has-other-entries',
          oldPathEntries: ['notes.txt', '.omc/state'],
        },
      }),
    )

    expect(result.state).toBe('conflict')
    expect(result.reason).toContain(OLD_PATH)
    expect(result.reason).toContain('notes.txt')
  })
})

describe('classifyRename: prefix-rule worked examples', () => {
  it('failure after pr-close resumes', () => {
    expect(classifyRename(afterStep(5))).toMatchObject({
      kind: 'resume',
      done: ['jira', 'remote-push', 'pr-open', 'pr-close'],
      pending: ['remote-delete', 'local-branch', 'worktree'],
    })
  })

  it('failure after remote-delete resumes local-branch and worktree', () => {
    expect(classifyRename(afterStep(6))).toMatchObject({ kind: 'resume', pending: ['local-branch', 'worktree'] })
  })

  it('converged, then a teammate recreates <old> contained in nR: resume runs remote-delete only', () => {
    expect(classifyRename(converged({ oldRemoteSha: OLD_SHA, compareOldToNew: 'identical' }))).toMatchObject({
      kind: 'resume',
      pending: ['remote-delete'],
    })
  })

  it('hand-edited: remote-push not done but pr-close done is a conflict', () => {
    const result = classifyRename(
      probe({
        jiraVersion: { id: VERSION_ID, name: 'v1.1.0', released: false, archived: false },
        anchorPr: { number: OLD_PR, state: 'CLOSED', bodyJiraId: VERSION_ID, comments: [MARKER_COMMENT] },
        openOldPrs: [],
        openNewPrs: [NEW_HEAD_PR],
      }),
    )

    expect(result.places.jira.state).toBe('done')
    expect(result.places['remote-push'].state).toBe('pending')
    expect(result.places['pr-close'].state).toBe('done')
    expect(result).toMatchObject({ kind: 'conflict', reason: INCONSISTENT_STATE_REASON })
  })

  it('fresh run with no child PRs, no local branch and no worktree is fresh', () => {
    const result = classifyRename(probe(NO_LOCAL))

    expect(result.kind).toBe('fresh')
    expect(result.places['pr-retarget'].state).toBe('vacuous')
    expect(result.places['local-branch'].state).toBe('vacuous')
    expect(result.places.worktree.state).toBe('vacuous')
  })
})

describe('classifyRename: failed after step k', () => {
  it('k = 0 (nothing ran) is fresh', () => {
    expect(classifyRename(afterStep(0)).kind).toBe('fresh')
  })

  it.each(
    [1, 2, 3, 4, 5, 6, 7].map((k) => {
      return [k, STEP_ORDER[k - 1]] as const
    }),
  )('k = %i (after %s) resumes with exactly the remaining steps pending', (k) => {
    const remaining = STEP_ORDER.slice(k).filter((step) => {
      // A retargeted child is gone, so pr-retarget is vacuous rather than pending from k = 4 on.
      return !(step === 'pr-retarget' && k >= 4)
    })

    expect(classifyRename(afterStep(k))).toMatchObject({ kind: 'resume', pending: remaining })
  })

  it('k = 8 is done', () => {
    expect(classifyRename(afterStep(8)).kind).toBe('done')
  })
})

describe('classifyRename: global rules', () => {
  it('{old PR open, new PR open} with equal shas resumes', () => {
    expect(classifyRename(afterStep(3))).toMatchObject({
      kind: 'resume',
      pending: ['pr-retarget', 'pr-close', 'remote-delete', 'local-branch', 'worktree'],
    })
  })

  it('{old PR open, new PR open} with a new sha not owned is a conflict', () => {
    expect(
      classifyRename(
        probe({
          ...afterStep(3),
          newRemoteSha: OTHER_SHA,
          compareOldToNew: 'diverged',
          openNewPrs: [{ number: NEW_PR, bodyJiraId: '999' }],
        }),
      ).kind,
    ).toBe('conflict')
  })

  it.each(['diverged', 'behind'] as const)(
    '%s after merge-dev is the single diverged conflict, not taken',
    (status) => {
      expect(
        classifyRename(probe({ ...afterStep(3), newRemoteSha: OTHER_SHA, compareOldToNew: status })),
      ).toMatchObject({
        kind: 'conflict',
        reason: 'release/v1.0.0 and release/v1.1.0 have diverged',
        remediation: MERGE_REMEDIATION,
      })
    },
  )

  it('a child PR with oR not contained in nR is a conflict', () => {
    // Diverged with the new-head PR open: remote-push reports the diverged conflict, pr-retarget its own.
    const result = classifyRename(
      probe({ ...afterStep(3), oldRemoteSha: OTHER_SHA, compareOldToNew: 'diverged', childPrs: [CHILD] }),
    )

    expect(result.kind).toBe('conflict')
    expect(result.places['pr-retarget']).toMatchObject({ state: 'conflict', remediation: MERGE_REMEDIATION })
  })

  it('a conflict on one row while others are pending refuses the whole run', () => {
    const result = classifyRename(probe({ localNewSha: OTHER_SHA }))

    expect(result.places.jira.state).toBe('pending')
    expect(result.places['local-branch'].state).toBe('conflict')
    expect(result).toMatchObject({ kind: 'conflict', reason: 'both local release/v1.0.0 and release/v1.1.0 exist' })
  })

  it('<old> recreated as an ancestor with a child PR on it resumes pr-retarget and remote-delete', () => {
    expect(
      classifyRename(converged({ oldRemoteSha: OTHER_SHA, compareOldToNew: 'ahead', childPrs: [CHILD] })),
    ).toMatchObject({ kind: 'resume', pending: ['pr-retarget', 'remote-delete'] })
  })

  it('<old> recreated as a non-ancestor is a conflict with the merge remediation', () => {
    expect(classifyRename(converged({ oldRemoteSha: OTHER_SHA, compareOldToNew: 'diverged' }))).toMatchObject({
      kind: 'conflict',
      remediation: MERGE_REMEDIATION,
    })
  })

  it('pending-sweep after the move resumes the worktree step only, flagged sweep-only', () => {
    const result = classifyRename(
      converged({ worktree: { oldPathLeftover: 'sweepable-only', oldPathEntries: ['.DS_Store'] } }),
    )

    expect(result).toMatchObject({ kind: 'resume', pending: ['worktree'] })
    expect(result.places.worktree.sweepOnly).toBe(true)
  })

  it('a failure inside local-branch after the rename resumes local-branch and worktree', () => {
    const halfway = afterStep(6)

    expect(
      classifyRename({ ...halfway, localOldSha: null, localNewSha: OLD_SHA, localNewTracksNew: false }),
    ).toMatchObject({ kind: 'resume', pending: ['local-branch', 'worktree'] })
  })

  it('a non-prefix done set is a conflict', () => {
    // The local branch was renamed by hand before anything remote happened.
    const result = classifyRename(probe({ localOldSha: null, localNewSha: OLD_SHA }))

    expect(result).toMatchObject({ kind: 'conflict', reason: INCONSISTENT_STATE_REASON })
  })

  it('reverse rename after only pr-open is refused as changed by hand', () => {
    const forward = afterStep(3)

    const reverse = probe({
      oldName: 'v1.1.0',
      newName: 'v1.0.0',
      oldBranch: 'release/v1.1.0',
      newBranch: 'release/v1.0.0',
      anchorPr: { number: NEW_PR, state: 'OPEN', bodyJiraId: VERSION_ID, comments: [] },
      openOldPrs: [NEW_HEAD_PR],
      openNewPrs: forward.openOldPrs,
      oldRemoteSha: OLD_SHA,
      newRemoteSha: OLD_SHA,
      compareOldToNew: 'identical',
      localOldSha: null,
      localNewSha: OLD_SHA,
      jiraVersion: forward.jiraVersion,
      jiraByNewName: null,
      childPrs: [CHILD],
      worktree: { oldPath: NEW_PATH, newPath: OLD_PATH, atOldPath: false, atNewPath: true },
    })

    expect(classifyRename(reverse)).toMatchObject({ kind: 'conflict', reason: INCONSISTENT_STATE_REASON })
  })

  it('the first conflicting place in step order supplies the reason; every place is reported', () => {
    const result = classifyRename(probe({ jiraVersion: null, localNewSha: OTHER_SHA }))
    const steps = Object.keys(result.places) as RenameStep[]

    expect(steps).toEqual([...STEP_ORDER])
    expect(result).toMatchObject({ kind: 'conflict', reason: 'the Jira version linked from PR #41 was not found' })
  })
})

describe('isActive', () => {
  it.each<[string, RenameProbe, boolean]>([
    ['one open old PR', afterStep(0), true],
    ['pr-close done and exactly one NP', afterStep(8), true],
    ['no open PR anywhere', probe({ openOldPrs: [], anchorPr: null }), false],
  ])('%s → %s', (_name, input, expected) => {
    expect(isActive(input, classifyPlaces(input))).toBe(expected)
  })
})

describe('shouldWarnHalfRenamed', () => {
  it.each<[number, boolean]>([
    [0, false],
    [1, true],
    [5, true],
    [6, false],
    [8, false],
  ])('after step %i → %s', (k, expected) => {
    expect(shouldWarnHalfRenamed(classifyPlaces(afterStep(k)))).toBe(expected)
  })
})

describe('mergeOldIntoNewRemediation', () => {
  // Following it in the clone that runs the rename must not create a local <new> beside the local
  // <old>: the re-run would refuse that as a local-branch conflict (release-rename-toctou.test.ts).
  it('merges on a detached HEAD and pushes by refspec, so no local release/<new> is created', () => {
    const remediation = mergeOldIntoNewRemediation({ oldBranch: 'release/v1.0.0', newBranch: 'release/v1.1.0' })

    expect(remediation).toBe(MERGE_REMEDIATION)
    expect(remediation).not.toMatch(/git switch release\//u)
  })
})
