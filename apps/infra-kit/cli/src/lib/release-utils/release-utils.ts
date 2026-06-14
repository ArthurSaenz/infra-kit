import { $ } from 'zx'

import { createReleaseBranch } from 'src/integrations/gh'
import { createJiraVersion, getProjectVersions, loadJiraConfigOptional } from 'src/integrations/jira'
import type { JiraConfig } from 'src/integrations/jira'
import { OperationError } from 'src/lib/errors/operation-error'
import { displayLabel, formatBranchName, formatJiraName, parseBranchName, parseReleaseRef } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'

/** Sentinel ref for deploying from the `dev` branch instead of a release branch. */
export const DEV_REF = 'dev'

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
  id: ReleaseId
  jiraConfig: JiraConfig
  description?: string
  type?: ReleaseType
}

/**
 * Create a single release by creating both Jira version and GitHub release branch
 */
export const createSingleRelease = async (args: CreateSingleReleaseArgs): Promise<ReleaseCreationResult> => {
  const { id, jiraConfig, description, type = 'regular' } = args
  // 1. Create Jira version (mandatory). For versioned releases this is
  // "v1.2.3" (byte-identical to before); for named releases it is "<name>".
  const versionName = formatJiraName(id)

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
  const releaseInfo = await createReleaseBranch({ id, jiraVersionUrl, type, description })

  return {
    version: displayLabel(id),
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

interface ParsedBranchChoice {
  branch: string
  id: ReleaseId
  /** Human display label: `1.2.3` | `<name>`. */
  label: string
}

/**
 * Parse branches into release ids, dropping any that do not parse (lenient
 * discovery source). Exported for unit testing the version/name/junk split.
 */
export const parseBranchChoices = (branches: string[]): ParsedBranchChoice[] => {
  return branches.flatMap((branch) => {
    const id = parseBranchName(branch)

    if (!id) return []

    return [{ branch, id, label: displayLabel(id) }]
  })
}

/**
 * Resolve an operator-supplied release ref (version `1.2.3` / `v1.2.3` or name
 * `checkout-redesign`) to its branch name (`release/v1.2.3` | `release/n/<name>`).
 * Strict: surfaces a parse failure as an OperationError with remediation text.
 */
export const resolveReleaseBranch = (versionArg: string): string => {
  try {
    return formatBranchName(parseReleaseRef(versionArg))
  } catch (error) {
    throw new OperationError(error, {
      operation: `resolve release ref "${versionArg}"`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
    })
  }
}

/**
 * Render the human display label for a release branch. Returns the `dev`
 * sentinel unchanged; otherwise derives `1.2.3` | `<name>` from the branch.
 * Falls back to the raw branch when it does not parse as a release id.
 */
export const releaseLabelFromBranch = (branch: string): string => {
  if (branch === DEV_REF) return DEV_REF

  const id = parseBranchName(branch)

  return id ? displayLabel(id) : branch
}

/**
 * Render human display labels for a list of release branches, dropping any
 * branch that does not parse as a release id (lenient discovery contract).
 */
export const releaseBranchLabels = (branches: string[]): string[] => {
  return branches.flatMap((branch) => {
    const id = parseBranchName(branch)

    return id ? [displayLabel(id)] : []
  })
}

/**
 * Format release branch names as checkbox choices with aligned type tags and Jira descriptions
 */
export const formatBranchChoices = (args: FormatBranchChoicesArgs): { name: string; value: string }[] => {
  const { branches, descriptions, types } = args

  const parsed = parseBranchChoices(branches)

  const maxLen = Math.max(
    0,
    ...parsed.map((p) => {
      return p.label.length
    }),
  )

  return parsed.map(({ branch, id, label }) => {
    const type = types ? types.get(branch) || 'regular' : undefined
    // Jira-descriptions map is keyed by the Jira version NAME (`v1.2.3` | `<name>`).
    const desc = descriptions.get(formatJiraName(id))
    const padding = ' '.repeat(maxLen - label.length + 3)

    let name = type ? formatVersionLabel(label, type, maxLen) : label

    if (desc) {
      name = type ? `${name}  ${desc}` : `${label}${padding}${desc}`
    }

    return { name, value: branch }
  })
}
