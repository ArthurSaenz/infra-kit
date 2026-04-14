import process from 'node:process'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'
import { getBaseBranch } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { sortVersions } from 'src/lib/version-utils'

interface ReleasePR {
  headRefName: string
  number: number
  state: string
  title: string
  baseRefName: string
}

export interface ReleasePRInfo {
  branch: string
  title: string
}

/**
 * Fetch all open release/hotfix PRs from GitHub.
 * Searches both dev (regular) and main (hotfix) base branches.
 * Returns deduplicated ReleasePR objects.
 */
const fetchAllReleasePRs = async (): Promise<ReleasePR[]> => {
  const releasePRs =
    await $`gh pr list --search "Release in:title" --base dev --json number,title,headRefName,state,baseRefName`

  const hotfixPRs =
    await $`gh pr list --search "Hotfix in:title" --base main --json number,title,headRefName,state,baseRefName`

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
 * Fetch open release PRs from GitHub with 'Release' or 'Hotfix' in the title and base 'dev'.
 * Returns an array of headRefName strings sorted by semver in ascending order.
 *
 * @returns [release/v1.18.22, release/v1.18.23, release/v1.18.24] (sorted by semver)
 */
export const getReleasePRs = async (): Promise<string[]> => {
  try {
    const prs = await fetchAllReleasePRs()

    if (prs.length === 0) {
      logger.error('❌ No release PRs found. Check the project folder for the script. Exiting...')

      process.exit(1)
    }

    return sortVersions(
      prs.map((pr) => {
        return pr.headRefName
      }),
    )
  } catch (error) {
    logger.error({ error }, '❌ Error fetching release PRs')

    process.exit(1)
  }
}

/**
 * Fetch open release PRs with title info (for detecting release type).
 * Returns ReleasePRInfo objects sorted by semver.
 */
export const getReleasePRsWithInfo = async (): Promise<ReleasePRInfo[]> => {
  try {
    const prs = await fetchAllReleasePRs()

    if (prs.length === 0) {
      logger.error('❌ No release PRs found. Check the project folder for the script. Exiting...')
      process.exit(1)
    }

    const sortedBranches = sortVersions(
      prs.map((pr) => {
        return pr.headRefName
      }),
    )
    const prByBranch = new Map(
      prs.map((pr) => {
        return [pr.headRefName, pr]
      }),
    )

    return sortedBranches.map((branch) => {
      return {
        branch,
        title: prByBranch.get(branch)!.title,
      }
    })
  } catch (error) {
    logger.error({ error }, '❌ Error fetching release PRs')
    process.exit(1)
  }
}

interface CreateReleaseBranchArgs {
  version: string
  jiraVersionUrl: string
  type: ReleaseType
}

// Function to create a release branch
export const createReleaseBranch = async (
  args: CreateReleaseBranchArgs,
): Promise<{ branchName: string; prUrl: string }> => {
  const { version, jiraVersionUrl, type } = args
  const titlePrefix = type === 'hotfix' ? 'Hotfix' : 'Release'
  const baseBranch = getBaseBranch(type)

  const branchName = `release/v${version}`

  try {
    $.quiet = true

    await $`git switch ${baseBranch}`
    await $`git pull origin ${baseBranch}`
    await $`git checkout -b ${branchName}`
    await $`git push -u origin ${branchName}`
    await $`git commit --allow-empty-message --allow-empty --message ''`
    await $`git push origin ${branchName}`

    // Create PR and capture URL
    const prResult =
      await $`gh pr create --title "${titlePrefix} v${version}" --body "${jiraVersionUrl} \n" --base ${baseBranch} --head ${branchName}`

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
