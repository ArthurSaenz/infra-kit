import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { assertCleanCheckout } from 'src/lib/git-guard'
import { logger } from 'src/lib/logger'
import { compareReleaseIds, formatBranchName, formatPrTitle, parseBranchName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import { buildReleasePrBody, detectReleaseType, getBaseBranch, releaseTypeFromBase } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'

interface ReleasePR {
  headRefName: string
  number: number
  state: string
  title: string
  baseRefName: string
  createdAt: string
}

/**
 * A discovery row after dedup. `dualBase` is decided where both gh lists are still in hand and
 * rides on the record from there, because sorting keeps the objects and only reorders them.
 */
interface DiscoveredPR extends ReleasePR {
  dualBase: boolean
}

export interface ReleasePRInfo {
  branch: string
  number: number
  title: string
  createdAt: string
  baseRefName: string
  /** From the base branch, which is what `gh pr merge` merges into — the title is only a label. */
  type: ReleaseType
  /** The title says one type, the base another: a retitled PR, or one opened against the wrong base. */
  titleMismatch: boolean
  /** The head has open PRs to both `dev` and `main`; this record is the `main` one. */
  dualBase: boolean
}

/**
 * Sort release head refs in the locked deterministic order (versions block
 * first by semver ascending, then names by PR creation date). Head refs that
 * are not valid release branches (parseBranchName → null) are filtered out
 * rather than throwing or NaN-sorting, so a stray junk branch can never break
 * discovery. Carries each PR's createdAt for name ordering.
 */
const sortReleasePRs = <T extends ReleasePR>(prs: T[]): T[] => {
  return prs
    .map((pr) => {
      return { pr, id: parseBranchName(pr.headRefName) }
    })
    .filter((entry): entry is { pr: T; id: NonNullable<typeof entry.id> } => {
      return entry.id !== null
    })
    .sort((a, b) => {
      return compareReleaseIds(a.id, b.id, { a: a.pr.createdAt, b: b.pr.createdAt })
    })
    .map((entry) => {
      return entry.pr
    })
}

/**
 * Page size for release-PR discovery. `gh pr list` defaults to 30, which
 * silently drops older open release PRs from every consumer of discovery
 * (list, merge-dev, deploy pickers). Explicit and high enough that hitting it
 * is a real anomaly, which `warnIfTruncated` then reports rather than hiding.
 */
const PR_DISCOVERY_LIMIT = 200

/**
 * Surface a discovery page that came back full: at that point the result is
 * indistinguishable from a truncated one, and a silently short list reads as
 * "there are no other releases".
 */
const warnIfTruncated = (prs: ReleasePR[], source: string): void => {
  if (prs.length < PR_DISCOVERY_LIMIT) return

  logger.warn(
    { source, limit: PR_DISCOVERY_LIMIT },
    `⚠️ ${source} returned ${PR_DISCOVERY_LIMIT} PRs — the page is full, so older release PRs may be missing`,
  )
}

/**
 * Fetch all open release/hotfix PRs from GitHub.
 * Searches both dev (regular) and main (hotfix) base branches.
 * Returns deduplicated ReleasePR objects.
 */
const fetchAllReleasePRs = async (): Promise<DiscoveredPR[]> => {
  // Issued together, not awaited in turn: one search runs 0.8–1.5 s on a consumer repo, and the
  // argument form that enumerates through here has 2.5 s for the pair (`lib/release-remove-form`).
  const [releasePRs, hotfixPRs] = await Promise.all([
    $`gh pr list --limit ${PR_DISCOVERY_LIMIT} --search "Release in:title" --base dev --json number,title,headRefName,state,baseRefName,createdAt`,
    $`gh pr list --limit ${PR_DISCOVERY_LIMIT} --search "Hotfix in:title" --base main --json number,title,headRefName,state,baseRefName,createdAt`,
  ])

  const releaseList: ReleasePR[] = JSON.parse(releasePRs.stdout)
  const hotfixList: ReleasePR[] = JSON.parse(hotfixPRs.stdout)

  warnIfTruncated(releaseList, 'release PR discovery (base dev)')
  warnIfTruncated(hotfixList, 'hotfix PR discovery (base main)')

  // GitHub allows one open PR per head/base *pair*, so a head can be in both lists. Such a head
  // must not read as a plain regular release: merge-dev would push `dev` onto a branch that also
  // targets `main`. The `main` record is the one kept — the dangerous side is the one to surface.
  const devHeads = new Set(
    releaseList.map((pr) => {
      return pr.headRefName
    }),
  )
  const dualHeads = new Set(
    hotfixList
      .filter((pr) => {
        return devHeads.has(pr.headRefName)
      })
      .map((pr) => {
        return pr.headRefName
      }),
  )

  // main-first so the dedup below keeps the `main` record of a dual head.
  const all: ReleasePR[] = [...hotfixList, ...releaseList]
  const seen = new Set<string>()

  return all
    .filter((pr) => {
      if (seen.has(pr.headRefName)) return false

      seen.add(pr.headRefName)

      return true
    })
    .map((pr) => {
      return { ...pr, dualBase: dualHeads.has(pr.headRefName) }
    })
}

/**
 * The `operation` of the refusal discovery throws when gh answered and there is simply nothing
 * open. Exported because "none" and "gh failed" leave through the same `throw`, and a caller that
 * must tell them apart (the release-remove argument form) has only this field to read.
 */
export const NO_OPEN_RELEASE_PRS_OPERATION = 'find open release PRs'

/**
 * Fetch, guard against empty, and sort all open release PRs in the locked
 * deterministic order. Shared core of the two public variants below; wraps the
 * gh calls so a fetch failure surfaces as an OperationError.
 */
const loadSortedReleasePRs = async (): Promise<DiscoveredPR[]> => {
  try {
    const prs = await fetchAllReleasePRs()

    if (prs.length === 0) {
      throw new OperationError(undefined, {
        operation: NO_OPEN_RELEASE_PRS_OPERATION,
        remediation: 'open a release PR first, or check you are in the right repo',
      })
    }

    return sortReleasePRs(prs)
  } catch (error) {
    if (error instanceof OperationError) throw error

    // `debug`, not `error`: this rethrows as an OperationError, and `entry/cli.ts` logs any
    // uncaught error at ERROR and exits 1 — so logging here too printed one fault as two red
    // lines. Kept (demoted, not deleted) because the wrapped message renders only the operation
    // and remediation; the cause's stack survives here and is reachable with `--debug`.
    logger.debug({ err: error }, 'Error fetching release PRs')

    throw new OperationError(error, { operation: 'fetch release PRs' })
  }
}

/**
 * Fetch open release PRs from GitHub with 'Release' or 'Hotfix' in the title.
 * Returns an array of headRefName strings in the locked deterministic order
 * (version branches first by semver ascending, then named branches by PR
 * creation date). Unparseable head refs are filtered out.
 *
 * @returns [release/v1.18.22, release/v1.18.23, release/checkout-redesign]
 */
export const getReleasePRs = async (): Promise<string[]> => {
  const prs = await loadSortedReleasePRs()

  return prs.map((pr) => {
    return pr.headRefName
  })
}

/**
 * The one place a discovered PR gets its type. The base branch is what `gh pr merge` merges into,
 * so it decides; the title is cross-checked and a disagreement is flagged, never resolved here —
 * the writers (merge-dev, deliver) decide what a flag means for them.
 */
const classifyReleasePR = (pr: DiscoveredPR): ReleasePRInfo => {
  const type = releaseTypeFromBase(pr.baseRefName)

  // Both discovery queries pin `--base`, so an unmapped base can only mean the query and the
  // mapping drifted apart. Guessing a type would let the writers act on the wrong branch.
  if (type === null) {
    throw new OperationError(undefined, {
      operation: 'classify release PRs',
      remediation: 'discovery returned a PR outside the dev/main base set — this is an infra-kit bug, please report it',
      stderrExcerpt: `${pr.headRefName} (#${pr.number}) targets ${pr.baseRefName}`,
    })
  }

  const titleMismatch = detectReleaseType(pr.title) !== type

  if (titleMismatch || pr.dualBase) {
    logger.warn(
      { branch: pr.headRefName, title: pr.title, baseRefName: pr.baseRefName },
      pr.dualBase
        ? `⚠️ ${pr.headRefName} has open PRs to both dev and main — treated as a hotfix (base main)`
        : `⚠️ ${pr.headRefName} is titled "${pr.title}" but targets ${pr.baseRefName} — treated as ${type} by its base`,
    )
  }

  return {
    branch: pr.headRefName,
    number: pr.number,
    title: pr.title,
    createdAt: pr.createdAt,
    baseRefName: pr.baseRefName,
    type,
    titleMismatch,
    dualBase: pr.dualBase,
  }
}

/**
 * Fetch open release PRs classified by base branch, with the title cross-check
 * and dual-base flags. Returns ReleasePRInfo objects in the locked deterministic
 * order (version branches first by semver ascending, then named branches by PR
 * creation date). Unparseable head refs are filtered out.
 */
export const getReleasePRsWithInfo = async (): Promise<ReleasePRInfo[]> => {
  const prs = await loadSortedReleasePRs()

  return prs.map(classifyReleasePR)
}

interface UpdateReleasePRBodyArgs {
  branch: string
  body: string
}

/**
 * Update the body of an open release PR identified by its head branch.
 */
export const updateReleasePRBody = async (args: UpdateReleasePRBodyArgs): Promise<void> => {
  const { branch, body } = args

  try {
    await $({ quiet: true })`gh pr edit ${branch} --body ${body}`
  } catch (error: unknown) {
    logger.error({ error, branch }, `Error updating release PR body for ${branch}`)
    throw error
  }
}

interface CreateReleaseBranchArgs {
  id: ReleaseId
  jiraVersionUrl: string
  type: ReleaseType
  description?: string
  /**
   * The `origin/<base>` SHA `prepareGitForRelease` just landed on. The caller guarantees a
   * freshly fetched and fast-forwarded base checkout; this is how that guarantee is checked
   * at the moment it is consumed rather than taken on trust.
   */
  baseSha: string
}

/**
 * Roll back a release branch that was created locally but never reached the remote.
 *
 * Only the local-only window is undone, and the probe is what establishes that window: what
 * the code can observe is not "the push has not happened" but "the push *call* rejected", and
 * a push the remote accepted whose transport then died exits non-zero with the ref created.
 * So a ref that exists on origin — or a probe that cannot answer — means keep the branch and
 * report it. Deleting there would destroy the operator's only handle on a half-made release.
 */
// Never throws. It runs on the failure path, and an exception here would replace the real
// diagnosis with whatever the cleanup tripped over. `git switch` has to come first because
// `deleteLocalBranch` silently no-ops on the current branch, so a rollback that skipped it
// would report success while leaving the branch in place.
const cleanupUnpushedBranch = async (branchName: string, baseBranch: string): Promise<void> => {
  const git = $({ quiet: true, nothrow: true })

  const refs = await git`git ls-remote --heads origin ${branchName}`
  const probeFailed = refs.exitCode !== 0
  const onRemote = refs.stdout.trim().length > 0

  if (probeFailed || onRemote) {
    // Two different states, reported as two different sentences. Telling an operator a branch
    // "may" exist when we just listed it wastes their time re-checking; telling them it does
    // exist when the probe never answered would be a claim we cannot support.
    logger.error(
      { branchName },
      probeFailed
        ? `could not reach origin to check whether ${branchName} was pushed — the branch is left in place; check with \`git ls-remote --heads origin ${branchName}\` before deleting anything`
        : `release branch ${branchName} exists on origin without a PR — left in place; delete it with \`git push origin --delete ${branchName}\` once you are sure`,
    )

    return
  }

  // The switch has to land before the delete: git refuses to delete the branch you are standing
  // on, and under `nothrow` that refusal is silent. So the delete is checked rather than assumed —
  // a cleanup that quietly did nothing is worse than one that says so, because the operator would
  // otherwise discover it only when the retry fails with "branch already exists".
  await git`git switch ${baseBranch}`

  const deleted = await git`git branch -D ${branchName}`

  if (deleted.exitCode !== 0) {
    logger.error(
      { branchName },
      `could not remove the local branch ${branchName} after a failed release — delete it with \`git branch -D ${branchName}\` before retrying`,
    )
  }
}

// Function to create a release branch
export const createReleaseBranch = async (
  args: CreateReleaseBranchArgs,
): Promise<{ branchName: string; prUrl: string }> => {
  const { id, jiraVersionUrl, type, description, baseSha } = args
  const prTitle = formatPrTitle(id, type)
  const baseBranch = getBaseBranch(type)
  const git = $({ quiet: true })

  const branchName = formatBranchName(id)

  const body = buildReleasePrBody(jiraVersionUrl, description)

  try {
    // The base switch/pull the old code repeated here is gone: `prepareGitForRelease` already
    // did it, and doing it twice only widened the window in which the checkout could change
    // under us. What replaces it is a check rather than a repeat — the two assertions below
    // are the *last* thing that happens before the first destructive command, because the
    // caller's own checks are separated from this point by a Jira round trip.
    await assertCleanCheckout({ operation: `create release branch ${branchName}` })

    const head = (await git`git rev-parse HEAD`).stdout.trim()

    if (head !== baseSha) {
      throw new OperationError(undefined, {
        operation: `create release branch ${branchName}`,
        remediation: 'something moved the checkout mid-run — re-run the release',
        stderrExcerpt: `expected to be on ${baseSha.slice(0, 8)} (${baseBranch}) but HEAD is ${head.slice(0, 8)}`,
      })
    }

    await git`git checkout -b ${branchName}`

    // Everything from here on can leave a branch behind, so it runs under cleanup. The commit
    // precedes the push deliberately: pushing first published a branch with zero commits, so
    // any later failure left a remote ref that could not even take a PR (`gh pr create`
    // rejects "no commits between base and head"). One push, of a branch that is already
    // complete, makes the local-only window cover the ordinary failures instead of one command.
    try {
      await git`git commit --allow-empty-message --allow-empty --message ''`
      await git`git push -u origin ${branchName}`

      const prResult =
        await git`gh pr create --title ${prTitle} --body ${body} --base ${baseBranch} --head ${branchName}`

      return {
        branchName,
        prUrl: prResult.stdout.trim(),
      }
    } catch (error: unknown) {
      await cleanupUnpushedBranch(branchName, baseBranch)

      throw error
    }
  } catch (error: unknown) {
    logger.error({ error, branchName }, `Error creating release branch ${branchName}`)

    throw error
  } finally {
    // In a `finally`, and swallowing: the old code put this switch on the success path only,
    // so a failure left the operator standing on a half-made release branch — the one place
    // the "you end on the base branch" contract mattered most. Swallowing is required for the
    // same reason the cleanup swallows: a throw here would replace the original error.
    await $({ quiet: true, nothrow: true })`git switch ${baseBranch}`
  }
}
