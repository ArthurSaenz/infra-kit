import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { deliverJiraRelease, loadJiraConfigOptional } from 'src/integrations/jira'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { formatZxError } from 'src/lib/errors/format-zx-error'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentWorktrees,
  getProjectRoot,
  getRepoName,
} from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { displayLabel, formatJiraName, formatRcTitle, parseBranchName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import {
  detectReleaseType,
  formatBranchChoices,
  getJiraDescriptions,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { removeWorktrees } from 'src/lib/worktrees'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface GhReleaseDeliverArgs extends RequiredConfirmedOptionArg {
  version: string
}

type PRState = 'OPEN' | 'MERGED' | 'CLOSED'

interface PRStatus {
  number: number
  state: PRState
  title: string
}

/**
 * Wrap a delivery step so its failure logs structured zx fields and surfaces
 * an `OperationError` whose message names the actual step that failed —
 * instead of the previous blanket "merging release branch into dev" message.
 */
const runStep = async <T>(operation: string, remediation: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    logger.error({ err: formatZxError(error) }, `❌ Failed to ${operation}`)
    throw new OperationError(error, { operation, remediation })
  }
}

/**
 * Fetch the (most-recent) PR for the given head branch, across all states, so
 * we can resume a partially-completed delivery: a PR merged on a prior attempt
 * still appears here as `state: 'MERGED'`, letting the caller skip the merge.
 */
const fetchPRByHead = async (head: string): Promise<PRStatus | null> => {
  const result = await $`gh pr list --head ${head} --state all --json number,state,title --limit 1`
  const prs = JSON.parse(result.stdout) as PRStatus[]

  return prs[0] ?? null
}

/**
 * Find a MERGED RC PR (dev → main) whose title matches the given version, used
 * to detect that a prior delivery run already merged the RC and we should skip
 * the merge step on resume. Title-matched on purpose: an older MERGED RC PR
 * from a different release must not short-circuit this version's flow.
 */
const fetchMergedRcPRForVersion = async (id: ReleaseId): Promise<PRStatus | null> => {
  const expectedTitle = formatRcTitle(id)
  const result = await $`gh pr list --head dev --base main --state merged --json number,state,title --limit 20`
  const prs = JSON.parse(result.stdout) as PRStatus[]
  const match = prs.find((pr) => {
    return pr.title === expectedTitle
  })

  return match ?? null
}

/**
 * Find an open dev → main PR, if any. GitHub allows at most one open PR per
 * head/base pair, so an existing open PR here is the RC PR for this release —
 * even if its title was set by a previous (failed) delivery run. Adopting it
 * is what makes the flow recoverable after a mid-run failure.
 */
const fetchOpenDevToMainPR = async (): Promise<PRStatus | null> => {
  const result = await $`gh pr list --head dev --base main --state open --json number,state,title --limit 5`
  const prs = JSON.parse(result.stdout) as PRStatus[]

  return prs[0] ?? null
}

interface ResolvedTarget {
  selectedReleaseBranch: string
  releasePrTitle: string
}

const resolveTargetFromVersion = async (version: string): Promise<ResolvedTarget> => {
  const selectedReleaseBranch = resolveReleaseBranch(version)
  const pr = await fetchPRByHead(selectedReleaseBranch)

  if (!pr) {
    logger.error(`❌ No PR found for branch ${selectedReleaseBranch}.`)
    throw new OperationError(undefined, {
      operation: `deliver release ${selectedReleaseBranch}`,
      remediation: `confirm a PR exists ('gh pr list --head ${selectedReleaseBranch} --state all')`,
    })
  }

  return { selectedReleaseBranch, releasePrTitle: pr.title }
}

const resolveTargetInteractively = async (): Promise<ResolvedTarget> => {
  const releasePRsInfo = await getReleasePRsWithInfo()

  const branches = releasePRsInfo.map((pr) => {
    return pr.branch
  })

  const releaseTypes = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)]
    }),
  )

  commandEcho.setInteractive()

  const descriptions = await getJiraDescriptions()

  const selectedReleaseBranch = await select({
    message: '🌿 Select release branch',
    choices: formatBranchChoices({ branches, descriptions, types: releaseTypes }),
  })

  const prInfo = releasePRsInfo.find((pr) => {
    return pr.branch === selectedReleaseBranch
  })

  if (!prInfo) {
    logger.error(`❌ Release branch ${selectedReleaseBranch} not found in open PRs.`)
    throw new OperationError(undefined, {
      operation: `deliver release ${selectedReleaseBranch}`,
      remediation: `confirm an open PR exists for ${selectedReleaseBranch} ('gh pr list')`,
    })
  }

  return { selectedReleaseBranch, releasePrTitle: prInfo.title }
}

/**
 * `gh pr merge --delete-branch` also deletes the local branch, which fails if a
 * worktree has it checked out (the actual root cause of the "Failed to merge
 * release PR" surface error). Pre-remove any worktree for the release branch
 * so the local delete can succeed.
 */
const removeReleaseWorktreeIfPresent = async (releaseBranch: string): Promise<void> => {
  const worktreeBranches = await getCurrentWorktrees('release')

  if (!worktreeBranches.includes(releaseBranch)) return

  const [projectRoot, repoName] = await Promise.all([getProjectRoot(), getRepoName()])
  const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

  const removed = await removeWorktrees({ branches: [releaseBranch], worktreeDir, repoName })

  if (removed.length === 0) {
    throw new OperationError(undefined, {
      operation: `remove worktree for ${releaseBranch} before merge`,
      remediation: `run manually: git worktree remove ${worktreeDir}/${releaseBranch} (use --force if uncommitted changes)`,
    })
  }
}

interface MergeReleasePRArgs {
  selectedReleaseBranch: string
  releaseType: ReleaseType
}

const mergeReleasePR = async (args: MergeReleasePRArgs): Promise<void> => {
  const { selectedReleaseBranch, releaseType } = args

  const mergeTarget = releaseType === 'hotfix' ? 'main' : 'dev'

  const releasePr = await fetchPRByHead(selectedReleaseBranch)

  if (!releasePr) {
    throw new OperationError(undefined, {
      operation: `look up release PR for ${selectedReleaseBranch}`,
      remediation: `verify the PR exists in GitHub`,
    })
  }

  if (releasePr.state === 'MERGED') {
    logger.info(`✓ Release PR ${selectedReleaseBranch} already merged — skipping`)

    return
  }

  if (releasePr.state === 'CLOSED') {
    throw new OperationError(undefined, {
      operation: `merge release PR ${selectedReleaseBranch} into ${mergeTarget}`,
      remediation: `the PR is closed without merge; reopen it or create a new release`,
    })
  }

  await runStep(
    `merge release PR ${selectedReleaseBranch} into ${mergeTarget}`,
    `check 'gh pr view ${selectedReleaseBranch}' for mergeability and required reviews`,
    async () => {
      await $`gh pr merge ${selectedReleaseBranch} --squash --admin --delete-branch`
    },
  )
}

const resolveRcPRNumber = async (id: ReleaseId): Promise<number> => {
  const selectedLabel = displayLabel(id)
  const expectedTitle = formatRcTitle(id)
  const existingOpen = await fetchOpenDevToMainPR()

  // Adopt any existing open dev→main PR. GitHub permits only one open PR per
  // head/base pair, so a stale open RC PR (left behind by a prior failed run
  // — the single most common cause of "Error merging release branch into
  // dev") blocks `gh pr create`. Retitle it instead of fighting it.
  if (existingOpen) {
    const rcNumber = existingOpen.number

    if (existingOpen.title !== expectedTitle) {
      logger.info(
        `Adopting open dev → main PR #${rcNumber} ("${existingOpen.title}") and retitling for ${selectedLabel}`,
      )
      await runStep(
        `retitle dev → main PR #${rcNumber} to "${expectedTitle}"`,
        `update manually: gh pr edit ${rcNumber} --title "${expectedTitle}"`,
        async () => {
          await $`gh pr edit ${rcNumber} --title ${expectedTitle}`
        },
      )
    }

    return rcNumber
  }

  await runStep(
    `create RC PR (dev → main) for ${selectedLabel}`,
    `run 'gh pr create --base main --head dev' manually to surface the underlying error (e.g. no commits between dev and main)`,
    async () => {
      await $`gh pr create --base main --head dev --title ${expectedTitle} --body ""`
    },
  )

  const created = await fetchOpenDevToMainPR()

  if (!created) {
    throw new OperationError(undefined, {
      operation: `look up RC PR for ${selectedLabel}`,
      remediation: `verify the RC PR was created ('gh pr list --head dev --base main')`,
    })
  }

  return created.number
}

const ensureRcPRMerged = async (id: ReleaseId): Promise<void> => {
  const selectedLabel = displayLabel(id)
  const alreadyMerged = await fetchMergedRcPRForVersion(id)

  if (alreadyMerged) {
    logger.info(`✓ RC PR for ${selectedLabel} already merged into main — skipping`)

    return
  }

  const rcNumber = await resolveRcPRNumber(id)

  await runStep(
    `merge RC PR #${rcNumber} (dev → main) for ${selectedLabel}`,
    `check 'gh pr view ${rcNumber}' for mergeability and required reviews`,
    async () => {
      await $`gh pr merge ${rcNumber} --squash --admin`
    },
  )
}

const dispatchDeployWorkflow = async (): Promise<void> => {
  $.quiet = false

  await runStep(
    `dispatch deploy-all workflow on main`,
    `check 'gh workflow list' and that you have permission to dispatch deploy-all.yml`,
    async () => {
      await $`gh workflow run deploy-all.yml --ref main -f environment=prod`
    },
  )

  $.quiet = true
}

const syncMainIntoDev = async (): Promise<void> => {
  await runStep(
    `sync main back into dev`,
    `run manually: git switch main && git pull && git switch dev && git pull && git merge main --no-edit && git push`,
    async () => {
      await $`git switch main && git pull && git switch dev && git pull && git merge main --no-edit && git push`
    },
  )
}

/**
 * Best-effort cleanup of the delivered release branch, locally and on `origin`.
 *
 * Idempotent backstop to `gh pr merge --delete-branch` (in `mergeReleasePR`):
 * that flag is skipped when the release PR was already merged on a prior
 * attempt, so an idempotent re-run would otherwise leave the branch behind.
 * Each delete is isolated — a failure (e.g. the branch checked out in a stray
 * worktree, or a remote hiccup) logs a warning naming the branch and never
 * aborts delivery, since the irreversible merge and deploy already happened.
 */
const removeDeliveredReleaseBranch = async (branch: string): Promise<void> => {
  try {
    await deleteLocalBranch(branch)
  } catch (error) {
    logger.warn({ err: formatZxError(error) }, `Failed to delete local branch ${branch} (non-blocking)`)
  }

  try {
    await deleteRemoteBranch(branch)
  } catch (error) {
    logger.warn({ err: formatZxError(error) }, `Failed to delete remote branch ${branch} (non-blocking)`)
  }
}

const deliverJiraReleaseSafely = async (id: ReleaseId): Promise<void> => {
  const jiraConfig = await loadJiraConfigOptional()

  if (!jiraConfig) {
    logger.info('🔔 Jira is not configured, skipping Jira release delivery')

    return
  }

  try {
    // Jira fix version name: `v1.2.3` | `<name>` — must match create-time formatJiraName.
    const versionName = formatJiraName(id)

    await deliverJiraRelease({ versionName }, jiraConfig)
  } catch (error) {
    logger.error({ err: formatZxError(error) }, 'Failed to deliver Jira release (non-blocking)')
  }
}

/**
 * Deliver a release branch to production. Each network/git step is run inside
 * `runStep` so the surfaced error names the failing operation and includes the
 * subprocess stderr. PR-merge steps are idempotent: if the release PR or RC PR
 * is already MERGED, the step is skipped, so re-running after a mid-flight
 * failure picks up where it stopped.
 */
export const ghReleaseDeliver = async (args: GhReleaseDeliverArgs) => {
  const { version, confirmedCommand } = args

  commandEcho.start('release-deliver')

  // Branch-agnostic (operates on release/RC PRs via gh and self-switches), so
  // only the worktree + clean-tree legs apply.
  await assertManagementContext({ operation: 'deliver release' })

  const { selectedReleaseBranch, releasePrTitle } = version
    ? await resolveTargetFromVersion(version)
    : await resolveTargetInteractively()

  // selectedReleaseBranch is always a release branch (operator ref strictly
  // parsed, or picked from discovery-filtered choices) so this cannot be null.
  const releaseId = parseBranchName(selectedReleaseBranch)

  if (!releaseId) {
    throw new OperationError(undefined, {
      operation: `deliver release ${selectedReleaseBranch}`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
    })
  }

  const selectedVersion = displayLabel(releaseId)

  commandEcho.addOption('--version', selectedVersion)
  logger.info(`Delivering ${releaseId.kind === 'name' ? 'named release' : 'version'} ${selectedReleaseBranch}`)

  const releaseType: ReleaseType = detectReleaseType(releasePrTitle)

  const answer = confirmedCommand
    ? true
    : await confirm({
        message: `Are you sure you want to deliver version ${selectedReleaseBranch} to production?`,
      })

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }

  // Track --yes flag if confirmation was interactive (user confirmed)
  commandEcho.addOption('--yes', true)

  $.quiet = true

  await removeReleaseWorktreeIfPresent(selectedReleaseBranch)
  await mergeReleasePR({ selectedReleaseBranch, releaseType })

  if (releaseType !== 'hotfix') {
    await ensureRcPRMerged(releaseId)
  }

  await dispatchDeployWorkflow()
  await syncMainIntoDev()
  await removeDeliveredReleaseBranch(selectedReleaseBranch)

  $.quiet = false

  await deliverJiraReleaseSafely(releaseId)

  logger.info(`Successfully delivered ${selectedReleaseBranch} to production!`)

  commandEcho.print()

  const structuredContent = {
    releaseBranch: selectedReleaseBranch,
    version: selectedVersion,
    type: releaseType,
    success: true,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const ghReleaseDeliverMcpTool = defineMcpTool({
  name: 'gh-release-deliver',
  description:
    'Deliver a release to production. For hotfixes: squash-merges the release branch to main and dispatches the deploy-all workflow. For regular releases: squash-merges to dev, opens an RC PR, merges dev into main, dispatches the deploy-all workflow, then syncs main back to dev. Also releases the matching Jira fix version if Jira is configured. Dispatches the deploy workflow fire-and-forget — the tool returns once the workflow is accepted by GitHub, not when the deployment finishes. PR-merge steps are idempotent: re-running after a partial failure skips PRs that are already merged. Irreversible production operation: the confirmation prompt is auto-skipped for MCP calls, so the caller is responsible for gating. "version" is required when invoked via MCP (the picker is unreachable without a TTY).',
  inputSchema: {
    version: z
      .string()
      .describe(
        'Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign") to deliver to production. Required for MCP calls.',
      ),
  },
  outputSchema: {
    releaseBranch: z.string().describe('The release branch that was delivered'),
    version: z.string().describe('The version that was delivered'),
    type: z.enum(['regular', 'hotfix']).describe('Release type'),
    success: z.boolean().describe('Whether the delivery was successful'),
  },
  handler: ghReleaseDeliver,
})
