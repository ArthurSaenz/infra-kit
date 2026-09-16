import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
// Leaf module, not the `src/integrations/gh` barrel — and the same rule for the two freshly hoisted
// collaborators below. A hoisted helper's barrel now re-exports a module that imports ITS siblings
// from their leaves, so a partial `vi.mock` of the barrel intercepts nothing: the real
// `gh`/`git`/Jira call runs inside what is supposed to be a mocked test. Precedent and the fuller
// reasoning: `gh-release-deliver.ts:8-12`.
import { fetchPRByHead } from 'src/integrations/gh/pr-status'
import type { PRStatus } from 'src/integrations/gh/pr-status'
import { removeIdeWorktreeFolders } from 'src/integrations/ide'
import type { RemoveIdeWorktreeFoldersOutcome } from 'src/integrations/ide/types'
import { buildJiraVersionUrl, findVersionByName, loadJiraConfigOptional } from 'src/integrations/jira'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira'
import { getVersionRelatedIssueCounts, removeJiraVersion } from 'src/integrations/jira/remove-version'
import { listOrcaTerminals, orcaCallerInsideTargets } from 'src/integrations/orca'
import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { isCommandDeclined } from 'src/lib/errors/command-declined-error'
import { formatZxError } from 'src/lib/errors/format-zx-error'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import type { OperationErrorContext } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertBaseBranchSwitchable, assertManagementContext } from 'src/lib/git-guard'
import {
  branchExists,
  deleteLocalBranch,
  deleteRemoteBranch,
  getCurrentBranch,
  getCurrentWorktrees,
  getProjectRoot,
  lsRemoteHead,
  revParseVerify,
} from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { refuseMissingArguments } from 'src/lib/prompts/refuse-missing-arguments'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import { createReleaseRemoveFormProvider } from 'src/lib/release-remove-form'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getBaseBranch,
  getJiraDescriptions,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import { removeReleaseWorktreeIfPresent } from 'src/lib/worktrees/remove-release-worktree'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

export interface ReleaseRemoveArgs extends RequiredConfirmedOptionArg {
  version?: string
  moveIssuesTo?: string
  skipJira?: boolean
}

/** Step ids in execution order — also the vocabulary of the residue report. */
type RemovalStep = 'worktree' | 'ide-folders' | 'pr' | 'local-branch' | 'remote-branch' | 'jira'

/**
 * Ordered by ASCENDING irreversibility, so an abort leaves the most repairable residue: a worktree is
 * recreated by `worktrees add`, a closed PR is reopened in the UI, a branch is restored from the tip
 * sha captured in preflight — while the Jira fix version, once removed, is gone with its issue links.
 */
const STEP_ORDER: RemovalStep[] = ['worktree', 'ide-folders', 'pr', 'local-branch', 'remote-branch', 'jira']

const STEP_LABELS: Record<RemovalStep, string> = {
  worktree: 'remove the worktree',
  'ide-folders': 'strip the worktree from configured editors',
  pr: 'close the PR',
  'local-branch': 'delete the local branch',
  'remote-branch': 'delete the remote branch',
  jira: 'remove the Jira fix version',
}

interface DoneStep {
  step: RemovalStep
  /** Rendered in parentheses after the step id in the residue report, when the step has one. */
  detail?: string
}

interface JiraPlan {
  version: JiraVersion
  fixCount: number
  affectsCount: number
  url: string
}

interface ReleaseRemovePlan {
  branch: string
  id: ReleaseId
  label: string
  baseBranch: string
  projectRoot: string
  worktreeDir: string
  worktreePath: string
  /** Every release worktree, needed by `removeIdeWorktreeFolders` to compute the remaining set. */
  currentWorktrees: string[]
  worktreePresent: boolean
  /** Connected Orca terminals in the worktree; the removal closes them. Informational only. */
  orcaTerminalCount: number
  /** Porcelain paths inside the worktree, when one exists. */
  worktreeDirty: string[] | null
  /**
   * Captured HERE, not parsed from `git branch -D`'s `(was <sha>)` line: `deleteLocalBranch` discards
   * that output, it is a localizable porcelain string, and on a resume run the branch is already gone
   * so there is no delete output to read at all. After steps 4-5 this is the only handle that
   * restores the branch.
   */
  localTipSha: string | null
  remoteTipSha: string | null
  pr: PRStatus | null
  jira: JiraPlan | null
  jiraConfig: JiraConfig | null
  moveIssuesTo: JiraVersion | null
}

type IdeStepOutcome = 'verified' | 'attempted' | 'skipped'

interface IdeProviderReport {
  provider: string
  outcome: IdeStepOutcome
  removed: string[]
}

interface IdeFoldersReport {
  outcome: IdeStepOutcome
  providers: IdeProviderReport[]
}

interface ReleaseRemoveStructured {
  branch: string
  version: string
  baseBranch: string
  worktree: 'removed' | 'absent'
  ideFolders: IdeFoldersReport
  pr: 'closed' | 'already-closed' | 'absent'
  prNumber: number | null
  localBranch: 'deleted' | 'absent'
  localTipSha: string | null
  remoteBranch: 'deleted' | 'absent'
  remoteTipSha: string | null
  jira: 'removed' | 'absent' | 'skipped'
  jiraVersion: { id: string; name: string; url: string } | null
}

const OPERATION = 'remove a release'

/**
 * Log-then-throw for every preflight refusal.
 *
 * `warn`, not `error`: a refused removal is the command doing its job, and the operator still needs
 * the reason in the log when the thrown message is later summarised by an agent. The DECLINE is
 * deliberately not routed through here — it is not a guard, and `entry/cli.ts` renders it at `error`
 * with exit 1, which is exactly what an operator scripting `release remove && …` needs.
 */
// The explicit annotation on the CONST, not merely on the arrow, is what makes TypeScript treat a
// call to this as terminating control flow — without it every `refuse(...)` guard would leave the
// value it just rejected still nullable at the call site.
const refuse: (context: OperationErrorContext) => never = (context) => {
  logger.warn({ operation: context.operation }, `⛔ ${context.stderrExcerpt ?? context.operation}`)

  throw new OperationError(undefined, context)
}

/**
 * Over MCP a refusal may name a CLI flag or command ONLY as an "ask a human to run … from a
 * configured shell" hand-off, never as an action for the caller: the agent cannot pass the flag, so
 * a remediation that tells it to is a refusal with no exit. Every MCP-readable text below forks here.
 *
 * Keyed on the SOURCE, not on `isAgentMode()`: a Bash-driven agent (`--agent`, env) can pass every
 * flag the CLI text names, so it reads the CLI spelling — the guards keep firing for it, only the
 * wording changes.
 */
const mcpOrCli = (mcp: string, cli: string): string => {
  return agentMode.source === 'mcp' ? mcp : cli
}

/**
 * Over MCP `version` comes from the argument form; this is the fallback for a call that reached the
 * handler without one (form-less client, empty or failed enumeration, a gate confirmed with none).
 *
 * Of the two Jira flags, `skipJira` is refused and `moveIssuesTo` is accepted, and the line between
 * them is what the RESULT would say. With `skipJira` the preflight loads nothing, so the result
 * carries `jiraVersion: null` — a live fix version torn loose from its branch and PR with nothing in
 * the result pointing at it, the mess this command exists to prevent; its two legitimate uses
 * (unconfigured Jira, "leave the version") are both shell affairs. `moveIssuesTo` is the exit the
 * count guard names, and that guard fires over MCP now that the delete runs there. Applied to the
 * shared handler, not only the tool schema, so a direct call cannot slip past it. No-op on the CLI.
 */
// Structured, not `refuse()`: these two fire only for an agent, and an agent reads the payload —
// `argument_required` says "re-run with --version", `refused` says "this door is closed here". Both
// are logged the way `refuse()` logs, for the same operator-in-the-log reason.
const refuseAgentInput = (
  structuredContent: { status: 'argument_required'; argument: string } | { status: 'refused' },
  context: OperationErrorContext,
): never => {
  logger.warn({ operation: context.operation }, `⛔ ${context.stderrExcerpt ?? context.operation}`)

  throw new StructuredRefusalError({ ...structuredContent, agentMode: agentMode.source }, 2, context)
}

const assertMcpRemoveInput = (args: ReleaseRemoveArgs): void => {
  if (!isAgentMode()) return

  if (!args.version) {
    refuseAgentInput(
      { status: 'argument_required', argument: 'version' },
      {
        operation: OPERATION,
        remediation: mcpOrCli(
          'pass "version" (a release version or name). When "version" is omitted this server offers the open release PRs as a form; you reached this refusal instead because the client cannot render forms, there are no open release PRs, the enumeration failed or timed out (the server log names which), or a gate with no "version" was confirmed',
          'pass --version <ref> (a release version or name) on the re-run — `infra-kit release list --json` lists the candidates',
        ),
        stderrExcerpt: mcpOrCli(
          'release-remove reached the handler without "version"',
          'release remove reached the handler without --version under agent mode',
        ),
      },
    )
  }

  if (args.skipJira) {
    refuseAgentInput(
      { status: 'refused' },
      {
        operation: OPERATION,
        remediation: mcpOrCli(
          'omit skipJira — over MCP the fix version is checked and removed with the release; to keep it, do not remove the release from here, or ask a human to run infra-kit release remove --skip-jira from a configured shell',
          'drop --skip-jira — under agent mode the fix version is checked and removed with the release; to keep it, ask a human to run `infra-kit release remove --skip-jira` from their own terminal',
        ),
        stderrExcerpt: mcpOrCli(
          'skipJira is not permitted over MCP: it would tear down the branch and PR and leave a live Jira fix version behind with nothing in the result pointing at it',
          '--skip-jira is not permitted under agent mode: it would tear down the branch and PR and leave a live Jira fix version behind with nothing in the result pointing at it',
        ),
      },
    )
  }
}

/** D3: a merged release has shipped, so its branch records the merge and its fix version is delivered work. */
const assertNotMerged = (plan: ReleaseRemovePlan): void => {
  if (plan.pr?.state !== 'MERGED') return

  refuse({
    operation: `remove release ${plan.label}`,
    remediation: `this release has shipped — removing it would delete the branch recording the merge and strip its Jira fix version from delivered work. To undo a delivery, revert the merge commit on ${plan.baseBranch} and cut a new release.`,
    stderrExcerpt: `PR #${plan.pr.number} for ${plan.branch} is MERGED`,
  })
}

/**
 * D2b/D2c/D2d. Three independent refusals, deliberately not collapsed into one `--force`: a hotfix
 * delivered while Jira was down has an unreleased version with a merged PR, and a version released by
 * hand in the UI has no merged PR, so either guard alone is dodgeable.
 */
const assertJiraRemovable = (plan: ReleaseRemovePlan, args: ReleaseRemoveArgs): void => {
  // `--skip-jira` queried Jira for nothing — no config load, no version lookup, no counts — so there
  // is no state here to check, and the delete it would guard cannot happen. Querying anyway would
  // break the flag's primary use, which D2d defines as the unconfigured environment where the query
  // itself fails. It follows that D2c is unenforceable on this path by construction, not by choice.
  if (args.skipJira) return

  if (!plan.jiraConfig) {
    // The remediation forks because `--skip-jira` is NOT an exit over MCP: `assertMcpRemoveInput`
    // refuses that flag a few lines above, so naming it here would send an agent round a loop —
    // "pass --skip-jira" → "skipJira is not permitted over MCP" — with no way out, the shape
    // `mcpOrCli` exists to rule out. Jira config is read from
    // `process.env`, which over MCP is the session's `env-load` file as re-applied at this call's
    // entry — so the exit an agent has is to load a config that carries the four names and re-call.
    refuse({
      operation: `remove release ${plan.label}`,
      remediation: mcpOrCli(
        'call `env-load` for a config that carries JIRA_BASE_URL / JIRA_TOKEN / JIRA_PROJECT_ID / JIRA_EMAIL, then re-call; or ask a human to run `infra-kit release remove --skip-jira` from a configured shell',
        'set JIRA_BASE_URL / JIRA_TOKEN / JIRA_PROJECT_ID / JIRA_EMAIL, or pass --skip-jira to tear down the branch and PR and leave any fix version alone',
      ),
      stderrExcerpt: 'Jira is not configured, so a fix version for this release cannot be checked or removed',
    })
  }

  if (!plan.jira) return

  const { version, fixCount, affectsCount } = plan.jira

  // D2c: a released or archived version means the release has shipped and is history rather than
  // scaffolding — the same class of signal as the MERGED PR guard — so it refuses the whole teardown.
  if (version.released || version.archived) {
    refuse({
      operation: `remove Jira fix version "${version.name}"`,
      remediation: mcpOrCli(
        'un-release it in Jira first; or, to tear down the branch and PR and leave the fix version alone, ask a human to run infra-kit release remove --skip-jira from a configured shell',
        'un-release it in Jira first, or remove the release without it via --skip-jira',
      ),
      stderrExcerpt: `fix version "${version.name}" is already ${version.released ? 'released' : 'archived'}`,
    })
  }

  if (fixCount === 0 && affectsCount === 0) return
  if (plan.moveIssuesTo) return

  // The two counts are never summed: they count two different fields and one issue can carry the
  // version in both, so their sum is an upper bound on distinct issues rather than a total.
  refuse({
    operation: `remove Jira fix version "${version.name}"`,
    remediation: mcpOrCli(
      'deleting it would clear both fields on those issues with no way to restore them — re-call with "moveIssuesTo": "<existing fix version name>" to reassign both, or clear the version from the issues in Jira first',
      'deleting it would clear both fields on those issues with no way to restore them — pass --move-issues-to <version> to reassign both, or clear the version from the issues in Jira first',
    ),
    stderrExcerpt: `${version.name} is set as fixVersion on ${fixCount} issue(s) and as affectsVersion on ${affectsCount} issue(s)`,
  })
}

/**
 * D4's terminal predicate, and the reason this command applies NO target validation to `--version`.
 *
 * Validating the target against discovered worktrees or open PRs — what `worktrees-remove`'s
 * `assertTargetsExist` does — would refuse every resume run, because by the second run the worktree
 * is gone by design and the PR is closed. The typo is caught here instead, at the only point where
 * "this release never existed" and "this release is already torn down" are distinguishable: a
 * release THIS command removed keeps a CLOSED PR forever, so the PR conjunct never fires for it.
 */
const assertSomethingExists = (plan: ReleaseRemovePlan): void => {
  const found =
    plan.worktreePresent || plan.pr !== null || plan.localTipSha !== null || plan.remoteTipSha !== null || plan.jira

  if (found) return

  const listing = mcpOrCli('the gh-release-list tool (open PRs only) or worktrees-list', '`infra-kit release list`')

  refuse({
    operation: `remove release ${plan.label}`,
    remediation: `nothing named "${plan.label}" exists to remove — check the spelling against ${listing}. (A release this command already removed keeps a CLOSED PR, so a genuine re-run is not affected.)`,
    stderrExcerpt: 'found no worktree, no PR (any state), no local or remote branch, and no Jira fix version',
  })
}

/**
 * The one detectable failure preflight would otherwise not precede: `removeOne` runs a bare
 * `git worktree remove` and git refuses on modified or untracked files, while `assertCleanCheckout`
 * reads the MAIN checkout's status and cannot see inside a linked worktree.
 */
const assertWorktreeClean = (plan: ReleaseRemovePlan): void => {
  if (!plan.worktreeDirty || plan.worktreeDirty.length === 0) return

  refuse({
    operation: `remove release ${plan.label}`,
    remediation: `commit or discard those changes (\`git -C ${plan.worktreePath} stash -u\`), then re-run`,
    stderrExcerpt: `the worktree at ${plan.worktreePath} has uncommitted changes: ${plan.worktreeDirty.slice(0, 4).join(', ')}`,
  })
}

const probeWorktreeDirty = async (worktreePath: string): Promise<string[]> => {
  const result = await $`git -C ${worktreePath} status --porcelain`

  return result.stdout
    .split('\n')
    .map((line) => {
      return line.trimEnd()
    })
    .filter((line) => {
      return line.length > 0
    })
}

/** Best-effort, and only informational: it exists so the confirm text can warn that terminals will close. */
const probeOrcaTerminals = async (worktreePath: string): Promise<number> => {
  try {
    const { terminals } = await listOrcaTerminals(worktreePath)

    return terminals.filter((terminal) => {
      return terminal.connected
    }).length
  } catch (error) {
    logger.debug({ error, worktreePath }, 'release remove: orca terminal probe failed')

    return 0
  }
}

/**
 * The removal closes every Orca terminal of the worktree — including the one running this command,
 * if it sits inside it. Env-keyed (`ORCA_WORKTREE_ID`), complementary to the cwd-keyed
 * `assertManagementContext`: `cd` / `-C` change the cwd, never the terminal's identity, so the only
 * remediation is another terminal.
 */
const assertCallerOutsideOrcaWorktree = async (worktreePath: string): Promise<void> => {
  const inside = await orcaCallerInsideTargets([worktreePath])

  if (inside === null) return

  logger.warn({ operation: OPERATION }, `⛔ this command runs inside an Orca terminal of ${inside}`)

  throw new StructuredRefusalError(
    { status: 'refused', reason: 'orca_caller_inside_target', agentMode: agentMode.source },
    2,
    {
      operation: OPERATION,
      remediation: `re-run from a terminal that is not an Orca pane of ${inside} (a non-Orca terminal, or another worktree's row)`,
      stderrExcerpt: `this command runs inside an Orca terminal of ${inside}, which the removal would close`,
    },
  )
}

interface JiraPreflight {
  jiraConfig: JiraConfig | null
  jira: JiraPlan | null
  moveIssuesTo: JiraVersion | null
}

/** `--move-issues-to` is resolved HERE so a typo'd target fails before any mutation, not at step 6. */
const buildJiraPreflight = async (id: ReleaseId, args: ReleaseRemoveArgs): Promise<JiraPreflight> => {
  const empty: JiraPreflight = { jiraConfig: null, jira: null, moveIssuesTo: null }

  if (args.skipJira) return empty

  const jiraConfig = await loadJiraConfigOptional()

  if (!jiraConfig) return empty

  const version = await findVersionByName(formatJiraName(id), jiraConfig)
  const moveIssuesTo = args.moveIssuesTo ? await resolveMoveTarget(args.moveIssuesTo, jiraConfig) : null

  if (!version) return { jiraConfig, jira: null, moveIssuesTo }

  const counts = await getVersionRelatedIssueCounts(version.id, jiraConfig)

  return {
    jiraConfig,
    moveIssuesTo,
    jira: {
      version,
      fixCount: counts.issuesFixedCount,
      affectsCount: counts.issuesAffectedCount,
      url: buildJiraVersionUrl(jiraConfig, version),
    },
  }
}

const resolveMoveTarget = async (name: string, config: JiraConfig): Promise<JiraVersion> => {
  const target = await findVersionByName(name, config)

  if (target) return target

  return refuse({
    operation: `reassign issues to Jira fix version "${name}"`,
    remediation: 'name an existing fix version exactly as it appears in Jira (e.g. "v1.2.6")',
    stderrExcerpt: `no Jira fix version named "${name}"`,
  })
}

const buildPlan = async (branch: string, args: ReleaseRemoveArgs): Promise<ReleaseRemovePlan> => {
  const id = parseBranchName(branch)

  if (!id) {
    refuse({
      operation: `remove release ${branch}`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
      stderrExcerpt: `"${branch}" is not a release branch`,
    })
  }

  const projectRoot = await getProjectRoot()
  const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
  const worktreePath = `${worktreeDir}/${branch}`

  const [currentWorktrees, pr, localTipSha, remoteTipSha] = await Promise.all([
    getCurrentWorktrees('release'),
    fetchPRByHead(branch),
    revParseVerify(projectRoot, `refs/heads/${branch}`),
    lsRemoteHead(projectRoot, branch),
  ])

  const worktreePresent = currentWorktrees.includes(branch)

  if (worktreePresent) await assertCallerOutsideOrcaWorktree(worktreePath)

  const jiraPreflight = await buildJiraPreflight(id, args)

  return {
    ...jiraPreflight,
    branch,
    id,
    label: displayLabel(id),
    // A release with no PR falls to `dev`: `detectReleaseType` reads "hotfix" off the PR title and
    // returns 'regular' for everything else, which is the derivation `release create` used.
    baseBranch: getBaseBranch(detectReleaseType(pr?.title ?? '')),
    projectRoot,
    worktreeDir,
    worktreePath,
    currentWorktrees,
    worktreePresent,
    orcaTerminalCount: worktreePresent ? await probeOrcaTerminals(worktreePath) : 0,
    worktreeDirty: worktreePresent ? await probeWorktreeDirty(worktreePath) : null,
    localTipSha,
    remoteTipSha,
    pr,
  }
}

/** Projection for `logger.debug`: the plan carries live Jira credentials, which must never reach a log. */
const describePlan = (plan: ReleaseRemovePlan): Record<string, unknown> => {
  return {
    branch: plan.branch,
    label: plan.label,
    baseBranch: plan.baseBranch,
    worktreePath: plan.worktreePath,
    worktreePresent: plan.worktreePresent,
    worktreeDirty: plan.worktreeDirty,
    orcaTerminalCount: plan.orcaTerminalCount,
    localTipSha: plan.localTipSha,
    remoteTipSha: plan.remoteTipSha,
    pr: plan.pr,
    jiraConfigured: plan.jiraConfig !== null,
    jiraVersion: plan.jira ? { id: plan.jira.version.id, name: plan.jira.version.name } : null,
    jiraFixCount: plan.jira?.fixCount ?? null,
    jiraAffectsCount: plan.jira?.affectsCount ?? null,
    moveIssuesTo: plan.moveIssuesTo ? { id: plan.moveIssuesTo.id, name: plan.moveIssuesTo.name } : null,
  }
}

// Keyed on the FLAG, not on `jiraConfig === null`. Those coincide only because `assertJiraRemovable`
// refuses an unconfigured Jira before the confirm is ever rendered; derive the label from the absent
// config and the day that refusal is relaxed the confirm text starts attributing a flag the operator
// never passed — and no test can catch it, because the wrong-label case is unreachable until then.
const describeJiraLine = (plan: ReleaseRemovePlan, skipJira: boolean): string => {
  if (skipJira) return 'skipped (--skip-jira)'
  if (!plan.jiraConfig) return 'skipped (Jira not configured)'
  if (!plan.jira) return 'none found'

  const { version, fixCount, affectsCount } = plan.jira
  const attached = `fixVersion on ${fixCount} issue(s), affectsVersion on ${affectsCount} issue(s)`
  const move = plan.moveIssuesTo ? `, reassigned to ${plan.moveIssuesTo.name}` : ''

  return `${version.name} — ${attached}${move}`
}

/**
 * The full inventory, because this is where the operator consents to the one unrecoverable act. It is
 * also why the design needs no separate dry-run mode: everything a plan preview would print is here.
 */
const buildConfirmMessage = (plan: ReleaseRemovePlan, skipJira: boolean): string => {
  const prLine = plan.pr ? `#${plan.pr.number} (${plan.pr.state})` : 'none'

  const lines = [
    `Remove release ${plan.label} (${plan.branch})? This will:`,
    `  • worktree:      ${plan.worktreePresent ? plan.worktreePath : 'none'}`,
    `  • PR:            ${prLine}`,
    `  • local branch:  ${plan.localTipSha ?? 'absent'} (switching to ${plan.baseBranch} first)`,
    `  • remote branch: ${plan.remoteTipSha ?? 'absent'}`,
    `  • Jira version:  ${describeJiraLine(plan, skipJira)}`,
  ]

  if (plan.orcaTerminalCount > 0) {
    lines.push(`  • ${plan.orcaTerminalCount} Orca terminal(s) in ${plan.worktreePath} will be closed`)
  }

  return lines.join('\n')
}

/**
 * Tags a step failure with its step id so the handler — which holds the plan and the completed-step
 * list the residue report needs — can build the report without every step function knowing about it.
 */
class StepFailure extends Error {
  constructor(
    readonly step: RemovalStep,
    readonly reason: unknown,
  ) {
    super(`step ${step} failed`, { cause: reason })
    this.name = 'StepFailure'
  }
}

/**
 * The reportable outcome of a step result, for the log line.
 *
 * Steps return either a bare enum (`'deleted'`, `'absent'`, `'skipped'`) or a record carrying one under
 * `outcome` (the PR step, which also reports its number), so both shapes are read here rather than
 * making every step return a uniform envelope for the sake of one log line.
 */
/**
 * Every step reports either a bare enum or a record carrying one. Constraining `runStep` to this union
 * rather than reading `unknown` at runtime is what makes an unreportable step a COMPILE error: the
 * alternative had a `'done'` fallback that was unreachable today and could only ever fire on a future
 * step, quietly reintroducing the uninformative label this exists to remove.
 */
type StepResult = string | { outcome: string }

const outcomeOf = (result: StepResult): string => {
  return typeof result === 'string' ? result : result.outcome
}

/** Abort on failure. Continuing past an unseen failure can reach the unrecoverable step on a state nobody inspected. */
// A `function` declaration, not the file's usual `const` arrow, and deliberately. The MCP
// prompt-reachability sweep parses every source with `ScriptKind.TSX`
// (lib/prompts/__tests__/mcp-reachable-prompt-sites.ts:61), where the `<T>` of a generic ARROW opens a
// JSX tag: the file then fails to parse, contributes no modules to the graph, and is silently exempted
// from the Esc contract. `<T,>` fixes the parse but prettier strips the comma straight back out, so the
// declaration form is the only stable shape. The fail-open is invisible for a non-root module — ten
// existing files hit it today — but an exposed tool is a graph ROOT, so here it surfaces as a failure.
async function runStep<T extends StepResult>(step: RemovalStep, done: DoneStep[], fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn()
    const outcome = outcomeOf(result)

    done.push({ step })

    // The OUTCOME, not merely the label. §5.5 wants a partial run reconstructable from the log alone,
    // and most steps legitimately do nothing: on a resume every one of them is a no-op, and with
    // `--skip-jira` the Jira step touches nothing. A bare `✅ remove the Jira fix version` in those
    // cases reports a mutation that did not happen — the same class of lie the post-delete
    // `branchExists` check exists to prevent, moved onto the log surface.
    logger.info({ step, outcome }, `✅ ${STEP_LABELS[step]} — ${outcome}`)

    return result
  } catch (error) {
    throw new StepFailure(step, error)
  }
}

/**
 * The single exemption from abort-on-first-error, and it is safe only because step 2 carries no state
 * into steps 3-6: a cosmetic editor edit must not strand a teardown with the worktree gone, the PR
 * open, the branch live and the fix version live.
 */
// No success log here, deliberately: `tryStep`'s callback returns void, so this function cannot tell a
// real editor edit from a no-op — and `ide-folders` is the step with the MOST to lie about, since an
// empty `removed` array is evidence of nothing (`describeIdeProvider`). The caller owns the success
// line because only it holds the computed outcome. The failure path stays here: `attempted` is exactly
// what this level knows.
const tryStep = async (step: RemovalStep, done: DoneStep[], fn: () => Promise<void>): Promise<void> => {
  try {
    await fn()
    done.push({ step })
  } catch (error) {
    done.push({ step, detail: 'attempted' })
    logger.warn({ err: formatZxError(error), step }, `⚠️ ${STEP_LABELS[step]} failed (non-blocking)`)
  }
}

const describeDoneStep = (plan: ReleaseRemovePlan, entry: DoneStep): string => {
  if (entry.step === 'local-branch' && plan.localTipSha) return `local-branch (was ${plan.localTipSha.slice(0, 7)})`

  return entry.detail ? `${entry.step} (${entry.detail})` : entry.step
}

interface ResidueErrorArgs {
  plan: ReleaseRemovePlan
  step: RemovalStep
  done: DoneStep[]
  cause: unknown
}

const buildResidueError = (args: ResidueErrorArgs): OperationError => {
  const { plan, step, done, cause } = args

  const completed =
    done
      .map((entry) => {
        return describeDoneStep(plan, entry)
      })
      .join(', ') || 'nothing'

  const jiraNote = plan.jira ? `The Jira fix version ${plan.jira.version.name} was NOT removed. ` : ''
  const restore = plan.localTipSha ? `Restore the branch with \`git branch ${plan.branch} ${plan.localTipSha}\`. ` : ''
  // Appended to EVERY step failure, so it is the sentence an MCP caller reads most; a CLI command
  // here would contradict the refusal half that precedes it on the re-probe paths.
  const rerun = mcpOrCli(
    `Re-call release-remove with "version": "${plan.label}" to finish; completed steps are skipped.`,
    `Re-run \`infra-kit release remove --version ${plan.label}\` to finish; completed steps are skipped.`,
  )
  const residue = `completed: ${completed}. ${jiraNote}${restore}${rerun}`

  // A step can end in a REFUSAL as well as a failure — the mid-flight PR and issue-count re-probes
  // both throw one — and a refusal's own remediation is the actionable half (it says what to do
  // about a merged PR, or about counts that moved). `buildMessage` renders only `remediation`, so
  // prepending it is what keeps that text from being swallowed by the residue report.
  const refusal = cause instanceof OperationError ? cause.remediation : undefined

  return new OperationError(cause, {
    operation: `remove release ${plan.label} — step ${STEP_ORDER.indexOf(step) + 1} of ${STEP_ORDER.length} (${STEP_LABELS[step]})`,
    remediation: refusal ? `${refusal} — ${residue}` : residue,
  })
}

interface WorktreeStepResult {
  outcome: 'removed' | 'absent'
  removedBranches: string[]
}

const removeWorktreeStep = async (plan: ReleaseRemovePlan): Promise<WorktreeStepResult> => {
  const removed = await removeReleaseWorktreeIfPresent(plan.branch, {
    operation: `remove the worktree for ${plan.branch}`,
    // Deliberately NOT a `--force` suggestion: `worktrees remove` runs bare on purpose, and handing a
    // teardown operator that escape would undo the policy through a shared string.
    remediation: `commit or discard the changes inside ${plan.worktreePath} (\`git -C ${plan.worktreePath} stash -u\`), then re-run`,
  })

  // Reported from what the helper actually removed rather than from the preflight flag: "absent" here
  // means the worktree was already gone, since a genuine refusal throws rather than returning.
  return { outcome: removed.includes(plan.branch) ? 'removed' : 'absent', removedBranches: removed }
}

const summariseIdeOutcomes = (outcomes: RemoveIdeWorktreeFoldersOutcome[]): IdeFoldersReport => {
  const providers = outcomes.map((outcome) => {
    return { provider: outcome.provider, outcome: describeIdeProvider(outcome), removed: outcome.removed }
  })

  const verified = providers.some((entry) => {
    return entry.outcome === 'verified'
  })

  const attempted = providers.some((entry) => {
    return entry.outcome === 'attempted'
  })

  const outcome: IdeStepOutcome = attempted ? 'attempted' : 'skipped'

  return { outcome: verified ? 'verified' : outcome, providers }
}

/**
 * Zed is a declared skip on every path — `allowEditorRelaunch: false` means `removeFromZed` returns
 * before touching anything. Cursor is `verified` only with a non-empty `removed`, because an empty
 * array arrives from three different paths including a CAUGHT write failure, so it is evidence of
 * nothing.
 */
const describeIdeProvider = (outcome: RemoveIdeWorktreeFoldersOutcome): IdeStepOutcome => {
  if (outcome.provider === 'zed') return 'skipped'

  return outcome.removed.length > 0 ? 'verified' : 'attempted'
}

const runIdeFoldersStep = async (
  plan: ReleaseRemovePlan,
  removedWorktrees: string[],
  done: DoneStep[],
): Promise<IdeFoldersReport> => {
  let report: IdeFoldersReport = { outcome: 'attempted', providers: [] }

  await tryStep('ide-folders', done, async () => {
    const outcomes = await removeIdeWorktreeFolders({
      projectRoot: plan.projectRoot,
      worktreeDir: plan.worktreeDir,
      currentWorktrees: plan.currentWorktrees,
      removedWorktrees,
      // `false` ALWAYS, never `!confirmedCommand`. `zed --reuse` replaces the focused window's whole
      // folder set and silently drops folders opened for unrelated work, and it reports no diff — so
      // on the `--yes` path `!confirmedCommand` would make this leg a guaranteed no-op reported as
      // success, and on the interactive path it would destroy state nobody consented to losing.
      // Cursor never reads the flag, so it still does its surgical, verifiable work either way.
      allowEditorRelaunch: false,
    })

    report = summariseIdeOutcomes(outcomes)
  })

  // Logged HERE rather than inside `tryStep`, which cannot see this: `skipped` and `verified` are the
  // difference between "nothing was open to change" and "a Cursor workspace was rewritten", and the
  // bare label rendered both identically — the same lie as an unverified branch delete.
  logger.info({ outcome: report.outcome, step: 'ide-folders' }, `✅ ${STEP_LABELS['ide-folders']} — ${report.outcome}`)

  return report
}

interface PrStepResult {
  outcome: 'closed' | 'already-closed' | 'absent'
  number: number | null
}

const closePrStep = async (plan: ReleaseRemovePlan): Promise<PrStepResult> => {
  // Re-probe: preflight's answer is separated from this call by an interactive confirm of unbounded
  // duration. A PR merged in that window would otherwise fail here as an opaque `gh pr close` error,
  // after the worktree is already gone.
  const current = await fetchPRByHead(plan.branch)

  assertNotMerged({ ...plan, pr: current })

  if (!current) return { outcome: 'absent', number: null }
  if (current.state === 'CLOSED') return { outcome: 'already-closed', number: current.number }

  // Closed explicitly rather than as a side effect of deleting the head branch: an inferred close
  // carries no explanation, and `--delete-branch` would also delete the local branch, which fails
  // while a worktree holds it.
  const comment = `Closed by \`infra-kit release remove\`: release ${plan.label} was torn down.`

  await $`gh pr close ${String(current.number)} --comment ${comment}`

  return { outcome: 'closed', number: current.number }
}

const deleteLocalBranchStep = async (plan: ReleaseRemovePlan): Promise<'deleted' | 'absent'> => {
  // `deleteLocalBranch` silently no-ops on the current branch, so the switch has to come first or the
  // command reports a deletion it never performed.
  if ((await getCurrentBranch()) === plan.branch) {
    await $`git switch ${plan.baseBranch}`
  }

  await deleteLocalBranch(plan.branch)

  // ...and the delete is checked rather than assumed, which converts that fail-open into a fail-closed.
  if (await branchExists(plan.branch)) {
    return refuse({
      operation: `delete local branch ${plan.branch}`,
      remediation: `delete it by hand with \`git branch -D ${plan.branch}\`, then re-run to finish the removal`,
      stderrExcerpt: `${plan.branch} still exists after the delete`,
    })
  }

  return plan.localTipSha ? 'deleted' : 'absent'
}

const deleteRemoteBranchStep = async (plan: ReleaseRemovePlan): Promise<'deleted' | 'absent'> => {
  await deleteRemoteBranch(plan.branch)

  return plan.remoteTipSha ? 'deleted' : 'absent'
}

/**
 * The preflight guard passed before the confirm and five mutations across two remote systems. A
 * teammate attaching a ticket to this fix version in that window — the ordinary workflow of a team
 * filing against an open release — would otherwise be overwritten by a guard that is already stale.
 * Unchanged counts proceed silently; a change aborts BEFORE the one call that cannot be undone.
 */
const assertIssueCountsUnchanged = async (
  plan: ReleaseRemovePlan,
  jira: JiraPlan,
  config: JiraConfig,
): Promise<void> => {
  const counts = await getVersionRelatedIssueCounts(jira.version.id, config)

  if (counts.issuesFixedCount === jira.fixCount && counts.issuesAffectedCount === jira.affectsCount) return

  const rerun = mcpOrCli(
    `re-call release-remove with "version": "${plan.label}"`,
    `re-run \`infra-kit release remove --version ${plan.label}\``,
  )

  refuse({
    operation: `remove Jira fix version "${jira.version.name}"`,
    remediation: `the fix version was NOT removed and every other step is complete — ${rerun} so the guard re-evaluates the new counts`,
    stderrExcerpt: `issue counts changed since preflight: fixVersion ${jira.fixCount} → ${counts.issuesFixedCount}, affectsVersion ${jira.affectsCount} → ${counts.issuesAffectedCount}`,
  })
}

const removeJiraStep = async (
  plan: ReleaseRemovePlan,
  args: ReleaseRemoveArgs,
): Promise<ReleaseRemoveStructured['jira']> => {
  if (args.skipJira) return 'skipped'
  if (!plan.jira || !plan.jiraConfig) return 'absent'

  await assertIssueCountsUnchanged(plan, plan.jira, plan.jiraConfig)

  // Logged BEFORE the delete: afterwards the id is the only handle that still exists, and it is what
  // an Atlassian support request needs.
  logger.info(
    { jiraVersionId: plan.jira.version.id, jiraVersionName: plan.jira.version.name },
    '🗑️ removing Jira fix version',
  )

  await removeJiraVersion(
    {
      versionId: plan.jira.version.id,
      // ONE flag, BOTH parameters: mapping it to `moveFixIssuesTo` alone would lose the affects links
      // through the very flag that exists to prevent data loss, and would leave a version with only
      // affects links permanently unremovable.
      moveFixIssuesTo: plan.moveIssuesTo?.id,
      moveAffectedIssuesTo: plan.moveIssuesTo?.id,
    },
    plan.jiraConfig,
  )

  return 'removed'
}

interface StepResults {
  worktree: WorktreeStepResult
  ideFolders: IdeFoldersReport
  pr: PrStepResult
  localBranch: 'deleted' | 'absent'
  remoteBranch: 'deleted' | 'absent'
  jira: ReleaseRemoveStructured['jira']
}

const buildResult = (plan: ReleaseRemovePlan, results: StepResults): ReleaseRemoveStructured => {
  return {
    branch: plan.branch,
    version: plan.label,
    baseBranch: plan.baseBranch,
    worktree: results.worktree.outcome,
    ideFolders: results.ideFolders,
    pr: results.pr.outcome,
    prNumber: results.pr.number,
    localBranch: results.localBranch,
    localTipSha: plan.localTipSha,
    remoteBranch: results.remoteBranch,
    remoteTipSha: plan.remoteTipSha,
    jira: results.jira,
    jiraVersion: plan.jira ? { id: plan.jira.version.id, name: plan.jira.version.name, url: plan.jira.url } : null,
  }
}

const runSteps = async (plan: ReleaseRemovePlan, args: ReleaseRemoveArgs, done: DoneStep[]): Promise<StepResults> => {
  const worktree = await runStep('worktree', done, () => {
    return removeWorktreeStep(plan)
  })

  const ideFolders = await runIdeFoldersStep(plan, worktree.removedBranches, done)

  const pr = await runStep('pr', done, () => {
    return closePrStep(plan)
  })

  // Both shas, before the two steps that make them the only remaining handle on the branch.
  logger.info(
    { branch: plan.branch, localTipSha: plan.localTipSha, remoteTipSha: plan.remoteTipSha },
    '🔖 branch tips before deletion',
  )

  const localBranch = await runStep('local-branch', done, () => {
    return deleteLocalBranchStep(plan)
  })

  const remoteBranch = await runStep('remote-branch', done, () => {
    return deleteRemoteBranchStep(plan)
  })

  const jira = await runStep('jira', done, () => {
    return removeJiraStep(plan, args)
  })

  return { worktree, ideFolders, pr, localBranch, remoteBranch, jira }
}

const executeRemoval = async (plan: ReleaseRemovePlan, args: ReleaseRemoveArgs): Promise<ReleaseRemoveStructured> => {
  const done: DoneStep[] = []

  try {
    return buildResult(plan, await runSteps(plan, args, done))
  } catch (error) {
    if (error instanceof StepFailure) throw buildResidueError({ plan, step: error.step, done, cause: error.reason })

    throw error
  }
}

/**
 * `assertInteractive`'s remediation is shared across four commands and names `--versions` and
 * `--all`, both of which this single-target command rejects as unknown flags — so its refusal is
 * re-thrown with a `--version`-only remediation rather than editing the shared helper.
 */
const resolveTargetBranch = async (version?: string): Promise<string> => {
  if (version) return resolveReleaseBranch(version)

  commandEcho.setInteractive()

  const [descriptions, prInfo] = await Promise.all([getJiraDescriptions(), getReleasePRsWithInfo()])

  const branches = prInfo.map((pr) => {
    return pr.branch
  })

  if (branches.length === 0) {
    refuse({
      operation: 'select a release to remove',
      remediation: 'pass `--version <ref>` to remove a release that is already partially torn down',
      stderrExcerpt: 'no open release PRs to pick from',
    })
  }

  const types = new Map(
    prInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)] as const
    }),
  )

  try {
    return await pickReleaseBranch(formatBranchPickerItems({ branches, descriptions, types }))
  } catch (error) {
    if (isPromptCancellation(error)) throw error

    throw new OperationError(error, {
      operation: 'select a release to remove',
      remediation: 'pass `--version <ref>` (e.g. `--version 1.2.5`); the picker needs an interactive terminal',
    })
  }
}

/**
 * Tear down one release: its worktree, editor entry, PR, both branches and its Jira fix version.
 *
 * Single-target by design (no `--versions`, no `--all`): nothing this removes is recreatable, and
 * multi-target would force continue-on-error semantics that destroy the residue report.
 */
// ONE provider instance for the MCP form and the agent-mode refusal, so an agent's `choices` are the
// form an MCP client would have been offered.
const releaseRemoveForm = createReleaseRemoveFormProvider()

export const releaseRemove = async (options: ReleaseRemoveArgs) => {
  const { confirmedCommand, version, moveIssuesTo, skipJira } = options

  // GUARD ORDER is load-bearing and mirrors `worktreesRemove`, whose own tests pin it.
  // First, so a caller standing inside the release's linked worktree gets worktree advice rather
  // than a config error.
  await assertManagementContext({ operation: OPERATION })

  // ABOVE the `try` whose catch rewraps: this throws a plain `Error` whose text `buildMessage` would
  // drop. BELOW the guard above: "not an infra-kit project" is the less fundamental failure.
  await getInfraKitConfig()

  // Before the MCP-worded guard: a Bash-driven agent (or `--json`) without `--version` is handed the
  // open release PRs as `choices` — the very form an MCP client is offered before the handler.
  await refuseMissingArguments({
    provider: releaseRemoveForm,
    params: options,
    operation: OPERATION,
    argument: 'version',
  })

  assertMcpRemoveInput(options)

  try {
    const plan = await buildPlan(await resolveTargetBranch(version), options)

    logger.debug({ plan: describePlan(plan) }, 'release remove: resolved plan')

    assertNotMerged(plan)
    assertJiraRemovable(plan, options)
    assertSomethingExists(plan)
    await assertBaseBranchSwitchable({ operation: `remove release ${plan.label}`, base: plan.baseBranch })
    assertWorktreeClean(plan)

    commandEcho.addOption('--version', plan.label)
    if (moveIssuesTo) commandEcho.addOption('--move-issues-to', moveIssuesTo)
    if (skipJira) commandEcho.addOption('--skip-jira', true)

    // `throwOnDecline` because the default `process.exit(0)` would make a decline indistinguishable
    // from a legitimate "already fully removed, every step skipped" success — and an operator
    // scripting `release remove && …` would proceed as though a release had been torn down.
    // It also makes the "acquire nothing before the confirm" ordering above load-bearing.
    //
    // `plan` is the same secret-free projection the debug line above logs: an agent refused here gets
    // the structured form of the confirm text, not prose to parse.
    await confirmOrExit(confirmedCommand, buildConfirmMessage(plan, Boolean(skipJira)), {
      throwOnDecline: true,
      plan: { ...describePlan(plan), skipJira: Boolean(skipJira) },
    })

    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const structuredContent = await executeRemoval(plan, options)

    commandEcho.print()

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  } catch (error) {
    // A cancelled prompt (Esc / Ctrl-C) is "I never answered" and exits 0 at the boundary; a decline
    // is "I answered, and the answer was no" and must reach `entry/cli.ts` intact to exit 1. Neither
    // is a failure, so neither gets the generic wrap.
    if (isPromptCancellation(error) || isCommandDeclined(error)) throw error

    // Guard refusals and residue reports already carry an actionable remediation.
    if (error instanceof OperationError) throw error

    logger.error({ err: formatZxError(error) }, '❌ Error removing release')
    throw new OperationError(error, {
      operation: OPERATION,
      remediation: 'check `gh auth status`, `git worktree list` and the Jira credentials, then re-run',
    })
  }
}

export const releaseRemoveMcpTool = defineMcpTool({
  name: 'release-remove',
  description:
    'Tear down ONE release created by release-create: removes its git worktree (closing every Orca terminal open in it first — a call made from an Orca terminal inside that worktree is refused as orca_caller_inside_target before anything is touched), strips the worktree from the Cursor workspace, closes its pull request with a comment, deletes the release branch locally and on origin, and REMOVES ITS JIRA FIX VERSION — the one irreversible step (new id, new URL, lost issue links), which is why every call is gated behind human confirmation. Omit "version" and this server offers the human a form listing the open release PRs; the accepted choice feeds the confirm gate. A client that cannot render a form gets a gate with no version — confirming it is refused, never guessed. Pass "version" when the human already named the release. One release per call — repeat the call for another; there is no "versions" field. Refuses before any mutation when the PR is MERGED (the release has shipped), when the fix version is released/archived, when the fix version still carries issues (pass "moveIssuesTo" to reassign them), or when nothing named that version exists. skipJira is CLI-only and has no field here: it would leave a live fix version behind with nothing in the result pointing at it. Resumable: every step is a verified no-op when its artefact is already gone, so a re-run finishes a partial teardown. What is lost with the worktree directory: gitignored contents including a hydrated .env of Doppler secrets (re-fetch with env-load) and node_modules/dist.',
  requiresHumanConfirm: true,
  formProvider: releaseRemoveForm,
  inputSchema: {
    version: z
      .string()
      .optional()
      .describe(
        'The release version or name to remove (e.g. "1.2.5" or "checkout-redesign"). Omit it to be offered the open release PRs.',
      ),
    moveIssuesTo: z
      .string()
      .optional()
      .describe(
        'Optional. An EXISTING Jira fix version name (exactly as in Jira, e.g. "v1.2.6") to move this release\'s issues to before its fix version is removed — both fixVersion and affectsVersion. Pass it only after a refusal reported the issue counts, or when the human named the target; a name Jira does not know is refused in preflight before anything is touched.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved action.'),
  },
  outputSchema: {
    branch: z.string().describe('The release branch that was targeted'),
    version: z.string().describe('The release label (e.g. "1.2.5")'),
    baseBranch: z.string().describe('The branch HEAD was moved to before the local delete'),
    worktree: z.enum(['removed', 'absent']).describe('Whether a git worktree was removed or none existed'),
    ideFolders: z
      .object({
        outcome: z
          .enum(['verified', 'attempted', 'skipped'])
          .describe('"verified" only when an editor reported a real diff; Zed is always a declared skip'),
        providers: z.array(
          z.object({
            provider: z.string(),
            outcome: z.enum(['verified', 'attempted', 'skipped']),
            removed: z.array(z.string()).describe('Folder paths confirmed removed; always empty for Zed'),
          }),
        ),
      })
      .describe('Per-editor outcome of stripping the worktree folder'),
    pr: z.enum(['closed', 'already-closed', 'absent']).describe('What happened to the release pull request'),
    prNumber: z.number().nullable().describe('The pull request number, or null when none exists'),
    localBranch: z.enum(['deleted', 'absent']).describe('Whether a local branch was deleted or none existed'),
    localTipSha: z.string().nullable().describe('The local tip before deletion — the handle that restores the branch'),
    remoteBranch: z.enum(['deleted', 'absent']).describe('Whether the origin branch was deleted or none existed'),
    remoteTipSha: z.string().nullable().describe('The origin tip before deletion'),
    jira: z
      .enum(['removed', 'absent', 'skipped'])
      .describe(
        '"removed" when the fix version was deleted; "absent" when Jira knows none for this release (the resume path); "skipped" only on the CLI with --skip-jira',
      ),
    jiraVersion: z
      .object({ id: z.string(), name: z.string(), url: z.string() })
      .nullable()
      .describe(
        'The fix version this release owned, captured before removal — the id is the only handle that survives it',
      ),
  },
  handler: releaseRemove,
})
