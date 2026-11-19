import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { defaultIsListening } from 'src/dev/proxy/portless-driver'
import type { IsListening } from 'src/dev/proxy/portless-driver'
import {
  fetchActiveRuns,
  fetchCompareStatus,
  fetchRenamePermissions,
  listOpenPRBodies,
} from 'src/integrations/gh/pr-lifecycle'
import { buildJiraVersionUrl, getMyJiraPermissions } from 'src/integrations/jira/api'
import type { JiraConfig } from 'src/integrations/jira/types'
import { orcaCallerInsideTargets } from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { readDevContext } from 'src/lib/dev-context/dev-context'
import { OperationError } from 'src/lib/errors/operation-error'
import type { OperationErrorContext } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { hasOperationInProgress } from 'src/lib/git-utils/scratch-worktree'
import { logger } from 'src/lib/logger'
import { readRecord, recordPath } from 'src/lib/merge-dev-records/merge-dev-records'
import { parseBranchName, parseReleaseRef } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import { parseJiraVersionIdFromPrBody } from 'src/lib/release-utils/release-utils'

import { STEP_ORDER } from './rename-classifier'
import type { RenameClassification, RenamePlaces, RenameProbe, RenameStep } from './rename-classifier'
import { formatPrList, placeWord } from './rename-output'
import { realOrResolved } from './rename-probe'
import type { ProbeDetails, RenameTarget } from './rename-probe'

export const OPERATION = 'rename a release'

// Annotated on the const so TypeScript treats every call as terminating control flow.
export const refuse: (context: OperationErrorContext) => never = (context) => {
  logger.warn({ operation: context.operation }, `⛔ ${context.stderrExcerpt ?? context.operation}`)

  throw new OperationError(undefined, context)
}

const NEXT_TOKEN = 'next'

const parseRef = (ref: string, role: 'old' | 'new'): ReleaseId => {
  if (ref.trim().toLowerCase() === NEXT_TOKEN) {
    refuse({
      operation: OPERATION,
      remediation: `pass a concrete version (e.g. "1.3.0") or a kebab-case name as <${role}>`,
      stderrExcerpt: `"next" is not accepted as <${role}>: a rename needs the exact name`,
    })
  }

  try {
    return parseReleaseRef(ref)
  } catch (error) {
    return refuse({
      operation: OPERATION,
      remediation: 'pass a version (e.g. "1.2.5") or a kebab-case release name of at most 50 characters',
      stderrExcerpt: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Same validation as `release create`: semver, or a kebab-case non-reserved name of at most 50 characters. */
export const parseRenameRefs = (oldRef: string, newRef: string): { oldId: ReleaseId; newId: ReleaseId } => {
  const oldId = parseRef(oldRef, 'old')
  const newId = parseRef(newRef, 'new')

  if (oldId.kind === newId.kind && oldId.raw === newId.raw) {
    refuse({
      operation: OPERATION,
      remediation: 'pass a <new> that differs from <old>',
      stderrExcerpt: `<old> and <new> both name ${oldId.raw}`,
    })
  }

  return { oldId, newId }
}

export const formatPlaceTable = (places: RenamePlaces): string => {
  return STEP_ORDER.map((step) => {
    const place = places[step]
    const reason = place.reason ? ` — ${place.reason}` : ''

    return `  ${step}: ${placeWord(place)}${reason}`
  }).join('\n')
}

export const refuseConflict = (
  target: RenameTarget,
  classification: Extract<RenameClassification, { kind: 'conflict' }>,
): never => {
  const fix = classification.remediation ? `${classification.remediation}. ` : ''

  return refuse({
    operation: `rename release ${target.oldLabel} → ${target.newLabel}`,
    remediation: `${fix}Nothing was changed.\nper place:\n${formatPlaceTable(classification.places)}`,
    stderrExcerpt: classification.reason,
  })
}

export const assertAnchorLinked = (target: RenameTarget, probe: RenameProbe, expectedUrl: string | null): void => {
  const anchor = probe.anchorPr

  if (anchor === null || anchor.bodyJiraId !== null) return

  const link = expectedUrl === null ? 'the Jira fix-version link' : `the line ${expectedUrl}`

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: `add ${link} to the body of PR #${anchor.number}, then re-run`,
    stderrExcerpt: `PR #${anchor.number} on ${target.oldBranch} does not link a Jira fix version`,
  })
}

export const assertActive = (target: RenameTarget, active: boolean): void => {
  if (active) return

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: 'only an active release (one open release PR) can be renamed — `infra-kit release list` shows them',
    stderrExcerpt: `${target.oldBranch} has no open release PR`,
  })
}

const isDone = (places: RenamePlaces, step: RenameStep): boolean => {
  return places[step].state === 'done'
}

export const assertGitHubPermissions = async (target: RenameTarget, places: RenamePlaces): Promise<void> => {
  const pushDone = isDone(places, 'remote-push')
  const deleteDone = isDone(places, 'remote-delete')

  if (pushDone && deleteDone) return

  const permissions = await fetchRenamePermissions(target.oldBranch, target.newBranch)
  const operation = `rename release ${target.oldLabel}`

  if (!permissions.canPush) {
    refuse({
      operation,
      remediation: 'ask a repository admin for write access',
      stderrExcerpt: 'the gh token has no push permission on this repository',
    })
  }

  if (!deleteDone && permissions.oldProtected) {
    refuse({
      operation,
      remediation: `remove the branch protection from ${target.oldBranch} first`,
      stderrExcerpt: `${target.oldBranch} is protected, so it cannot be deleted`,
    })
  }

  if (!deleteDone && permissions.oldRules.includes('deletion')) {
    refuse({
      operation,
      remediation: `exclude ${target.oldBranch} from the ruleset that restricts deletion`,
      stderrExcerpt: `a ruleset forbids deleting ${target.oldBranch}`,
    })
  }

  if (!pushDone && permissions.newRules.includes('creation')) {
    refuse({
      operation,
      remediation: `exclude ${target.newBranch} from the ruleset that restricts creation`,
      stderrExcerpt: `a ruleset forbids creating ${target.newBranch}`,
    })
  }
}

const JIRA_ADMIN_PERMISSIONS = ['ADMINISTER_PROJECTS', 'ADMINISTER']

/** Renaming a version needs Administer Projects or Administer Jira; caught here so a 403 never lands mid-run. */
export const assertJiraPermission = async (places: RenamePlaces, config: JiraConfig): Promise<void> => {
  if (isDone(places, 'jira')) return

  const granted = await getMyJiraPermissions(config, JIRA_ADMIN_PERMISSIONS)

  if (Object.values(granted).some(Boolean)) return

  refuse({
    operation: 'rename the Jira fix version',
    remediation: 'ask a Jira admin for the Administer Projects permission on this project, then re-run',
    stderrExcerpt: 'the Jira user has neither Administer Projects nor Administer Jira',
  })
}

/** A deploy run that checks the branch out by name mid-run would break once it is deleted. */
export const assertNoActiveRuns = async (target: RenameTarget, places: RenamePlaces): Promise<void> => {
  if (isDone(places, 'remote-delete')) return

  const runs = await fetchActiveRuns(target.oldBranch)

  if (runs.length === 0) return

  const listed = runs
    .map((run) => {
      return `${run.workflowName} #${run.databaseId} (${run.status})`
    })
    .join(', ')

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: `wait for them to finish, or cancel with \`gh run cancel ${runs[0]?.databaseId}\`, then re-run`,
    stderrExcerpt: `workflow runs are active on ${target.oldBranch}: ${listed}`,
  })
}

/** The resolution worktree is keyed by the branch name, so a pending hand-off must finish first. */
export const assertNoMergeDevRecord = async (target: RenameTarget): Promise<void> => {
  const record = await readRecord(await recordPath(target.projectRoot, target.oldBranch))

  if (record === null) return

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation:
      'finish or drop it first: `infra-kit release merge-dev --continue` or `infra-kit release merge-dev --abort`',
    stderrExcerpt: `a merge-dev resolution for ${target.oldBranch} is pending`,
  })
}

/** `gh pr create` refuses a head with no commits ahead of its base; caught before anything changes. */
export const assertCommitsAhead = async (
  target: RenameTarget,
  places: RenamePlaces,
  probe: RenameProbe,
  base: string,
): Promise<void> => {
  const head = probe.oldRemoteSha ?? probe.newRemoteSha

  if (isDone(places, 'pr-open') || head === null) return

  const status = await fetchCompareStatus(base, head)

  if (status === 'ahead' || status === 'diverged') return

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: `a replacement PR cannot be opened for a branch with no commits ahead of ${base}`,
    stderrExcerpt: `${target.oldBranch} has no commits ahead of ${base}`,
  })
}

interface FreshAnchorInput {
  target: RenameTarget
  probe: RenameProbe
  details: ProbeDetails
  config: JiraConfig
}

/** Ownership never rests on the Jira id alone: the body link must match the name, and no other PR may claim it. */
export const assertFreshAnchor = async (input: FreshAnchorInput): Promise<void> => {
  const { target, probe, details, config } = input
  const linked = probe.anchorPr?.bodyJiraId ?? null
  const byName = details.jiraByOldName

  if (linked === null || byName === null || String(byName.id) !== linked) {
    const expected =
      byName === null ? `a Jira fix version named ${target.oldName}` : buildJiraVersionUrl(config, byName)

    refuse({
      operation: `rename release ${target.oldLabel}`,
      remediation: `make the body of PR #${probe.anchorPr?.number} link ${expected}, then re-run`,
      stderrExcerpt: `the PR body links Jira version ${linked ?? 'none'}, not the version named ${target.oldName}`,
    })
  }

  const others = (await listOpenPRBodies()).filter((pr) => {
    return (
      pr.headRefName !== target.oldBranch &&
      parseBranchName(pr.headRefName) !== null &&
      parseJiraVersionIdFromPrBody(pr.body) === linked
    )
  })

  if (others.length === 0) return

  refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: 'fix the PR body that links the wrong version, then re-run',
    stderrExcerpt: `other release PRs link the same Jira version: ${formatPrList(others)}`,
  })
}

/** Containment by realpath on BOTH sides: a resolved cwd never matches an unresolved root. */
export const isPathInside = async (child: string, parent: string): Promise<boolean> => {
  const [realChild, realParent] = await Promise.all([realOrResolved(child), realOrResolved(parent)])

  return realChild === realParent || realChild.startsWith(`${realParent}${path.sep}`)
}

/**
 * Ports of dev servers running in the worktree. `readDevContext` falls back up-tree (to `$HOME`'s
 * `.infra-kit` by default), so only fragments in the directory the runner writes for THIS worktree count.
 */
export const liveDevServerPorts = async (
  worktreePath: string,
  isListening: IsListening = defaultIsListening,
): Promise<number[]> => {
  const snapshot = readDevContext(worktreePath)
  const expected = path.join(worktreePath, '.infra-kit', 'dev-context')

  if (snapshot.fragmentDir === undefined) return []
  if ((await realOrResolved(snapshot.fragmentDir)) !== (await realOrResolved(expected))) return []

  const live = await Promise.all(
    snapshot.apps.map(async (app) => {
      return (await isListening(app.port)) ? [app.port] : []
    }),
  )

  return live.flat()
}

/** The worktree must hold nothing live; re-run right before the move as well. */
export const assertWorktreeIdle = async (worktreePath: string): Promise<void> => {
  if (await isPathInside(process.cwd(), worktreePath)) {
    refuse({
      operation: `move the worktree ${worktreePath}`,
      remediation: 'run the command from the main checkout',
      stderrExcerpt: 'the current directory is inside the worktree that would move',
    })
  }

  const inside = await orcaCallerInsideTargets([worktreePath])

  if (inside !== null) {
    logger.warn({ operation: OPERATION }, `⛔ this command runs inside an Orca terminal of ${inside}`)

    throw new StructuredRefusalError(
      { status: 'refused', reason: 'orca_caller_inside_target', agentMode: agentMode.source },
      2,
      {
        operation: OPERATION,
        remediation: `re-run from a terminal that is not an Orca pane of ${inside}`,
        stderrExcerpt: `this command runs inside an Orca terminal of ${inside}, which the move would close`,
      },
    )
  }

  const ports = await liveDevServerPorts(worktreePath)

  if (ports.length === 0) return

  refuse({
    operation: `move the worktree ${worktreePath}`,
    remediation: 'stop the dev servers running there, then re-run',
    stderrExcerpt: `dev servers are listening from ${worktreePath} on port(s) ${ports.join(', ')}`,
  })
}

const hasSubmodules = async (worktreePath: string): Promise<boolean> => {
  const result = await $({ cwd: worktreePath, quiet: true })`git submodule status`

  return result.stdout.trim() !== ''
}

const pathExists = async (target: string): Promise<boolean> => {
  return fs.access(target).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )
}

/** `git worktree move` refuses each of these; caught before anything changes instead of at step 8. */
export const assertWorktreeMovable = async (target: RenameTarget, details: ProbeDetails): Promise<void> => {
  const { oldPath, newPath } = target
  const operation = `move the worktree ${oldPath}`

  if (details.oldWorktree?.locked) {
    refuse({ operation, remediation: `\`git worktree unlock ${oldPath}\`, then re-run`, stderrExcerpt: 'it is locked' })
  }

  if (await hasSubmodules(oldPath)) {
    refuse({
      operation,
      remediation: 'move it by hand with the submodules deinitialised, then re-run',
      stderrExcerpt: 'it has submodules, which git worktree move refuses',
    })
  }

  if (await hasOperationInProgress(oldPath)) {
    refuse({
      operation,
      remediation: `finish or abort the rebase, merge or bisect in ${oldPath}, then re-run`,
      stderrExcerpt: 'a rebase, merge or bisect is in progress there',
    })
  }

  if (await pathExists(newPath)) {
    refuse({
      operation,
      remediation: `move ${newPath} out of the way, then re-run`,
      stderrExcerpt: `${newPath} already exists`,
    })
  }
}
