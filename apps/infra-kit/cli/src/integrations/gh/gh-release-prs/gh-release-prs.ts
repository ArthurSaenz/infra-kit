import process from 'node:process'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'
import { compareReleaseIds, formatBranchName, formatPrTitle, parseBranchName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
import { getBaseBranch } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'

interface ReleasePR {
  headRefName: string
  number: number
  state: string
  title: string
  baseRefName: string
  createdAt: string
}

export interface ReleasePRInfo {
  branch: string
  title: string
  createdAt: string
}

/**
 * Sort release head refs in the locked deterministic order (versions block
 * first by semver ascending, then names by PR creation date). Head refs that
 * are not valid release branches (parseBranchName → null) are filtered out
 * rather than throwing or NaN-sorting, so a stray junk branch can never break
 * discovery. Carries each PR's createdAt for name ordering.
 */
const sortReleasePRs = (prs: ReleasePR[]): ReleasePR[] => {
  return prs
    .map((pr) => {
      return { pr, id: parseBranchName(pr.headRefName) }
    })
    .filter((entry): entry is { pr: ReleasePR; id: NonNullable<typeof entry.id> } => {
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
 * Fetch all open release/hotfix PRs from GitHub.
 * Searches both dev (regular) and main (hotfix) base branches.
 * Returns deduplicated ReleasePR objects.
 */
const fetchAllReleasePRs = async (): Promise<ReleasePR[]> => {
  const releasePRs =
    await $`gh pr list --search "Release in:title" --base dev --json number,title,headRefName,state,baseRefName,createdAt`

  const hotfixPRs =
    await $`gh pr list --search "Hotfix in:title" --base main --json number,title,headRefName,state,baseRefName,createdAt`

  const all: ReleasePR[] = [...JSON.parse(releasePRs.stdout), ...JSON.parse(hotfixPRs.stdout)]

  // Deduplicate by headRefName
  const seen = new Set<string>()

  return all.filter((pr) => {
    if (seen.has(pr.headRefName)) return false

    seen.add(pr.headRefName)

    return true
  })
}

/**
 * Fetch open release PRs from GitHub with 'Release' or 'Hotfix' in the title.
 * Returns an array of headRefName strings in the locked deterministic order
 * (version branches first by semver ascending, then named branches by PR
 * creation date). Unparseable head refs are filtered out.
 *
 * @returns [release/v1.18.22, release/v1.18.23, release/n/checkout-redesign]
 */
export const getReleasePRs = async (): Promise<string[]> => {
  try {
    const prs = await fetchAllReleasePRs()

    if (prs.length === 0) {
      logger.error('❌ No release PRs found. Check the project folder for the script. Exiting...')

      process.exit(1)
    }

    return sortReleasePRs(prs).map((pr) => {
      return pr.headRefName
    })
  } catch (error) {
    logger.error({ error }, '❌ Error fetching release PRs')

    process.exit(1)
  }
}

/**
 * Fetch open release PRs with title info (for detecting release type).
 * Returns ReleasePRInfo objects in the locked deterministic order (version
 * branches first by semver ascending, then named branches by PR creation
 * date). Unparseable head refs are filtered out.
 */
export const getReleasePRsWithInfo = async (): Promise<ReleasePRInfo[]> => {
  try {
    const prs = await fetchAllReleasePRs()

    if (prs.length === 0) {
      logger.error('❌ No release PRs found. Check the project folder for the script. Exiting...')
      process.exit(1)
    }

    return sortReleasePRs(prs).map((pr) => {
      return {
        branch: pr.headRefName,
        title: pr.title,
        createdAt: pr.createdAt,
      }
    })
  } catch (error) {
    logger.error({ error }, '❌ Error fetching release PRs')
    process.exit(1)
  }
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
    $.quiet = true
    await $`gh pr edit ${branch} --body ${body}`
    $.quiet = false
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
}

// Function to create a release branch
export const createReleaseBranch = async (
  args: CreateReleaseBranchArgs,
): Promise<{ branchName: string; prUrl: string }> => {
  const { id, jiraVersionUrl, type, description } = args
  const prTitle = formatPrTitle(id, type)
  const baseBranch = getBaseBranch(type)

  const branchName = formatBranchName(id)

  const body = description && description.trim() !== '' ? `${jiraVersionUrl}\n\n${description}` : `${jiraVersionUrl} \n`

  try {
    $.quiet = true

    await $`git switch ${baseBranch}`
    await $`git pull origin ${baseBranch}`
    await $`git checkout -b ${branchName}`
    await $`git push -u origin ${branchName}`
    await $`git commit --allow-empty-message --allow-empty --message ''`
    await $`git push origin ${branchName}`

    // Create PR and capture URL
    const prResult = await $`gh pr create --title "${prTitle}" --body ${body} --base ${baseBranch} --head ${branchName}`

    const prLink = prResult.stdout.trim()

    await $`git switch ${baseBranch}`

    $.quiet = false

    return {
      branchName,
      prUrl: prLink,
    }
  } catch (error: unknown) {
    logger.error({ error, branchName }, `Error creating release branch ${branchName}`)

    throw error
  }
}
