import { setTimeout as delay } from 'node:timers/promises'
import { $ } from 'zx'

import {
  closePrWithComment,
  compareContains,
  listOpenPRsByBase,
  openReleasePr,
  retargetPrBase,
} from 'src/integrations/gh/pr-lifecycle'
import type { PRMetadata } from 'src/integrations/gh/pr-lifecycle'
import { findVersionById, updateJiraVersion } from 'src/integrations/jira/api'
import type { JiraConfig } from 'src/integrations/jira/types'
import {
  buildOrcaTerminalTitle,
  closeOrcaWorktreeTerminals,
  openOrcaWorktreeTerminals,
  probeOrca,
} from 'src/integrations/orca'
import { OperationError } from 'src/lib/errors/operation-error'
import { moveWorktree, renameLocalBranch, setUpstream } from 'src/lib/git-utils/git-utils'
import { deleteRemoteBranchWithLease, lsRemoteHead, pushAtomic, revParseVerify } from 'src/lib/git-utils/merge-refs'
import type { OrcaLayout } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { formatPrTitle } from 'src/lib/release-id'
import type { ReleaseType } from 'src/lib/release-utils/release-utils'

import { STEP_ORDER, mergeOldIntoNewRemediation, supersededComment } from './rename-classifier'
import type { RenamePlaces, RenameProbe, RenameStep } from './rename-classifier'
import { STEP_LABELS, buildResidueText, formatPrList, withCompleted } from './rename-output'
import { assertWorktreeIdle, assertWorktreeMovable, refuse } from './rename-preflight'
import type { ProbeDetails, RenameTarget } from './rename-probe'
import { waitAndSweepOldPath } from './sweep-after-move'

export interface StepContext {
  target: RenameTarget
  probe: RenameProbe
  details: ProbeDetails
  places: RenamePlaces
  jiraConfig: JiraConfig
  /** Present whenever `pr-open` is pending. */
  prMetadata: PRMetadata | null
  prType: ReleaseType | null
  openInOrca: boolean
  orcaPanes: OrcaLayout
}

export interface RunState {
  completed: RenameStep[]
  newPrNumber: number | null
  worktreeMoved: boolean
  orcaReopened: boolean
}

class StepFailure extends Error {
  constructor(
    readonly step: RenameStep,
    readonly reason: unknown,
  ) {
    super(`step ${step} failed`, { cause: reason })
    this.name = 'StepFailure'
  }
}

// A `function` declaration: the prompt sweep parses sources as TSX, where a generic arrow's `<T>`
// opens a JSX tag and silently exempts the module (see `release-remove.ts`'s `runStep`).
function requireValue<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`release rename: ${what} is missing`)

  return value
}

const renameJira = async (ctx: StepContext): Promise<string> => {
  const versionId = String(requireValue(ctx.details.jiraVersion, 'the Jira version').id)
  const current = await findVersionById(versionId, ctx.jiraConfig)

  if (current === null) throw new Error(`Jira version ${versionId} no longer exists`)

  if (current.released || current.archived) {
    refuse({
      operation: `rename Jira fix version ${current.name}`,
      remediation: 'an active release only — un-release or un-archive it in Jira first',
      stderrExcerpt: `it was ${current.released ? 'released' : 'archived'} after preflight`,
    })
  }

  await updateJiraVersion({ versionId, name: ctx.target.newName }, ctx.jiraConfig)

  return `${current.name} → ${ctx.target.newName}`
}

const pushNewBranch = async (ctx: StepContext): Promise<string> => {
  const { projectRoot, oldBranch, newBranch } = ctx.target

  const sourceRef = `refs/heads/${oldBranch}`

  // No destination refspec: the sha only has to exist locally for the push, no ref is written.
  await $({ cwd: projectRoot, quiet: true })`git fetch origin ${sourceRef}`

  const oldSha = await lsRemoteHead(projectRoot, oldBranch)

  if (oldSha === null || oldSha !== ctx.probe.oldRemoteSha) {
    refuse({
      operation: `push ${newBranch}`,
      remediation: 're-run so the new tip is re-checked before anything is pushed',
      stderrExcerpt: `origin ${oldBranch} moved since preflight (${ctx.probe.oldRemoteSha} → ${oldSha ?? 'deleted'})`,
    })
  }

  const result = await pushAtomic(projectRoot, [{ branch: newBranch, sha: oldSha }])

  if (!result.pushed) {
    throw new OperationError(undefined, {
      operation: `push ${result.refspecs.join(' ')}`,
      stderrExcerpt: result.stderr,
    })
  }

  return `${newBranch} at ${oldSha.slice(0, 7)}`
}

const openReplacementPr = async (ctx: StepContext, state: RunState): Promise<string> => {
  const metadata = requireValue(ctx.prMetadata, 'the old PR metadata')
  const type = requireValue(ctx.prType, 'the release type')

  state.newPrNumber = await openReleasePr({
    head: ctx.target.newBranch,
    base: metadata.baseRefName,
    title: formatPrTitle(ctx.target.newId, type),
    body: metadata.body,
    labels: metadata.labels,
    assignees: metadata.assignees,
    milestone: metadata.milestone,
    draft: metadata.isDraft,
  })

  return `#${state.newPrNumber}`
}

/** `contains(oR, nR)` once more: a teammate's push to `<old>` since preflight must not be retargeted away. */
const assertOldContainedInNew = async (target: RenameTarget, oldSha: string | null): Promise<void> => {
  const newSha = await lsRemoteHead(target.projectRoot, target.newBranch)

  if (newSha === null) throw new Error(`origin ${target.newBranch} is missing`)
  if (oldSha === null || (await compareContains(oldSha, newSha))) return

  refuse({
    operation: `move ${target.oldBranch} to ${target.newBranch}`,
    remediation: mergeOldIntoNewRemediation(target),
    stderrExcerpt: `${target.oldBranch} has commits ${target.newBranch} lacks`,
  })
}

const retargetChildren = async (ctx: StepContext): Promise<string> => {
  const { target } = ctx
  const children = await listOpenPRsByBase(target.oldBranch)

  if (children.length === 0) return 'none left'

  await assertOldContainedInNew(target, await lsRemoteHead(target.projectRoot, target.oldBranch))

  for (const child of children) {
    await retargetPrBase(child.number, target.newBranch)
  }

  return children
    .map((child) => {
      return `#${child.number}`
    })
    .join(', ')
}

const closeOldPr = async (ctx: StepContext, state: RunState): Promise<string> => {
  const anchor = requireValue(ctx.probe.anchorPr, 'the old PR')
  const newPr = requireValue(state.newPrNumber, 'the replacement PR')

  await closePrWithComment(anchor.number, supersededComment(newPr, ctx.target.oldName, ctx.target.newName))

  return `#${anchor.number} superseded by #${newPr}`
}

const deleteOldBranch = async (ctx: StepContext): Promise<string> => {
  const { target } = ctx
  const oldSha = await lsRemoteHead(target.projectRoot, target.oldBranch)

  if (oldSha === null) return 'already gone'

  await assertOldContainedInNew(target, oldSha)

  // GitHub closes every open PR whose base is deleted; one opened since pr-retarget is left for the
  // re-run, whose regressable pr-retarget moves it before this step deletes anything.
  const lateChildren = await listOpenPRsByBase(target.oldBranch)

  if (lateChildren.length > 0) {
    refuse({
      operation: `delete origin ${target.oldBranch}`,
      remediation: `re-run the same rename: it retargets them to ${target.newBranch} first`,
      stderrExcerpt: `PRs were opened on ${target.oldBranch} after the retarget step, and deleting it would close them: ${formatPrList(lateChildren)}`,
    })
  }

  const result = await deleteRemoteBranchWithLease(target.projectRoot, target.oldBranch, oldSha)

  if (!result.deleted) {
    throw new OperationError(undefined, {
      operation: `delete origin ${target.oldBranch} at ${oldSha.slice(0, 7)}`,
      stderrExcerpt: result.stderr,
    })
  }

  return `origin ${target.oldBranch} deleted`
}

const renameBranchLocally = async (ctx: StepContext): Promise<string> => {
  const { projectRoot, oldBranch, newBranch } = ctx.target
  const staleTracking = `refs/remotes/origin/${oldBranch}`

  const trackingRefspec = `+refs/heads/${newBranch}:refs/remotes/origin/${newBranch}`

  // Absent on a re-run whose previous attempt renamed the branch and then failed before the upstream.
  if (ctx.probe.localOldSha !== null) await renameLocalBranch(projectRoot, oldBranch, newBranch)
  await $({ cwd: projectRoot, quiet: true })`git fetch origin ${trackingRefspec}`
  await setUpstream(projectRoot, newBranch, `origin/${newBranch}`)

  if ((await revParseVerify(projectRoot, staleTracking)) !== null) {
    await $({ cwd: projectRoot, quiet: true })`git update-ref -d ${staleTracking}`
  }

  return `${oldBranch} → ${newBranch}, tracking origin/${newBranch}`
}

const sweepOldPath = async (oldPath: string): Promise<void> => {
  logger.info(`⏳ waiting up to 10 s for session hooks to finish writing to ${oldPath}`)

  await waitAndSweepOldPath({
    oldPath,
    sleep: async (ms) => {
      await delay(ms)
    },
    now: Date.now,
  })
}

const reopenOrca = async (ctx: StepContext): Promise<boolean> => {
  try {
    await openOrcaWorktreeTerminals({
      cwd: ctx.target.newPath,
      title: buildOrcaTerminalTitle({ branch: ctx.target.newBranch }),
      focus: false,
      layout: 'full',
      panes: ctx.orcaPanes,
    })

    return true
  } catch (error) {
    logger.warn({ err: error }, `⚠️ could not reopen Orca terminals in ${ctx.target.newPath}`)

    return false
  }
}

const moveTheWorktree = async (ctx: StepContext, state: RunState): Promise<string> => {
  const { projectRoot, oldPath, newPath } = ctx.target

  if (ctx.places.worktree.sweepOnly) {
    await sweepOldPath(oldPath)

    return `${oldPath} swept`
  }

  // `git worktree move` into an existing directory nests the worktree inside it and still succeeds.
  await assertWorktreeMovable(ctx.target, ctx.details)
  await assertWorktreeIdle(oldPath)

  const closing = await closeOrcaWorktreeTerminals(oldPath, await probeOrca())

  if (!closing.closed && 'error' in closing) {
    throw new OperationError(closing.error, {
      operation: `close the Orca terminals of ${oldPath}`,
      remediation: 'close them by hand (orca terminal close --terminal <handle>), then re-run',
    })
  }

  await moveWorktree(projectRoot, oldPath, newPath)
  state.worktreeMoved = true

  await sweepOldPath(oldPath)

  if (ctx.openInOrca) state.orcaReopened = await reopenOrca(ctx)

  return `${oldPath} → ${newPath}`
}

const STEP_RUNNERS: Record<RenameStep, (ctx: StepContext, state: RunState) => Promise<string>> = {
  jira: renameJira,
  'remote-push': pushNewBranch,
  'pr-open': openReplacementPr,
  'pr-retarget': retargetChildren,
  'pr-close': closeOldPr,
  'remote-delete': deleteOldBranch,
  'local-branch': renameBranchLocally,
  worktree: moveTheWorktree,
}

async function runStep(step: RenameStep, ctx: StepContext, state: RunState): Promise<void> {
  try {
    const outcome = await STEP_RUNNERS[step](ctx, state)

    state.completed.push(step)
    logger.info({ step, outcome }, `✅ ${STEP_LABELS[step]} — ${outcome}`)
  } catch (error) {
    throw new StepFailure(step, error)
  }
}

const buildResidueError = (ctx: StepContext, state: RunState, failure: StepFailure): OperationError => {
  const { target } = ctx
  const residue = buildResidueText(target, withCompleted(ctx.places, state.completed), failure.step)
  // A mid-run refusal's own remediation is the actionable half; keep it ahead of the report.
  const refusal = failure.reason instanceof OperationError ? failure.reason.remediation : undefined

  return new OperationError(failure.reason, {
    operation: `rename release ${target.oldLabel} → ${target.newLabel} — step ${STEP_ORDER.indexOf(failure.step) + 1} of ${STEP_ORDER.length} (${STEP_LABELS[failure.step]})`,
    remediation: refusal ? `${refusal}\n${residue}` : residue,
  })
}

/** Every pending step in `STEP_ORDER`, aborting on the first failure; no rollback of any kind. */
export const executeRename = async (ctx: StepContext): Promise<RunState> => {
  const state: RunState = {
    completed: [],
    newPrNumber: ctx.probe.openNewPrs[0]?.number ?? null,
    worktreeMoved: false,
    orcaReopened: false,
  }

  const pending = STEP_ORDER.filter((step) => {
    return ctx.places[step].state === 'pending'
  })

  try {
    for (const step of pending) {
      await runStep(step, ctx, state)
    }
  } catch (error) {
    if (error instanceof StepFailure) throw buildResidueError(ctx, state, error)

    throw error
  }

  return state
}
