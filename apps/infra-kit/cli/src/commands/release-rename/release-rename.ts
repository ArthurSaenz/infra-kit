import input from '@inquirer/input'
import { z } from 'zod'
import { $ } from 'zx'

import { createReleaseRenameFormProvider } from 'src/commands/release-rename/release-rename-form'
import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { fetchPRMetadata } from 'src/integrations/gh/pr-lifecycle'
import type { PRMetadata } from 'src/integrations/gh/pr-lifecycle'
import { fetchPRReviewState } from 'src/integrations/gh/pr-status'
import type { PRReviewState } from 'src/integrations/gh/pr-status'
import { buildJiraVersionUrl, loadJiraConfigOptional } from 'src/integrations/jira/api'
import type { JiraConfig } from 'src/integrations/jira/types'
import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { isCommandDeclined } from 'src/lib/errors/command-declined-error'
import { formatZxError } from 'src/lib/errors/format-zx-error'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { resolveGitFlow } from 'src/lib/git-flow'
import { assertManagementContext } from 'src/lib/git-guard'
import { getProjectRoot } from 'src/lib/git-utils/git-utils'
import { getInfraKitConfig, resolveOrcaLayout } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { refuseMissingArguments } from 'src/lib/prompts/refuse-missing-arguments'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'
import { formatPrTitle } from 'src/lib/release-id'
import { formatBranchPickerItems, getJiraDescriptions } from 'src/lib/release-utils'
import { releaseTypeFromBase } from 'src/lib/release-utils/release-utils'
import type { ReleaseType } from 'src/lib/release-utils/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

import { STEP_ORDER, classifyRename, isActive } from './rename-classifier'
import type { RenameClassification, RenamePlaces, RenameProbe, RenameStep } from './rename-classifier'
import { buildFollowUps, buildPreviewLines, formatFollowUp, placeWord, reviewersToRedo } from './rename-output'
import type { FollowUp } from './rename-output'
import {
  OPERATION,
  assertActive,
  assertAnchorLinked,
  assertCommitsAhead,
  assertFreshAnchor,
  assertGitHubPermissions,
  assertJiraPermission,
  assertNoActiveRuns,
  assertNoMergeDevRecord,
  assertWorktreeIdle,
  assertWorktreeMovable,
  parseRenameRefs,
  refuse,
  refuseConflict,
} from './rename-preflight'
import { buildRenameTarget, probeRename } from './rename-probe'
import type { ProbeDetails, RenameTarget } from './rename-probe'
import { executeRename } from './rename-steps'
import type { RunState, StepContext } from './rename-steps'

export interface ReleaseRenameArgs extends RequiredConfirmedOptionArg {
  old?: string
  new?: string
}

// ONE provider for the catalog's `formProvider` and the agent-mode refusal, so `choices` are the form.
const releaseRenameForm = createReleaseRenameFormProvider()

const POSITIONAL_REMEDIATION = 'pass <old> and <new> as the two positional arguments of release rename'

/** `refuseMissingArguments` names `--<argument>`; these are positionals, so the remediation is replaced. */
const refuseMissingRenameArguments = async (options: ReleaseRenameArgs): Promise<void> => {
  if (!isHeadless()) return

  if (options.old && options.new) return

  const missing = options.old ? 'new' : 'old'

  if (missing === 'old') {
    try {
      await refuseMissingArguments({
        provider: releaseRenameForm,
        params: options,
        operation: OPERATION,
        argument: 'old',
      })
    } catch (error) {
      if (!(error instanceof StructuredRefusalError)) throw error

      throw new StructuredRefusalError(error.structuredContent, 2, {
        operation: OPERATION,
        remediation: `${POSITIONAL_REMEDIATION} — "choices" lists the open releases for <old>`,
        stderrExcerpt: '<old> was not given and there is no human to ask',
      })
    }
  }

  throw new StructuredRefusalError({ status: 'argument_required', argument: missing, agentMode: agentMode.source }, 2, {
    operation: OPERATION,
    remediation: POSITIONAL_REMEDIATION,
    stderrExcerpt: `<${missing}> was not given and there is no human to ask`,
  })
}

const pickOld = async (): Promise<string> => {
  commandEcho.setInteractive()

  const [descriptions, prInfo] = await Promise.all([getJiraDescriptions(), getReleasePRsWithInfo()])

  const branches = prInfo.map((pr) => {
    return pr.branch
  })

  const types = new Map(
    prInfo.map((pr) => {
      return [pr.branch, pr.type] as const
    }),
  )

  try {
    return await pickReleaseBranch(formatBranchPickerItems({ branches, descriptions, types }))
  } catch (error) {
    if (isPromptCancellation(error)) throw error

    throw new OperationError(error, {
      operation: 'select a release to rename',
      remediation: `${POSITIONAL_REMEDIATION}; the picker needs an interactive terminal`,
    })
  }
}

const promptNew = async (oldRef: string): Promise<string> => {
  commandEcho.setInteractive()

  const answer = await withEscape(
    (context) => {
      return input(
        {
          message: `  New version or name for ${oldRef}: `,
          validate: (value) => {
            return value.trim() !== '' || 'enter a version (e.g. 1.3.0) or a kebab-case name'
          },
        },
        context,
      )
    },
    { whenHeadless: 'refuse' },
  )

  return answer.trim()
}

const resolveRefs = async (options: ReleaseRenameArgs): Promise<{ oldRef: string; newRef: string }> => {
  const oldRef = options.old || (await pickOld())
  const newRef = options.new || (await promptNew(oldRef))

  return { oldRef, newRef }
}

const requireJiraConfig = async (): Promise<JiraConfig> => {
  const config = await loadJiraConfigOptional()

  if (config !== null) return config

  return refuse({
    operation: OPERATION,
    remediation:
      'set JIRA_BASE_URL / JIRA_TOKEN / JIRA_PROJECT_ID / JIRA_EMAIL (e.g. `infra-kit env-load`), then re-run',
    stderrExcerpt: 'Jira is not configured, so the fix version cannot be renamed',
  })
}

interface PreflightResult {
  prMetadata: PRMetadata | null
  prType: ReleaseType | null
  reviews: PRReviewState | null
}

const resolvePrType = async (target: RenameTarget, metadata: PRMetadata): Promise<ReleaseType> => {
  const type = releaseTypeFromBase(metadata.baseRefName, await resolveGitFlow())

  if (type !== null) return type

  return refuse({
    operation: `rename release ${target.oldLabel}`,
    remediation: 'retarget the PR onto the integration or main branch first',
    stderrExcerpt: `the PR's base ${metadata.baseRefName} is not a release base of this repo's git flow`,
  })
}

interface PreflightInput {
  target: RenameTarget
  probe: RenameProbe
  details: ProbeDetails
  classification: Exclude<RenameClassification, { kind: 'conflict' | 'done' }>
  jiraConfig: JiraConfig
}

/** Each check is skipped once the step it protects is done, so a resume is not refused by its own progress. */
const runPreflight = async (input: PreflightInput): Promise<PreflightResult> => {
  const { target, probe, details, classification, jiraConfig } = input
  const { places } = classification

  assertActive(target, isActive(probe, places))
  await assertGitHubPermissions(target, places)
  await assertJiraPermission(places, jiraConfig)
  await assertNoActiveRuns(target, places)
  await assertNoMergeDevRecord(target)

  if (classification.kind === 'fresh') await assertFreshAnchor({ target, probe, details, config: jiraConfig })

  const anchorNumber = probe.anchorPr?.number ?? null

  const prMetadata =
    places['pr-open'].state === 'pending' && anchorNumber !== null ? await fetchPRMetadata(anchorNumber) : null

  const prType = prMetadata === null ? null : await resolvePrType(target, prMetadata)

  if (prMetadata !== null) await assertCommitsAhead(target, places, probe, prMetadata.baseRefName)

  if (places.worktree.state === 'pending' && !places.worktree.sweepOnly) {
    await assertWorktreeMovable(target, details)
    await assertWorktreeIdle(target.oldPath)
  }

  return {
    prMetadata,
    prType,
    reviews: anchorNumber === null ? null : await fetchPRReviewState(anchorNumber),
  }
}

/** Secret-free: what the confirm text says, as data. */
const describePlan = (target: RenameTarget, probe: RenameProbe, places: RenamePlaces, preflight: PreflightResult) => {
  return {
    old: target.oldLabel,
    new: target.newLabel,
    oldBranch: target.oldBranch,
    newBranch: target.newBranch,
    jira: { from: target.oldName, to: target.newName, id: probe.jiraVersion ? String(probe.jiraVersion.id) : null },
    places: Object.fromEntries(
      STEP_ORDER.map((step) => {
        return [step, placeWord(places[step])]
      }),
    ),
    oldPr: probe.anchorPr?.number ?? null,
    newPr: probe.openNewPrs[0]?.number ?? null,
    childPrs: probe.childPrs,
    worktree: { from: target.oldPath, to: target.newPath },
    reviewersToRedo: reviewersToRedo(preflight.reviews),
  }
}

type InstallOutcome = 'ok' | 'failed' | 'not-run'

const installDependencies = async (worktreePath: string): Promise<InstallOutcome> => {
  try {
    await $({ cwd: worktreePath })`pnpm install`
    logger.info(`📦 install: ok (pnpm install in ${worktreePath})`)

    return 'ok'
  } catch (error) {
    logger.warn({ err: formatZxError(error) }, `📦 install: failed (pnpm install in ${worktreePath})`)

    return 'failed'
  }
}

interface ReleaseRenameStructured {
  old: string
  new: string
  oldBranch: string
  newBranch: string
  outcome: 'renamed' | 'already-renamed'
  renamedSteps: RenameStep[]
  oldPrNumber: number | null
  newPrNumber: number | null
  worktreePath: string | null
  install: InstallOutcome
  orcaReopened: boolean
  followUps: FollowUp[]
}

interface FinishInput {
  target: RenameTarget
  probe: RenameProbe
  outcome: ReleaseRenameStructured['outcome']
  reviews: PRReviewState | null
  run: RunState | null
  install: InstallOutcome
}

const finish = (input: FinishInput) => {
  const { target, probe, run } = input
  const worktreePath = probe.worktree.atNewPath || run?.worktreeMoved ? target.newPath : null
  const newPrNumber = run?.newPrNumber ?? probe.openNewPrs[0]?.number ?? null

  const followUps = buildFollowUps({
    names: target,
    worktreePath,
    installOk: input.install === 'ok',
    orcaReopened: run?.orcaReopened ?? false,
    newPrNumber,
    reviewers: reviewersToRedo(input.reviews),
  })

  logger.info(
    input.outcome === 'renamed'
      ? `✅ Renamed release ${target.oldLabel} → ${target.newLabel}`
      : `✅ Release ${target.oldLabel} is already renamed to ${target.newLabel} — nothing to do`,
  )
  logger.info(`Follow-ups:\n${followUps.map(formatFollowUp).join('\n')}`)

  const structuredContent: ReleaseRenameStructured = {
    old: target.oldLabel,
    new: target.newLabel,
    oldBranch: target.oldBranch,
    newBranch: target.newBranch,
    outcome: input.outcome,
    renamedSteps: run?.completed ?? [],
    oldPrNumber: probe.anchorPr?.number ?? null,
    newPrNumber,
    worktreePath,
    install: input.install,
    orcaReopened: run?.orcaReopened ?? false,
    followUps,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const alreadyRenamed = async (target: RenameTarget, probe: RenameProbe) => {
  const anchorNumber = probe.anchorPr?.number ?? null
  const reviews = anchorNumber === null ? null : await fetchPRReviewState(anchorNumber)

  return finish({ target, probe, outcome: 'already-renamed', reviews, run: null, install: 'not-run' })
}

const renameRelease = async (options: ReleaseRenameArgs, config: InfraKitConfig) => {
  const { oldRef, newRef } = await resolveRefs(options)
  const { oldId, newId } = parseRenameRefs(oldRef, newRef)
  const jiraConfig = await requireJiraConfig()
  const target = buildRenameTarget(await getProjectRoot(), oldId, newId)
  const { probe, details } = await probeRename(target, jiraConfig)

  logger.debug({ probe }, 'release rename: probe')

  const expectedLink = details.jiraByOldName ? buildJiraVersionUrl(jiraConfig, details.jiraByOldName) : null

  assertAnchorLinked(target, probe, expectedLink)

  const classification = classifyRename(probe)

  if (classification.kind === 'conflict') return refuseConflict(target, classification)
  if (classification.kind === 'done') return alreadyRenamed(target, probe)

  const preflight = await runPreflight({ target, probe, details, classification, jiraConfig })
  const openInOrca = config.worktrees?.openInOrca === true
  const newPrTitle = preflight.prType === null ? null : formatPrTitle(newId, preflight.prType)

  const preview = buildPreviewLines({
    names: target,
    places: classification.places,
    anchorNumber: probe.anchorPr?.number ?? null,
    newPrNumber: probe.openNewPrs[0]?.number ?? null,
    newPrTitle,
    children: probe.childPrs,
    reviews: preflight.reviews,
    openInOrca,
  })

  await confirmOrExit(options.confirmedCommand, preview.join('\n'), {
    plan: describePlan(target, probe, classification.places, preflight),
  })

  const ctx: StepContext = {
    target,
    probe,
    details,
    places: classification.places,
    jiraConfig,
    prMetadata: preflight.prMetadata,
    prType: preflight.prType,
    openInOrca,
    orcaPanes: resolveOrcaLayout(config),
  }

  const run = await executeRename(ctx)
  const install = run.worktreeMoved ? await installDependencies(target.newPath) : 'not-run'

  return finish({ target, probe, outcome: 'renamed', reviews: preflight.reviews, run, install })
}

/**
 * Rename one ACTIVE release across the Jira fix version, origin, the PR (replaced), child PRs, the
 * local branch and the worktree. No state file and no rollback: a re-run re-reads git, GitHub and
 * Jira and converges.
 */
export const releaseRename = async (options: ReleaseRenameArgs) => {
  // Same guard order as `release remove`: a caller inside a linked worktree gets worktree advice first.
  await assertManagementContext({ operation: OPERATION })

  const config = await getInfraKitConfig()

  await refuseMissingRenameArguments(options)

  try {
    return await renameRelease(options, config)
  } catch (error) {
    if (isPromptCancellation(error) || isCommandDeclined(error)) throw error
    if (error instanceof OperationError) throw error

    logger.error({ err: formatZxError(error) }, '❌ Error renaming release')
    throw new OperationError(error, {
      operation: OPERATION,
      remediation: 'check `gh auth status`, `git worktree list` and the Jira credentials, then re-run',
    })
  }
}

export const releaseRenameMcpTool = defineMcpTool({
  name: 'release-rename',
  description:
    'Rename ONE active release from <old> to <new> everywhere its name lives: the Jira fix version (same id, new name), origin (release/<new> pushed at release/<old>\'s tip, release/<old> deleted only when contained in release/<new>), the PR (a new PR from release/<new> with the old base, body, labels, assignees, milestone and draft flag; the old PR closed with "Superseded by #<n>" — approvals and review requests stay on the old PR), open PRs based on release/<old> (retargeted), the local branch and the release worktree (moved; refused while dev servers run in it or the caller is inside it). Gated behind human confirmation. Omit "old" to be offered the open release PRs. Resumable with no rollback: a failed run reports every place renamed / not renamed, and re-running the same arguments converges.',
  requiresHumanConfirm: true,
  formProvider: releaseRenameForm,
  inputSchema: {
    old: z
      .string()
      .optional()
      .describe('The release to rename: a version (e.g. "1.2.5") or a name (e.g. "checkout-redesign").'),
    new: z
      .string()
      .optional()
      .describe('The new version or kebab-case name, validated like release create; "next" is refused.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved plan.'),
  },
  outputSchema: {
    old: z.string().describe('The old release label'),
    new: z.string().describe('The new release label'),
    oldBranch: z.string().describe('release/<old>'),
    newBranch: z.string().describe('release/<new>'),
    outcome: z
      .enum(['renamed', 'already-renamed'])
      .describe('"already-renamed" when every place already carried the new name'),
    renamedSteps: z.array(z.enum(STEP_ORDER)).describe('The steps this run performed, in order'),
    oldPrNumber: z.number().nullable().describe('The superseded PR'),
    newPrNumber: z.number().nullable().describe('The replacement PR'),
    worktreePath: z.string().nullable().describe('The worktree path under the new name, or null when there is none'),
    install: z.enum(['ok', 'failed', 'not-run']).describe('The pnpm install follow-up after a worktree move'),
    orcaReopened: z.boolean().describe('Whether Orca terminals were reopened in the moved worktree'),
    followUps: z
      .array(z.object({ label: z.string(), command: z.string() }))
      .describe('Outstanding follow-ups, each a command runnable as printed'),
  },
  handler: releaseRename,
})
