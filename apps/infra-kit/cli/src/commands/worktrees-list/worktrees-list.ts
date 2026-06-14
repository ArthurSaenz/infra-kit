import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { getCurrentWorktrees } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import { detectReleaseType, formatVersionLabel, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'

interface WorktreeInfo {
  version: string
  type: ReleaseType
  description: string | null
}

/**
 * List all release git worktrees with version, type, and Jira description
 */
export const worktreesList = async () => {
  const currentWorktrees = await getCurrentWorktrees('release')

  if (currentWorktrees.length === 0) {
    logger.info('ℹ️ No active worktrees found')

    return {
      content: textContent(JSON.stringify({ worktrees: [], count: 0 }, null, 2)),
      structuredContent: { worktrees: [], count: 0 },
    }
  }

  const [releasePRsInfo, jiraDescriptions] = await Promise.all([getReleasePRsWithInfo(), getJiraDescriptions()])

  const releaseTypes = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, detectReleaseType(pr.title)]
    }),
  )

  // Skip worktrees whose branch does not parse as a release id (lenient source).
  const worktrees: WorktreeInfo[] = currentWorktrees.flatMap((branch) => {
    const id = parseBranchName(branch)

    if (!id) return []

    // Human label `1.2.3` | `<name>`; Jira-descriptions map is keyed by the
    // Jira version NAME (`v1.2.3` | `<name>`) — same split as formatBranchChoices.
    const version = displayLabel(id)
    const type = releaseTypes.get(branch) || 'regular'
    const description = jiraDescriptions.get(formatJiraName(id)) || null

    return [{ version, type, description }]
  })

  // Log formatted output
  const maxVersionLength = Math.max(
    ...worktrees.map((w) => {
      return w.version.length
    }),
  )

  const formattedLines = worktrees.map((worktree) => {
    const label = formatVersionLabel(worktree.version, worktree.type, maxVersionLength)

    if (worktree.description) {
      return `${label}  ${worktree.description}`
    }

    return label
  })

  logger.info('🌿 Active worktrees:')
  logger.info(`\n${formattedLines.join('\n')}\n`)

  const structuredContent = {
    worktrees,
    count: worktrees.length,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const worktreesListMcpTool = defineMcpTool({
  name: 'worktrees-list',
  description:
    'List existing release-branch worktrees with version, release type (regular / hotfix), and Jira fix-version description. Read-only.',
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
      .describe('List of all worktrees with details'),
    count: z.number().describe('Number of worktrees'),
  },
  handler: worktreesList,
})
