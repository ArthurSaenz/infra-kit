export const STEP_ORDER = [
  'jira',
  'remote-push',
  'pr-open',
  'pr-retarget',
  'pr-close',
  'remote-delete',
  'local-branch',
  'worktree',
] as const

export type RenameStep = (typeof STEP_ORDER)[number]

/** A teammate can recreate `release/<old>` (or open a PR on it) after these ran, so they may go back to pending. */
const REGRESSABLE_STEPS: ReadonlySet<RenameStep> = new Set(['pr-retarget', 'remote-delete'])

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'

/** `gh api repos/{owner}/{repo}/compare/<oR>...<nR> --jq .status`. */
export type CompareStatus = 'identical' | 'ahead' | 'behind' | 'diverged'

export interface AnchorPr {
  number: number
  state: PrState
  bodyJiraId: string | null
  comments: string[]
}

export interface HeadPr {
  number: number
  bodyJiraId: string | null
}

export interface ChildPr {
  number: number
  headRefName: string
}

export interface JiraVersionState {
  id: string | number
  name: string
  released: boolean
  archived: boolean
}

export interface WorktreeState {
  oldPath: string
  newPath: string
  atOldPath: boolean
  atNewPath: boolean
  /** What is on disk at `oldPath` when no worktree is registered there. */
  oldPathLeftover: 'absent' | 'sweepable-only' | 'has-other-entries'
  oldPathEntries: string[]
}

export interface RenameProbe {
  /** Jira-format names, as `formatJiraName` yields them. */
  oldName: string
  newName: string
  /** `release/<old>` / `release/<new>`. */
  oldBranch: string
  newBranch: string
  /** The newest PR on head `release/<old>` in any state. */
  anchorPr: AnchorPr | null
  openOldPrs: HeadPr[]
  openNewPrs: HeadPr[]
  oldRemoteSha: string | null
  newRemoteSha: string | null
  /** Null when either remote sha is null. */
  compareOldToNew: CompareStatus | null
  localOldSha: string | null
  localNewSha: string | null
  /** Local `<new>`'s upstream resolves to `refs/remotes/origin/<new>`; false with no local `<new>`. */
  localNewTracksNew: boolean
  worktree: WorktreeState
  /** The version the anchor's body links, looked up by id. */
  jiraVersion: JiraVersionState | null
  jiraByNewName: { id: string | number } | null
  /** Open PRs whose base is `release/<old>`. */
  childPrs: ChildPr[]
}

export type PlaceState = 'done' | 'pending' | 'vacuous' | 'conflict'

export interface PlaceResult {
  state: PlaceState
  reason?: string
  remediation?: string
  /** Worktree only: the move already happened and only the leftover sweep of the old path remains. */
  sweepOnly?: boolean
}

export type RenamePlaces = Record<RenameStep, PlaceResult>

export type RenameClassification =
  | { kind: 'fresh'; places: RenamePlaces }
  | { kind: 'resume'; pending: RenameStep[]; done: RenameStep[]; places: RenamePlaces }
  | { kind: 'done'; places: RenamePlaces }
  | { kind: 'conflict'; reason: string; remediation?: string; places: RenamePlaces }

export const INCONSISTENT_STATE_REASON = 'inconsistent state — changed by hand'

const MARKER_PREFIX = 'Superseded by #'

/** The close-comment marker; the classifier's ownership proof and the handler's comment share it. */
export const supersededMarker = (newPrNumber: number): string => {
  return `${MARKER_PREFIX}${newPrNumber}`
}

export const supersededComment = (newPrNumber: number, oldName: string, newName: string): string => {
  return `${supersededMarker(newPrNumber)}: release renamed ${oldName} → ${newName} by infra-kit release rename.`
}

// A substring test would let `Superseded by #12` match a comment naming #123.
const MARKER_PATTERN = /Superseded by #(\d+)(?!\d)/gu

const commentsNameMarker = (comments: string[], newPrNumber: number): boolean => {
  return comments.some((comment) => {
    return [...comment.matchAll(MARKER_PATTERN)].some((match) => {
      return Number(match[1]) === newPrNumber
    })
  })
}

const sameId = (a: string | number | null | undefined, b: string | number | null | undefined): boolean => {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b)
}

const contains = (probe: RenameProbe): boolean => {
  return probe.compareOldToNew === 'identical' || probe.compareOldToNew === 'ahead'
}

const done = (): PlaceResult => {
  return { state: 'done' }
}

const pending = (): PlaceResult => {
  return { state: 'pending' }
}

const vacuous = (): PlaceResult => {
  return { state: 'vacuous' }
}

const conflict = (reason: string, remediation?: string): PlaceResult => {
  return remediation === undefined ? { state: 'conflict', reason } : { state: 'conflict', reason, remediation }
}

/**
 * Merges on a detached HEAD and pushes by refspec: a `git switch <new>` would create a local `<new>`
 * beside the clone's local `<old>`, and the re-run would refuse that as a local-branch conflict.
 */
export const mergeOldIntoNewRemediation = (branches: { oldBranch: string; newBranch: string }): string => {
  return `git fetch origin && git switch --detach origin/${branches.newBranch} && git merge origin/${branches.oldBranch} && git push origin HEAD:refs/heads/${branches.newBranch} && git switch -, then re-run`
}

const noAnchorReason = (probe: RenameProbe): string => {
  return `no PR has head ${probe.oldBranch} — not an active release`
}

export const classifyJira = (probe: RenameProbe): PlaceResult => {
  const version = probe.jiraVersion

  if (probe.anchorPr === null) return conflict(noAnchorReason(probe))
  if (version === null) return conflict(`the Jira version linked from PR #${probe.anchorPr.number} was not found`)
  if (version.released || version.archived) {
    return conflict(`Jira version ${version.name} is ${version.released ? 'released' : 'archived'}`)
  }
  if (probe.jiraByNewName !== null && !sameId(probe.jiraByNewName.id, version.id)) {
    return conflict(`a different Jira version is already named ${probe.newName}`)
  }
  if (version.name === probe.newName) return done()
  if (version.name === probe.oldName) return pending()

  return conflict(
    `Jira version ${String(version.id)} is named ${version.name}, neither ${probe.oldName} nor ${probe.newName}`,
  )
}

const markerNamesOpenNewPr = (probe: RenameProbe): boolean => {
  const comments = probe.anchorPr?.comments ?? []

  return probe.openNewPrs.some((pr) => {
    return commentsNameMarker(comments, pr.number)
  })
}

const newHeadPrLinksVersion = (probe: RenameProbe): boolean => {
  return probe.openNewPrs.some((pr) => {
    return sameId(pr.bodyJiraId, probe.jiraVersion?.id)
  })
}

const isDivergedRename = (probe: RenameProbe): boolean => {
  const status = probe.compareOldToNew

  return (status === 'diverged' || status === 'behind') && newHeadPrLinksVersion(probe)
}

const ownsNewRemote = (probe: RenameProbe): boolean => {
  if (probe.oldRemoteSha === null) return markerNamesOpenNewPr(probe)

  return probe.newRemoteSha === probe.oldRemoteSha || contains(probe)
}

export const classifyRemotePush = (probe: RenameProbe): PlaceResult => {
  const { oldRemoteSha, newRemoteSha } = probe

  if (oldRemoteSha === null && newRemoteSha === null) {
    return conflict(`${probe.oldBranch} is gone with no successor`)
  }
  if (newRemoteSha === null) return pending()
  if (oldRemoteSha !== null && isDivergedRename(probe)) {
    return conflict(`${probe.oldBranch} and ${probe.newBranch} have diverged`, mergeOldIntoNewRemediation(probe))
  }
  if (ownsNewRemote(probe)) return done()

  return conflict(`${probe.newBranch} is taken`)
}

/**
 * The table's "and remote-push is done" clause is not tested here: remote-push precedes pr-open in the
 * prefix order and is never removed from it, so pr-open done without remote-push done already fails the
 * prefix rule — as "changed by hand", the reason the plan gives for that state.
 */
export const classifyPrOpen = (probe: RenameProbe): PlaceResult => {
  const [newPr, ...others] = probe.openNewPrs

  if (newPr === undefined) return pending()
  if (others.length > 0) return conflict(`${probe.newBranch} has ${probe.openNewPrs.length} open PRs`)
  if (!sameId(newPr.bodyJiraId, probe.jiraVersion?.id)) {
    return conflict(`PR #${newPr.number} on ${probe.newBranch} links a different Jira version`)
  }

  return done()
}

export const classifyPrRetarget = (probe: RenameProbe): PlaceResult => {
  if (probe.childPrs.length === 0) return vacuous()
  // Before remote-push there is nothing to compare against; the step re-checks once `<new>` exists.
  if (probe.newRemoteSha === null) return pending()
  if (probe.oldRemoteSha !== null && !contains(probe)) {
    return conflict(
      `${probe.oldBranch} has commits ${probe.newBranch} lacks, and PRs target it`,
      mergeOldIntoNewRemediation(probe),
    )
  }

  return pending()
}

const closedWithoutMarker = (probe: RenameProbe, anchor: AnchorPr): PlaceResult => {
  const reason = `PR #${anchor.number} is closed without the "${MARKER_PREFIX}<n>" marker`
  const [newPr, ...others] = probe.openNewPrs

  // Only one open successor makes the marker unambiguous; with zero or two the human must decide.
  if (newPr === undefined || others.length > 0) return conflict(reason)

  const body = supersededComment(newPr.number, probe.oldName, probe.newName)

  return conflict(reason, `gh pr comment ${anchor.number} --body '${body}', then re-run`)
}

export const classifyPrClose = (probe: RenameProbe): PlaceResult => {
  const anchor = probe.anchorPr

  if (anchor === null) return conflict(noAnchorReason(probe))
  if (anchor.state === 'MERGED') return conflict(`PR #${anchor.number} is merged`)
  if (probe.openOldPrs.length > 1) return conflict(`${probe.oldBranch} has ${probe.openOldPrs.length} open PRs`)
  if (anchor.state === 'OPEN') return pending()
  if (probe.openOldPrs.length === 1) {
    return conflict(`the newest PR on ${probe.oldBranch} is closed while an older one is open`)
  }

  const [newPr, ...others] = probe.openNewPrs

  if (newPr !== undefined && others.length === 0 && commentsNameMarker(anchor.comments, newPr.number)) return done()

  return closedWithoutMarker(probe, anchor)
}

export const classifyRemoteDelete = (probe: RenameProbe): PlaceResult => {
  if (probe.oldRemoteSha === null) return done()
  // Before remote-push there is nothing to compare against; the step re-checks ancestry before deleting.
  if (probe.newRemoteSha === null || contains(probe)) return pending()

  return conflict(
    `someone pushed to ${probe.oldBranch}: it has commits ${probe.newBranch} lacks`,
    mergeOldIntoNewRemediation(probe),
  )
}

export const classifyLocalBranch = (probe: RenameProbe): PlaceResult => {
  const hasOld = probe.localOldSha !== null
  const hasNew = probe.localNewSha !== null

  if (hasOld && hasNew) return conflict(`both local ${probe.oldBranch} and ${probe.newBranch} exist`)
  // `git branch -m` carries the old upstream along, so a step that failed after it leaves `<new>`
  // tracking `origin/<old>`; once `origin/<new>` exists that is unfinished work, not a done rename.
  if (hasNew) return probe.localNewTracksNew || probe.newRemoteSha === null ? done() : pending()
  if (hasOld) return pending()

  return vacuous()
}

export const classifyWorktree = (probe: RenameProbe): PlaceResult => {
  const { atOldPath, atNewPath, oldPath, newPath, oldPathLeftover, oldPathEntries } = probe.worktree

  if (atOldPath && atNewPath) return conflict(`worktrees exist at both ${oldPath} and ${newPath}`)
  if (atOldPath) return pending()
  if (!atNewPath) return vacuous()
  if (oldPathLeftover === 'absent') return done()
  if (oldPathLeftover === 'sweepable-only') return { state: 'pending', sweepOnly: true }

  return conflict(`${oldPath} still holds entries after the move: ${oldPathEntries.join(', ')}`)
}

const PLACE_CLASSIFIERS: Record<RenameStep, (probe: RenameProbe) => PlaceResult> = {
  jira: classifyJira,
  'remote-push': classifyRemotePush,
  'pr-open': classifyPrOpen,
  'pr-retarget': classifyPrRetarget,
  'pr-close': classifyPrClose,
  'remote-delete': classifyRemoteDelete,
  'local-branch': classifyLocalBranch,
  worktree: classifyWorktree,
}

export const classifyPlaces = (probe: RenameProbe): RenamePlaces => {
  return Object.fromEntries(
    STEP_ORDER.map((step) => {
      return [step, PLACE_CLASSIFIERS[step](probe)]
    }),
  ) as RenamePlaces
}

const stepsIn = (places: RenamePlaces, state: PlaceState): RenameStep[] => {
  return STEP_ORDER.filter((step) => {
    return places[step].state === state
  })
}

/** Regressable and vacuous steps leave both sides; what is left of the done set must lead the order. */
export const isPrefixConsistent = (places: RenamePlaces): boolean => {
  const reducedOrder = STEP_ORDER.filter((step) => {
    return !REGRESSABLE_STEPS.has(step) && places[step].state !== 'vacuous'
  })

  const firstNotDone = reducedOrder.findIndex((step) => {
    return places[step].state !== 'done'
  })

  if (firstNotDone === -1) return true

  return reducedOrder.slice(firstNotDone).every((step) => {
    return places[step].state !== 'done'
  })
}

const firstConflict = (places: RenamePlaces): PlaceResult | undefined => {
  return STEP_ORDER.map((step) => {
    return places[step]
  }).find((place) => {
    return place.state === 'conflict'
  })
}

const conflictResult = (places: RenamePlaces, reason: string, remediation?: string): RenameClassification => {
  return remediation === undefined
    ? { kind: 'conflict', reason, places }
    : { kind: 'conflict', reason, remediation, places }
}

export const classifyRename = (probe: RenameProbe): RenameClassification => {
  const places = classifyPlaces(probe)
  const rowConflict = firstConflict(places)

  if (rowConflict !== undefined) {
    return conflictResult(places, rowConflict.reason ?? INCONSISTENT_STATE_REASON, rowConflict.remediation)
  }
  // Both PRs open is legal only once `<new>` provably carries this rename's commits.
  if (probe.openOldPrs.length > 0 && probe.openNewPrs.length > 0 && places['remote-push'].state !== 'done') {
    return conflictResult(places, `${probe.oldBranch} and ${probe.newBranch} both have open PRs before the push`)
  }
  if (!isPrefixConsistent(places)) return conflictResult(places, INCONSISTENT_STATE_REASON)

  const doneSteps = stepsIn(places, 'done')
  const pendingSteps = stepsIn(places, 'pending')

  if (doneSteps.length === 0) return { kind: 'fresh', places }
  if (pendingSteps.length === 0) return { kind: 'done', places }

  return { kind: 'resume', pending: pendingSteps, done: doneSteps, places }
}

/** The release is still discoverable: an open old PR, or the marked close plus exactly one successor. */
export const isActive = (probe: RenameProbe, places: RenamePlaces): boolean => {
  return probe.openOldPrs.length === 1 || (places['pr-close'].state === 'done' && probe.openNewPrs.length === 1)
}

/** Jira already says `<new>` while origin still has `<old>`: other release commands misbehave until convergence. */
export const shouldWarnHalfRenamed = (places: RenamePlaces): boolean => {
  return places.jira.state === 'done' && places['remote-delete'].state !== 'done'
}
