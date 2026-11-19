import type { PRReviewState } from 'src/integrations/gh/pr-status'

import { STEP_ORDER, shouldWarnHalfRenamed } from './rename-classifier'
import type { ChildPr, PlaceResult, RenamePlaces, RenameStep } from './rename-classifier'

// Kept out of backticks: the command is registered by the entry layer, and printed lines must stay
// runnable exactly as printed.
const RENAME_COMMAND = 'infra-kit release rename'

const renameCommand = (from: string, to: string): string => {
  return `${RENAME_COMMAND} ${from} ${to}`
}

export const STEP_LABELS: Record<RenameStep, string> = {
  jira: 'rename the Jira fix version',
  'remote-push': 'push the new branch to origin',
  'pr-open': 'open the replacement PR',
  'pr-retarget': 'retarget the child PRs',
  'pr-close': 'close the old PR',
  'remote-delete': 'delete the old branch on origin',
  'local-branch': 'rename the local branch',
  worktree: 'move the worktree',
}

const SWEEP_PAUSE_NOTE = 'may pause up to 10 s after the move'

/** Names only — no Jira credentials ever reach these helpers. */
export interface RenameNames {
  oldLabel: string
  newLabel: string
  oldBranch: string
  newBranch: string
  oldName: string
  newName: string
  oldPath: string
  newPath: string
}

export const placeWord = (place: PlaceResult): string => {
  if (place.state === 'vacuous') return 'absent'
  if (place.state === 'pending' && place.sweepOnly) return 'pending (sweep of the old path only)'

  return place.state
}

const SAFE_SHELL_WORD = /^[\w@%+=:,./-]+$/u
const ESCAPED_QUOTE = "'\\''"

export const shellQuote = (word: string): string => {
  return SAFE_SHELL_WORD.test(word) ? word : `'${word.replaceAll("'", ESCAPED_QUOTE)}'`
}

export interface PreviewInput {
  names: RenameNames
  places: RenamePlaces
  anchorNumber: number | null
  /** The replacement PR when it already exists, else the title it will get. */
  newPrNumber: number | null
  newPrTitle: string | null
  children: ChildPr[]
  reviews: PRReviewState | null
  openInOrca: boolean
}

export const formatPrList = (prs: ChildPr[]): string => {
  return prs
    .map((pr) => {
      return `#${pr.number} (${pr.headRefName})`
    })
    .join(', ')
}

const describeChildren = (children: ChildPr[], newBranch: string): string => {
  if (children.length === 0) return 'none'

  return `${formatPrList(children)}: base → ${newBranch}`
}

const describeOrca = (input: PreviewInput): string => {
  const worktree = input.places.worktree

  if (worktree.state !== 'pending' || worktree.sweepOnly) return 'nothing to do'

  const after = input.openInOrca ? 'reopened in the new path' : 'not reopened (worktrees.openInOrca is not true)'

  return `terminals in ${input.names.oldPath} closed before the move, ${after}`
}

/** Reviewer logins to re-request on the new PR: open requests plus everyone who already reviewed. */
export const reviewersToRedo = (reviews: PRReviewState | null): string[] => {
  if (reviews === null) return []

  const reviewed = reviews.latestReviews.map((review) => {
    return review.login
  })

  return [...new Set([...reviews.requestedReviewers, ...reviewed])]
}

const reviewWarning = (input: PreviewInput): string | null => {
  const { reviews, anchorNumber } = input

  if (reviews === null || anchorNumber === null || input.places['pr-close'].state === 'done') return null
  if (reviews.requestedReviewers.length === 0 && reviews.latestReviews.length === 0) return null

  const requested = reviews.requestedReviewers.join(', ') || 'none'

  const reviewed =
    reviews.latestReviews
      .map((review) => {
        return `${review.login} (${review.state})`
      })
      .join(', ') || 'none'

  return `  ! approvals and review requests stay on #${anchorNumber} and must be redone — requested: ${requested}; reviews: ${reviewed}`
}

export const buildPreviewLines = (input: PreviewInput): string[] => {
  const { names, places } = input

  const word = (step: RenameStep): string => {
    return placeWord(places[step])
  }

  const newPr = input.newPrNumber === null ? `"${input.newPrTitle ?? ''}"` : `#${input.newPrNumber}`
  const oldPr = input.anchorNumber === null ? 'none' : `#${input.anchorNumber}`
  const worktreeNote = places.worktree.state === 'pending' ? ` — ${SWEEP_PAUSE_NOTE}` : ''

  const lines = [
    `Rename release ${names.oldLabel} → ${names.newLabel}? Every place, old → new:`,
    `  • Jira version:   ${names.oldName} → ${names.newName} (${word('jira')})`,
    `  • remote new:     origin ${names.newBranch} at the ${names.oldBranch} tip (${word('remote-push')})`,
    `  • PR new:         ${newPr} from ${names.newBranch} (${word('pr-open')})`,
    `  • child PRs:      ${describeChildren(input.children, names.newBranch)} (${word('pr-retarget')})`,
    `  • PR old:         ${oldPr} closed with "Superseded by #<new>" (${word('pr-close')})`,
    `  • remote old:     origin ${names.oldBranch} deleted (${word('remote-delete')})`,
    `  • local branch:   ${names.oldBranch} → ${names.newBranch} (${word('local-branch')})`,
    `  • worktree:       ${names.oldPath} → ${names.newPath} (${word('worktree')})${worktreeNote}`,
    `  • Orca:           ${describeOrca(input)}`,
  ]

  const warning = reviewWarning(input)

  if (warning !== null) lines.push(warning)
  if (places['remote-push'].state === 'pending') {
    lines.push(`  ! on: push workflows may run for ${names.newBranch} once it is pushed`)
  }

  return lines
}

const residueWord = (step: RenameStep, places: RenamePlaces, failedStep: RenameStep): string => {
  const { state } = places[step]

  if (step === failedStep) return 'NOT renamed (failed here)'
  if (state === 'done') return 'renamed'
  if (state === 'vacuous') return 'nothing to rename'

  return 'not renamed'
}

/** `places` must already reflect the steps this run completed. */
export const buildResidueText = (names: RenameNames, places: RenamePlaces, failedStep: RenameStep): string => {
  const rows = STEP_ORDER.map((step) => {
    return `  ${step}: ${residueWord(step, places, failedStep)}`
  })

  const lines = [
    'per place:',
    ...rows,
    `re-run to finish (completed steps are skipped): ${renameCommand(names.oldLabel, names.newLabel)}`,
    `to undo afterwards: ${renameCommand(names.newLabel, names.oldLabel)}`,
  ]

  if (shouldWarnHalfRenamed(places)) {
    lines.push(
      `do not run release remove ${names.oldLabel} or release create ${names.newLabel} until this rename is re-run to completion`,
    )
  }

  return lines.join('\n')
}

export const withCompleted = (places: RenamePlaces, completed: RenameStep[]): RenamePlaces => {
  return Object.fromEntries(
    STEP_ORDER.map((step) => {
      return [step, completed.includes(step) ? { state: 'done' } : places[step]]
    }),
  ) as RenamePlaces
}

export interface FollowUp {
  label: string
  command: string
}

export interface FollowUpInput {
  names: RenameNames
  /** The new worktree path when a worktree lives there now, else `null`. */
  worktreePath: string | null
  installOk: boolean
  orcaReopened: boolean
  newPrNumber: number | null
  reviewers: string[]
}

export const buildFollowUps = (input: FollowUpInput): FollowUp[] => {
  const { names, worktreePath } = input
  const followUps: FollowUp[] = []

  if (worktreePath !== null && !input.installOk) {
    followUps.push({
      label: 'reinstall dependencies in the moved worktree (pnpm bin shims hold the old path)',
      command: `cd ${shellQuote(worktreePath)} && pnpm install`,
    })
  }

  if (worktreePath !== null && !input.orcaReopened) {
    const selector = `path:${worktreePath}`

    followUps.push({
      label: 'open an Orca terminal in the moved worktree',
      command: `orca terminal create --worktree ${shellQuote(selector)} --focus`,
    })
  }

  if (input.newPrNumber !== null && input.reviewers.length > 0) {
    followUps.push({
      label: `re-request reviews on #${input.newPrNumber}`,
      command: `gh pr edit ${input.newPrNumber} --add-reviewer ${input.reviewers.join(',')}`,
    })
  }

  followUps.push({
    label: `teammates with a local ${names.oldBranch}`,
    command: `git fetch --prune && git branch -m ${names.oldBranch} ${names.newBranch}`,
  })

  return followUps
}

export const formatFollowUp = (followUp: FollowUp): string => {
  return `➡️  ${followUp.label}: ${followUp.command}`
}
