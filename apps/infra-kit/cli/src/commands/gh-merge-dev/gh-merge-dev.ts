import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { isCommandDeclined } from 'src/lib/errors/command-declined-error'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertRepoWithOrigin } from 'src/lib/git-guard'
import { getMainRepoRoot, listWorktrees, lsRemoteHead, pushAtomic, withScratchWorktree } from 'src/lib/git-utils'
import type { WorktreeEntry } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'
import { formatBranchName, formatJiraName, parseBranchName, parseReleaseRef } from 'src/lib/release-id'
import { detectReleaseType, formatBranchPickerItems } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

import { DEFAULT_VERIFY_COMMAND, planMergeRun, pushableRefs, reclassify, verifyMerges } from './merge-run'
import type { MergePlanEntry, MergeStatus } from './merge-run'
import { registerRunCleanup } from './run-cleanup'

interface GhMergeDevArgs extends RequiredConfirmedOptionArg {
  all?: boolean
  /**
   * Comma string (CLI) or array (MCP) of release selectors. Each entry may be a
   * version label (`1.2.5`) or a raw branch name (`release/v1.2.5`).
   */
  versions?: string | string[]
  /** Compute and print the plan, push nothing. */
  dryRun?: boolean
  /**
   * Verify each merge before pushing it. `true` runs the default install tier;
   * a string runs that command verbatim in the scratch worktree.
   */
  verify?: boolean | string
}

type ResultStatus = MergeStatus | 'push-aborted' | 'verify-failed'

interface MergeDevResultEntry {
  branch: string
  status: ResultStatus
  mergeSha?: string
  conflictPaths?: string[]
  pushed: boolean
  reason?: string
}

interface MergeDevResult {
  successfulMerges: number
  failedMerges: number
  failedBranches: string[]
  totalBranches: number
  dryRun: boolean
  atomicPush: { attempted: boolean; aborted: boolean; abortedBy?: string }
  results: MergeDevResultEntry[]
}

const emptyResult = (dryRun: boolean): MergeDevResult => {
  return {
    successfulMerges: 0,
    failedMerges: 0,
    failedBranches: [],
    totalBranches: 0,
    dryRun,
    atomicPush: { attempted: false, aborted: false },
    results: [],
  }
}

const toResponse = (structuredContent: MergeDevResult) => {
  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

/** Statuses that represent the branch reaching its desired end state. */
const SUCCESS_STATUSES = new Set<ResultStatus>(['up-to-date', 'fast-forward', 'merged'])

/**
 * Resolve `--versions` selectors against the open **regular** release branches.
 *
 * Selects from `available` — the already-filtered list — rather than parsing tokens in
 * isolation, and never round-trips through `releaseBranchLabels`.
 */
// Both properties above have already been shipped as bugs elsewhere in this CLI:
//
// 1. `worktrees-add` skips the PR lookup entirely when `versions` is given — correct there,
//    because it *wants* hotfix worktrees. Copying that shape here would bypass the
//    `detectReleaseType(pr.title) === 'regular'` filter, and since hotfix PRs carry ordinary
//    `release/v…` head refs (only their *title* marks them), `--versions 1.2.5` would happily
//    merge `dev` into a branch that targets `main`.
// 2. `releaseBranchLabels`'s `flatMap` drops any branch that fails `parseBranchName`, so routing
//    selectors through it is a silent selector loss.
const resolveRequestedBranches = (versions: string | string[], available: string[]): string[] => {
  const tokens = (Array.isArray(versions) ? versions : versions.split(','))
    .map((token) => {
      return token.trim()
    })
    .filter((token) => {
      return token.length > 0
    })

  const availableSet = new Set(available)
  const selected = new Set<string>()

  for (const token of tokens) {
    let branch: string

    try {
      branch = formatBranchName(parseReleaseRef(token))
    } catch (error) {
      throw new OperationError(error, {
        operation: `resolve release selector "${token}"`,
        remediation: `pass one of: ${available.join(', ')}`,
      })
    }

    if (!availableSet.has(branch)) {
      throw new OperationError(undefined, {
        operation: `select release branch for "${token}"`,
        stderrExcerpt: `${branch} is not an open regular release branch`,
        remediation: `pass one of: ${available.join(', ')}`,
      })
    }

    selected.add(branch)
  }

  // Preserve the caller-independent order the PR listing already locked in, so
  // two operators naming the same set get the same plan.
  return available.filter((branch) => {
    return selected.has(branch)
  })
}

const PLAN_LABELS: Record<MergeStatus, string> = {
  'up-to-date': 'already up to date',
  'fast-forward': 'fast-forward',
  merged: 'clean merge',
  conflict: 'CONFLICT',
  'hook-failed': 'HOOK FAILED',
  error: 'ERROR',
  'not-attempted': 'not attempted',
}

const describeEntry = (entry: MergePlanEntry): string => {
  const label = PLAN_LABELS[entry.status]

  if (entry.status === 'conflict') {
    const count = entry.conflictPaths?.length ?? 0

    return `${label}: ${count} file(s)`
  }

  return entry.reason ? `${label}: ${entry.reason}` : label
}

/**
 * Print the plan before the operator is asked to confirm it.
 *
 * This is the whole point of computing the merges first: the thing shown here is
 * literally the thing that will be pushed, because the plan and the apply are the
 * same operation rather than a prediction and an application that can disagree.
 */
const renderPlan = (entries: MergePlanEntry[]): void => {
  logger.info('\n📋 Merge plan:')

  for (const entry of entries) {
    logger.info(`  ${entry.branch} — ${describeEntry(entry)}`)
  }
}

/**
 * The exact command the operator can run to finish a branch by hand.
 *
 * It has to be worktree-aware, because the blanket `git switch <b> && …` form is
 * wrong advice in precisely the common case: on this team `worktrees-add` keeps a
 * worktree per release branch, so `git switch` fails with `already used by
 * worktree at …` — the very failure this whole change removed from the command.
 * Printing it back to the operator would hand them the broken workflow we just
 * fixed.
 */
const reproduceCommand = (branch: string, worktrees: WorktreeEntry[]): string => {
  const held = worktrees.find((entry) => {
    return entry.branch === branch
  })

  return held ? `git -C ${held.path} merge origin/dev` : `git switch ${branch} && git merge origin/dev`
}

interface RunOutcome {
  entries: MergePlanEntry[]
  selected: string[]
  pushed: boolean
  pushAborted: boolean
  abortedBy?: string
  /** Branches origin turned out to already carry despite the push reporting failure. */
  observedLanded?: string[]
  /** branch → why verification refused it, when --verify ran. */
  verifyFailed?: Map<string, string>
  declined: boolean
}

/** Interactive selection, rendered with each branch's plan status inline. */
const selectBranches = async (args: {
  entries: MergePlanEntry[]
  toPlan: string[]
  all?: boolean
  explicit: boolean
}): Promise<string[]> => {
  const { entries, toPlan, all, explicit } = args

  if (explicit || all) return toPlan

  commandEcho.setInteractive()

  // The picker runs AFTER the plan so the operator chooses with each branch's
  // conflict status visible. Choosing first and learning second defeats the
  // preflight the whole design exists to provide.
  //
  // Keyed by `formatJiraName`, NOT by branch name: `formatBranchPickerItems`
  // looks descriptions up by the Jira version name (`v1.2.3`), because its
  // original caller passed a Jira map. A branch-keyed map silently misses every
  // entry and renders no status at all — which is precisely the no-op this
  // feature exists to avoid.
  const descriptions = new Map(
    entries.flatMap((entry) => {
      const id = parseBranchName(entry.branch)

      return id ? [[formatJiraName(id), describeEntry(entry)] as const] : []
    }),
  )

  return pickReleaseBranches(formatBranchPickerItems({ branches: toPlan, descriptions }), { required: true })
}

/** Reclassify, optionally verify, reclassify again, and perform the single atomic push. */
const applyPush = async (args: {
  cwd: string
  worktreePath: string
  entries: MergePlanEntry[]
  selected: string[]
  verify?: string
}): Promise<Pick<RunOutcome, 'pushed' | 'pushAborted' | 'abortedBy' | 'observedLanded' | 'verifyFailed'>> => {
  const { cwd, worktreePath, entries, selected, verify } = args

  const chosen = entries.filter((entry) => {
    return selected.includes(entry.branch)
  })

  const announceDropped = (branches: string[]): void => {
    for (const branch of branches) {
      logger.info(`ℹ️ ${branch} was merged by someone else while we planned — dropping it from the push`)
    }
  }

  const first = await reclassify(cwd, pushableRefs(chosen))

  announceDropped(first.nowUpToDate)

  let kept = first.kept
  let verifyFailed = new Map<string, string>()

  if (verify && kept.length > 0) {
    logger.info(`\n🔎 Verifying ${kept.length} merge(s) with: ${verify}`)

    const outcome = await verifyMerges({ worktreePath, refs: kept, command: verify })

    verifyFailed = outcome.failed

    for (const [branch, reason] of outcome.failed) {
      logger.info(`✗ ${branch} failed verification — not pushing it. ${reason.split('\n')[0] ?? ''}`)
    }

    // Reclassify AGAIN. The verification pass is the only step here that can take
    // minutes, and a teammate merging during it makes the first reclassification
    // stale — under `--atomic` a single stale ref aborts the push for EVERY
    // branch, which is the exact failure reclassification exists to prevent.
    const second = await reclassify(cwd, outcome.kept)

    announceDropped(second.nowUpToDate)
    kept = second.kept
  }

  if (kept.length === 0) return { pushed: false, pushAborted: false, verifyFailed }

  // Printed BEFORE the push so the transcript names what was in flight: an atomic
  // push that lands server-side but whose response is lost would otherwise leave
  // origin advanced while the report says "aborted".
  logger.info(
    `\n⬆️  Pushing atomically: ${kept
      .map((ref) => {
        return ref.branch
      })
      .join(', ')}`,
  )

  const result = await pushAtomic(cwd, kept)

  if (result.pushed) return { pushed: true, pushAborted: false, verifyFailed }

  // `--atomic` is all-or-nothing for REFS, not for our knowledge of them. A push
  // that lands server-side but whose response is lost — a dropped connection, or
  // a kill between the push returning and this line — leaves origin fully
  // advanced while we are about to report "aborted". And `--atomic` makes that
  // wrong report MORE credible, because the operator has been told all-or-nothing
  // and reads "aborted" as "nothing happened". So never infer: go and look.
  const observed = await Promise.all(
    kept.map(async (ref) => {
      return { branch: ref.branch, landed: (await lsRemoteHead(cwd, ref.branch)) === ref.sha }
    }),
  )

  const landed = observed.filter((entry) => {
    return entry.landed
  })

  if (landed.length > 0) {
    logger.warn(
      `⚠️  The push reported failure, but origin already carries ${landed
        .map((entry) => {
          return entry.branch
        })
        .join(', ')} — re-run to reconcile.`,
    )
  }

  return {
    pushed: false,
    pushAborted: true,
    abortedBy: result.stderr?.split('\n')[0],
    observedLanded: landed.map((entry) => {
      return entry.branch
    }),
  }
}

export const ghMergeDev = async (args: GhMergeDevArgs) => {
  const { all, versions, dryRun = false, verify, confirmedCommand } = args

  // `true` (bare `--verify`) selects the cheap default tier; a string is the
  // operator's own command. Configuring at the call site rather than in repo
  // config is deliberate — this CLI's config file is a strict schema, so a new
  // key could not reach consumer repos without a schema change and a release.
  const verifyCommand = verify === true ? DEFAULT_VERIFY_COMMAND : verify || undefined

  // Deliberately NOT `assertManagementContext`: this command never touches an
  // existing checkout, so requiring a clean tree and refusing to run from a
  // linked worktree would only refuse work that is about to succeed.
  await assertRepoWithOrigin({ operation: 'merge dev into release branches' })

  // Only merge dev into regular releases (not hotfixes, which target main)
  const allPRs = await getReleasePRsWithInfo()
  const candidates = allPRs
    .filter((pr) => {
      return detectReleaseType(pr.title) === 'regular'
    })
    .map((pr) => {
      return pr.branch
    })

  if (candidates.length === 0) {
    logger.info('ℹ️ No open release branches found')

    commandEcho.print()

    return toResponse(emptyResult(dryRun))
  }

  const cwd = await getMainRepoRoot()

  try {
    await $({ cwd, quiet: true })`git fetch origin --prune`
  } catch (error) {
    throw new OperationError(error, {
      operation: 'fetch origin before planning the merges',
      remediation: 'check network access and that `origin` is reachable',
    })
  }

  const toPlan = versions === undefined ? candidates : resolveRequestedBranches(versions, candidates)

  const outcome = await withScratchWorktree({ cwd }, async (worktree): Promise<RunOutcome> => {
    // The worktree exists from here until the push completes, which spans the
    // confirmation prompt. Registering its removal means a Ctrl-C in that window
    // still releases it — `finally` alone does not run when Node takes the
    // default action for SIGINT, and a leaked registration breaks every
    // subsequent run on this machine until someone runs `git worktree prune`.
    const unregister = registerRunCleanup(worktree.remove)

    try {
      return await planConfirmAndPush({
        cwd,
        worktree,
        toPlan,
        candidates,
        all,
        versions,
        dryRun,
        verify: verifyCommand,
        confirmedCommand,
      })
    } finally {
      unregister()
    }
  })

  const { entries, selected, pushed, pushAborted, abortedBy, declined, verifyFailed } = outcome

  // One cheap porcelain read, so a failed branch's printed recipe names the
  // worktree it actually lives in rather than a  that would fail.
  const worktrees = await listWorktrees(cwd).catch(() => {
    return [] as WorktreeEntry[]
  })

  return report({ entries, selected, pushed, pushAborted, abortedBy, declined, verifyFailed, dryRun, worktrees })
}

const planConfirmAndPush = async (args: {
  cwd: string
  worktree: { path: string }
  toPlan: string[]
  candidates: string[]
  all?: boolean
  versions?: string | string[]
  dryRun: boolean
  verify?: string
  confirmedCommand: boolean | undefined
}): Promise<RunOutcome> => {
  const { cwd, worktree, toPlan, candidates, all, versions, dryRun, verify, confirmedCommand } = args

  const entries = await planMergeRun({ cwd, worktreePath: worktree.path, branches: toPlan })
  const idle = { entries, pushed: false, pushAborted: false, declined: false }

  renderPlan(entries)

  if (dryRun) return { ...idle, selected: toPlan }

  const selected = await selectBranches({ entries, toPlan, all, explicit: versions !== undefined })

  if (selected.length === candidates.length) {
    commandEcho.addOption('--all', true)
  } else {
    // Branch names, not `releaseBranchLabels` output: its `flatMap` drops any
    // branch that fails `parseBranchName`, so a label echo can print a NARROWER
    // selection than the one that just ran.
    commandEcho.addOption('--versions', selected)
  }

  const willPush = entries.filter((entry) => {
    return selected.includes(entry.branch) && entry.mergeSha
  }).length

  if (willPush > 0) {
    // Named before the operator commits, because it is the one consequence that
    // reaches beyond git: each push re-triggers CI on that branch's open PR, and
    // if the repo dismisses stale approvals on new commits, every one of those
    // PRs loses its approvals at once.
    logger.info(
      `\nℹ️  This will push ${willPush} branch(es), re-running CI on ${willPush} open PR(s).` +
        ' If the repo dismisses stale approvals on new commits, those PRs lose them.',
    )
  }

  try {
    // `throwOnDecline` is load-bearing here, not stylistic: the scratch worktree
    // is alive at this point, and `process.exit(0)` would skip the `finally`
    // that removes it — leaking one on the most ordinary non-happy path there is.
    await confirmOrExit(
      confirmedCommand,
      `Are you sure you want to merge dev into these branches: ${selected.join(', ')}?`,
      { throwOnDecline: true },
    )
  } catch (error) {
    if (!isCommandDeclined(error)) throw error

    return { ...idle, selected, declined: true }
  }

  if (!confirmedCommand) {
    commandEcho.addOption('--yes', true)
  }

  return {
    entries,
    selected,
    declined: false,
    ...(await applyPush({ cwd, worktreePath: worktree.path, entries, selected, verify })),
  }
}

/** Turn the run's outcome into the printed report and the structured result. */
const report = (args: RunOutcome & { dryRun: boolean; worktrees: WorktreeEntry[] }) => {
  const { entries, selected, pushed, pushAborted, abortedBy, declined, dryRun, worktrees, verifyFailed } = args

  const pushedBranches = new Set(
    pushed
      ? entries
          .filter((entry) => {
            // Having a merge sha is not the same as having been pushed: a branch
            // verification refused was dropped from the refspec set before the
            // push was assembled, so reporting it as pushed would be a lie about
            // an irreversible operation.
            return selected.includes(entry.branch) && entry.mergeSha && !verifyFailed?.has(entry.branch)
          })
          .map((entry) => {
            return entry.branch
          })
      : [],
  )

  const results: MergeDevResultEntry[] = entries
    .filter((entry) => {
      return selected.includes(entry.branch)
    })
    .map((entry) => {
      const wasPushable = Boolean(entry.mergeSha)
      const verifyReason = args.verifyFailed?.get(entry.branch)

      // Verification refusal outranks the push outcome: the branch never reached
      // the push, so reporting it as `push-aborted` would name the wrong cause.
      const pushOutcome: ResultStatus = pushAborted && wasPushable ? 'push-aborted' : entry.status
      const status: ResultStatus = verifyReason ? 'verify-failed' : pushOutcome

      return {
        branch: entry.branch,
        status,
        mergeSha: entry.mergeSha,
        conflictPaths: entry.conflictPaths,
        pushed: pushedBranches.has(entry.branch),
        reason: verifyReason ?? entry.reason,
      }
    })

  const failed = results.filter((entry) => {
    return !SUCCESS_STATUSES.has(entry.status)
  })

  // One structured line per branch, so a transcript can be read back mechanically
  // rather than scraped from the human summary below.
  for (const entry of results) {
    const planned = entries.find((candidate) => {
      return candidate.branch === entry.branch
    })

    logger.info({
      branch: entry.branch,
      status: entry.status,
      mergeSha: entry.mergeSha,
      conflictCount: entry.conflictPaths?.length ?? 0,
      durationMs: planned?.durationMs,
      pushed: entry.pushed,
      msg: 'merge-dev branch result',
    })
  }

  if (declined || dryRun) {
    logger.info(declined ? '\nOperation cancelled — nothing was pushed.\n' : '\n🔍 Dry run — nothing was pushed.\n')
  } else if (failed.length > 0) {
    logger.info(`\n⚠️  ${failed.length} branch(es) did not merge.\n`)
    for (const entry of failed) {
      logger.info(`# ${entry.branch} — ${entry.status}\n${reproduceCommand(entry.branch, worktrees)}\n`)
    }
  } else {
    logger.info('✅ All merges completed successfully!\n')
  }

  commandEcho.print()

  // A dry run must not claim merges: `--json` is wired globally, so this reaches
  // CLI scripts today, not only MCP agents.
  const reportable = dryRun || declined

  return toResponse({
    successfulMerges: reportable
      ? 0
      : results.filter((entry) => {
          return SUCCESS_STATUSES.has(entry.status)
        }).length,
    failedMerges: reportable ? 0 : failed.length,
    failedBranches: reportable
      ? []
      : failed.map((entry) => {
          return entry.branch
        }),
    totalBranches: results.length,
    dryRun,
    atomicPush: { attempted: !dryRun && !declined, aborted: pushAborted, abortedBy },
    results: results.map((entry) => {
      return reportable ? { ...entry, pushed: false } : entry
    }),
  })
}

// MCP Tool Registration
export const ghMergeDevMcpTool = defineMcpTool({
  name: 'gh-merge-dev',
  description:
    'Merge origin/dev into open regular (non-hotfix) release branches and push them in one atomic push. Merges happen in a disposable scratch worktree, so no existing checkout is touched and the branches may be checked out elsewhere. When invoked via MCP, pass all=true or an explicit versions list — the branch picker is unreachable without a TTY, and the confirmation prompt is auto-skipped for MCP calls, so the caller is responsible for gating. Irreversible once pushed.',
  requiresHumanConfirm: true,
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Target every open regular release branch. Must be true for MCP calls unless `versions` is supplied (the interactive picker is unavailable without a TTY).',
      ),
    versions: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Target a subset of the open regular release branches. Each entry may be a version label ("1.2.5") or a raw branch name ("release/v1.2.5"). A selector that is not an open regular release is an error — hotfix branches cannot be selected. Takes precedence over `all`.',
      ),
    dryRun: z.boolean().optional().describe('Compute and print the merge plan without pushing anything.'),
    verify: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe(
        'Check each merge before pushing it. `true` runs `pnpm install --frozen-lockfile` — which catches the characteristic dev→release failure, a pnpm-lock.yaml whose text merge is clean but whose result is broken. A string runs that command instead. A branch that fails verification is dropped from the push; nothing is ever rolled back, because verification runs pre-push.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved action.'),
  },
  outputSchema: {
    successfulMerges: z.number().describe('Number of branches that reached their desired state'),
    failedMerges: z.number().describe('Number of branches that did not'),
    failedBranches: z.array(z.string()).describe('List of branches that did not merge'),
    totalBranches: z.number().describe('Total number of branches processed'),
    dryRun: z.boolean().describe('True when nothing was pushed because this was a plan-only run'),
    atomicPush: z
      .object({
        attempted: z.boolean(),
        aborted: z.boolean(),
        abortedBy: z.string().optional(),
      })
      .describe('Outcome of the single all-or-nothing push'),
    results: z
      .array(
        z.object({
          branch: z.string(),
          status: z.string(),
          mergeSha: z.string().optional(),
          conflictPaths: z.array(z.string()).optional(),
          pushed: z.boolean(),
          reason: z.string().optional(),
        }),
      )
      .describe('Per-branch terminal state'),
  },
  handler: ghMergeDev,
})
