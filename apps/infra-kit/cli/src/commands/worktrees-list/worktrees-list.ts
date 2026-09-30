import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { getCurrentWorktrees } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import { formatVersionLabel, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'

interface WorktreeInfo {
  version: string
  type: ReleaseType
  description: string | null
}

/**
 * List release git worktrees (version, type, Jira description) and feature git worktrees
 */
export const worktreesList = async () => {
  // GUARD (placement is load-bearing): `git worktree list` answers in ANY repo, so without this the
  // release-branch filter renders a generic-git empty set as the infra-kit fact "No active worktrees
  // found" — a false statement in a stranger's repo. Must stay ABOVE `getCurrentWorktrees`.
  await getInfraKitConfig()

  const [currentWorktrees, features] = await Promise.all([
    getCurrentWorktrees('release'),
    getCurrentWorktrees('feature'),
  ])

  if (currentWorktrees.length === 0 && features.length === 0) {
    logger.info('ℹ️ No active worktrees found')

    const empty = { worktrees: [], count: 0, features: [] }

    return {
      content: textContent(JSON.stringify(empty, null, 2)),
      structuredContent: empty,
    }
  }

  const worktrees = currentWorktrees.length > 0 ? await describeReleaseWorktrees(currentWorktrees) : []
  const sections: string[] = []

  if (worktrees.length > 0) sections.push(`🌿 Active worktrees:\n\n${formatReleaseLines(worktrees).join('\n')}`)
  if (features.length > 0) sections.push(`🧪 Feature worktrees:\n\n${features.join('\n')}`)

  // One record, no trailing newline. Two calls made pino-pretty emit a bare `INFO:` line for the
  // leading `\n`, and the trailing one stacked a second blank line under the list — which, in the
  // session shell, collided with the blank line the transcript footer already writes above itself.
  logger.info(sections.join('\n\n'))

  const structuredContent = {
    worktrees,
    count: worktrees.length,
    features,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const describeReleaseWorktrees = async (currentWorktrees: string[]): Promise<WorktreeInfo[]> => {
  const [releasePRsInfo, jiraDescriptions] = await Promise.all([getReleasePRsWithInfo(), getJiraDescriptions()])

  const releaseTypes = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, pr.type]
    }),
  )

  // Skip worktrees whose branch does not parse as a release id (lenient source).
  return currentWorktrees.flatMap((branch) => {
    const id = parseBranchName(branch)

    if (!id) return []

    // Human label `1.2.3` | `<name>`; Jira-descriptions map is keyed by the
    // Jira version NAME (`v1.2.3` | `<name>`) — same split as formatBranchChoices.
    const version = displayLabel(id)
    const type = releaseTypes.get(branch) || 'regular'
    const description = jiraDescriptions.get(formatJiraName(id)) || null

    return [{ version, type, description }]
  })
}

const formatReleaseLines = (worktrees: WorktreeInfo[]): string[] => {
  const maxVersionLength = Math.max(
    ...worktrees.map((w) => {
      return w.version.length
    }),
  )

  return worktrees.map((worktree) => {
    const label = formatVersionLabel(worktree.version, worktree.type, maxVersionLength)

    if (worktree.description) {
      return `${label}  ${worktree.description}`
    }

    return label
  })
}

// MCP Tool Registration
export const worktreesListMcpTool = defineMcpTool({
  name: 'worktrees-list',
  description:
    'List existing release-branch worktrees with version, release type (regular / hotfix), and Jira fix-version description, plus feature worktrees (feature/* branches). Read-only.',
  inputSchema: {},
  outputSchema: {
    worktrees: z
      .array(
        z.object({
          version: z.string().describe('Release version'),
          type: z.enum(['regular', 'hotfix']).describe('Release type'),
          description: z.string().nullable().describe('Jira version description'),
        }),
      )
      .describe('Release worktrees with details'),
    count: z.number().describe('Number of release worktrees'),
    features: z.array(z.string()).describe('Branches of feature worktrees (feature/<name>)'),
  },
  handler: worktreesList,
})
