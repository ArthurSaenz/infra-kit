import { $ } from 'zx'

import { createReleaseBranch } from 'src/integrations/gh'
import { createJiraVersion, getProjectVersions, loadJiraConfigOptional } from 'src/integrations/jira'
import type { JiraConfig } from 'src/integrations/jira'

export type ReleaseType = 'regular' | 'hotfix'

/**
 * Get the base branch for a release type.
 * Regular releases branch from/to dev, hotfixes branch from/to main.
 */
export const getBaseBranch = (type: ReleaseType): string => {
  return type === 'hotfix' ? 'main' : 'dev'
}

export interface ReleaseCreationResult {
  version: string
  type: ReleaseType
  branchName: string
  prUrl: string
  jiraVersionUrl: string
}

/**
 * Prepare git repository for release creation
 * Fetches latest changes, switches to base branch, and pulls latest
 */
export const prepareGitForRelease = async (type: ReleaseType = 'regular'): Promise<void> => {
  const baseBranch = getBaseBranch(type)

  $.quiet = true

  await $`git fetch origin`
  await $`git switch ${baseBranch}`
  await $`git pull origin ${baseBranch}`

  $.quiet = false
}

interface CreateSingleReleaseArgs {
  version: string
  jiraConfig: JiraConfig
  description?: string
  type?: ReleaseType
}

/**
 * Create a single release by creating both Jira version and GitHub release branch
 */
export const createSingleRelease = async (args: CreateSingleReleaseArgs): Promise<ReleaseCreationResult> => {
  const { version, jiraConfig, description, type = 'regular' } = args
  // 1. Create Jira version (mandatory)
  const versionName = `v${version}`

  const result = await createJiraVersion(
    {
      name: versionName,
      projectId: jiraConfig.projectId,
      description: description || '',
      released: false,
      archived: false,
    },
    jiraConfig,
  )

  // Construct user-friendly Jira URL using project key from API response
  const jiraVersionUrl = `${jiraConfig.baseUrl}/projects/${result.version!.projectId}/versions/${result.version!.id}/tab/release-report-all-issues`

  // 2. Create GitHub release branch
  const releaseInfo = await createReleaseBranch({ version, jiraVersionUrl, type })

  return {
    version,
    type,
    branchName: releaseInfo.branchName,
    prUrl: releaseInfo.prUrl,
    jiraVersionUrl,
  }
}

/**
 * Fetch Jira version descriptions mapped by version name (e.g., "v1.2.5" → "Some description")
 * Gracefully returns empty map if Jira is unavailable
 */
export const getJiraDescriptions = async (): Promise<Map<string, string>> => {
  const descriptions = new Map<string, string>()

  const jiraConfig = await loadJiraConfigOptional()

  if (!jiraConfig) return descriptions

  try {
    const versions = await getProjectVersions(jiraConfig)

    for (const version of versions) {
      if (version.description) {
        descriptions.set(version.name, version.description)
      }
    }
  } catch {
    // Jira fetch failed, continue without descriptions
  }

  return descriptions
}

/**
 * Format a version string with its release type tag, e.g. "1.2.5   [regular]"
 * When maxVersionLength is provided, pads the version for alignment.
 */
export const formatVersionLabel = (version: string, type: ReleaseType, maxVersionLength?: number): string => {
  const padding = maxVersionLength ? ' '.repeat(maxVersionLength - version.length + 3) : '   '
  const tag = `[${type}]`.padEnd(11)

  return `${version}${padding}${tag}`
}

/**
 * Detect release type from PR title.
 * PRs titled "Hotfix v..." are hotfix, everything else is regular.
 */
export const detectReleaseType = (title: string): ReleaseType => {
  return title.toLowerCase().startsWith('hotfix') ? 'hotfix' : 'regular'
}

interface FormatBranchChoicesArgs {
  branches: string[]
  descriptions: Map<string, string>
  types?: Map<string, ReleaseType>
}

/**
 * Format release branch names as checkbox choices with aligned type tags and Jira descriptions
 */
export const formatBranchChoices = (args: FormatBranchChoicesArgs): { name: string; value: string }[] => {
  const { branches, descriptions, types } = args

  const versionNames = branches.map((b) => {
    return b.replace('release/v', '')
  })

  const maxLen = Math.max(
    ...versionNames.map((v) => {
      return v.length
    }),
  )

  return branches.map((branch, i) => {
    const version = versionNames[i] as string
    const type = types ? types.get(branch) || 'regular' : undefined
    const desc = descriptions.get(`v${version}`)
    const padding = ' '.repeat(maxLen - version.length + 3)

    let name = type ? formatVersionLabel(version, type, maxLen) : version

    if (desc) {
      name = type ? `${name}  ${desc}` : `${version}${padding}${desc}`
    }

    return { name, value: branch }
  })
}
