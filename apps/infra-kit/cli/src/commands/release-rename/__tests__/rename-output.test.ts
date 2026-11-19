import { describe, expect, it } from 'vitest'

import { STEP_ORDER } from '../rename-classifier'
import type { PlaceResult, RenamePlaces, RenameStep } from '../rename-classifier'
import {
  buildFollowUps,
  buildPreviewLines,
  buildResidueText,
  formatFollowUp,
  placeWord,
  reviewersToRedo,
  shellQuote,
  withCompleted,
} from '../rename-output'
import type { PreviewInput, RenameNames } from '../rename-output'

const names: RenameNames = {
  oldLabel: '1.2.3',
  newLabel: 'checkout-redesign',
  oldBranch: 'release/v1.2.3',
  newBranch: 'release/checkout-redesign',
  oldName: 'v1.2.3',
  newName: 'checkout-redesign',
  oldPath: '/repo-worktrees/release/v1.2.3',
  newPath: '/repo-worktrees/release/checkout-redesign',
}

const placesWith = (overrides: Partial<Record<RenameStep, PlaceResult>> = {}): RenamePlaces => {
  return Object.fromEntries(
    STEP_ORDER.map((step) => {
      return [step, overrides[step] ?? { state: 'pending' }]
    }),
  ) as RenamePlaces
}

const previewInput = (overrides: Partial<PreviewInput> = {}): PreviewInput => {
  return {
    names,
    places: placesWith(),
    anchorNumber: 12,
    newPrNumber: null,
    newPrTitle: 'Release checkout-redesign',
    children: [{ number: 14, headRefName: 'feature/x' }],
    reviews: { requestedReviewers: ['alice'], latestReviews: [{ login: 'bob', state: 'APPROVED' }] },
    openInOrca: false,
    ...overrides,
  }
}

describe('buildPreviewLines', () => {
  it('lists every place old → new with its state, the review and push warnings', () => {
    expect(buildPreviewLines(previewInput())).toEqual([
      'Rename release 1.2.3 → checkout-redesign? Every place, old → new:',
      '  • Jira version:   v1.2.3 → checkout-redesign (pending)',
      '  • remote new:     origin release/checkout-redesign at the release/v1.2.3 tip (pending)',
      '  • PR new:         "Release checkout-redesign" from release/checkout-redesign (pending)',
      '  • child PRs:      #14 (feature/x): base → release/checkout-redesign (pending)',
      '  • PR old:         #12 closed with "Superseded by #<new>" (pending)',
      '  • remote old:     origin release/v1.2.3 deleted (pending)',
      '  • local branch:   release/v1.2.3 → release/checkout-redesign (pending)',
      '  • worktree:       /repo-worktrees/release/v1.2.3 → /repo-worktrees/release/checkout-redesign (pending) — may pause up to 10 s after the move',
      '  • Orca:           terminals in /repo-worktrees/release/v1.2.3 closed before the move, not reopened (worktrees.openInOrca is not true)',
      '  ! approvals and review requests stay on #12 and must be redone — requested: alice; reviews: bob (APPROVED)',
      '  ! on: push workflows may run for release/checkout-redesign once it is pushed',
    ])
  })

  it('renders a resume: done and absent places, an existing new PR, no warnings once closed and pushed', () => {
    const lines = buildPreviewLines(
      previewInput({
        places: placesWith({
          jira: { state: 'done' },
          'remote-push': { state: 'done' },
          'pr-open': { state: 'done' },
          'pr-retarget': { state: 'vacuous' },
          'pr-close': { state: 'done' },
          'local-branch': { state: 'vacuous' },
          worktree: { state: 'pending', sweepOnly: true },
        }),
        newPrNumber: 20,
        children: [],
        openInOrca: true,
      }),
    )

    expect(lines).toContain('  • PR new:         #20 from release/checkout-redesign (done)')
    expect(lines).toContain('  • child PRs:      none (absent)')
    expect(lines).toContain('  • local branch:   release/v1.2.3 → release/checkout-redesign (absent)')
    expect(lines).toContain(
      '  • worktree:       /repo-worktrees/release/v1.2.3 → /repo-worktrees/release/checkout-redesign (pending (sweep of the old path only)) — may pause up to 10 s after the move',
    )
    expect(lines).toContain('  • Orca:           nothing to do')
    expect(
      lines.some((line) => {
        return line.startsWith('  !')
      }),
    ).toBe(false)
  })

  it('says Orca is reopened when worktrees.openInOrca is true', () => {
    expect(buildPreviewLines(previewInput({ openInOrca: true }))).toContain(
      '  • Orca:           terminals in /repo-worktrees/release/v1.2.3 closed before the move, reopened in the new path',
    )
  })
})

describe('buildResidueText', () => {
  it('reports per place, with the forward re-run, the undo-after line and the half-renamed warning', () => {
    const places = withCompleted(placesWith({ 'pr-retarget': { state: 'vacuous' } }), ['jira', 'remote-push'])

    expect(buildResidueText(names, places, 'pr-open')).toBe(
      [
        'per place:',
        '  jira: renamed',
        '  remote-push: renamed',
        '  pr-open: NOT renamed (failed here)',
        '  pr-retarget: nothing to rename',
        '  pr-close: not renamed',
        '  remote-delete: not renamed',
        '  local-branch: not renamed',
        '  worktree: not renamed',
        're-run to finish (completed steps are skipped): infra-kit release rename 1.2.3 checkout-redesign',
        'to undo afterwards: infra-kit release rename checkout-redesign 1.2.3',
        'do not run release remove 1.2.3 or release create checkout-redesign until this rename is re-run to completion',
      ].join('\n'),
    )
  })

  it('omits the half-renamed warning when jira failed', () => {
    const text = buildResidueText(names, placesWith(), 'jira')

    expect(text).toContain('  jira: NOT renamed (failed here)')
    expect(text).toContain('to undo afterwards: infra-kit release rename checkout-redesign 1.2.3')
    expect(text).not.toContain('do not run release remove')
  })

  it('omits the half-renamed warning once remote-delete is done', () => {
    const places = withCompleted(placesWith(), [
      'jira',
      'remote-push',
      'pr-open',
      'pr-retarget',
      'pr-close',
      'remote-delete',
    ])

    expect(buildResidueText(names, places, 'local-branch')).not.toContain('do not run release remove')
  })
})

describe('buildFollowUps', () => {
  it('prints install, Orca, reviewers and the teammates hint as runnable commands', () => {
    const lines = buildFollowUps({
      names,
      worktreePath: names.newPath,
      installOk: false,
      orcaReopened: false,
      newPrNumber: 20,
      reviewers: ['alice', 'bob'],
    }).map(formatFollowUp)

    expect(lines).toEqual([
      '➡️  reinstall dependencies in the moved worktree (pnpm bin shims hold the old path): cd /repo-worktrees/release/checkout-redesign && pnpm install',
      '➡️  open an Orca terminal in the moved worktree: orca terminal create --worktree path:/repo-worktrees/release/checkout-redesign --focus',
      '➡️  re-request reviews on #20: gh pr edit 20 --add-reviewer alice,bob',
      '➡️  teammates with a local release/v1.2.3: git fetch --prune && git branch -m release/v1.2.3 release/checkout-redesign',
    ])
  })

  it('prints only the teammates hint with no worktree and no reviewers', () => {
    const followUps = buildFollowUps({
      names,
      worktreePath: null,
      installOk: false,
      orcaReopened: false,
      newPrNumber: 20,
      reviewers: [],
    })

    expect(
      followUps.map((f) => {
        return f.command
      }),
    ).toEqual(['git fetch --prune && git branch -m release/v1.2.3 release/checkout-redesign'])
  })

  it('drops install and Orca once both succeeded this run', () => {
    const followUps = buildFollowUps({
      names,
      worktreePath: names.newPath,
      installOk: true,
      orcaReopened: true,
      newPrNumber: 20,
      reviewers: [],
    })

    expect(followUps).toHaveLength(1)
  })
})

describe('small helpers', () => {
  it('quotes only words the shell would split', () => {
    expect(shellQuote('/a/b-c')).toBe('/a/b-c')
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
  })

  it('names vacuous places absent', () => {
    expect(placeWord({ state: 'vacuous' })).toBe('absent')
    expect(placeWord({ state: 'done' })).toBe('done')
  })

  it('redoes requested reviewers and past reviewers once each', () => {
    expect(
      reviewersToRedo({
        requestedReviewers: ['alice'],
        latestReviews: [
          { login: 'alice', state: 'COMMENTED' },
          { login: 'bob', state: 'APPROVED' },
        ],
      }),
    ).toEqual(['alice', 'bob'])
    expect(reviewersToRedo(null)).toEqual([])
  })
})
