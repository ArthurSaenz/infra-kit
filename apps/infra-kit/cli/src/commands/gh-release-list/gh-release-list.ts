import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatVersionLabel, getJiraDescriptions } from 'src/lib/release-utils'
import type { ToolsExecutionResult } from 'src/types'

/**
 * List all open release branches
 */
export const ghReleaseList = async (): Promise<ToolsExecutionResult> => {
  const releasePRs = await getReleasePRsWithInfo()

  const releases = releasePRs.map((pr) => {
    return {
      version: pr.branch.replace('release/', ''),
      type: detectReleaseType(pr.title),
    }
  })

  const jiraDescriptions = await getJiraDescriptions()

  const maxVersionLength = Math.max(
    ...releases.map((r) => {
      return r.version.length
    }),
  )

  const formattedLines = releases.map((release) => {
    const label = formatVersionLabel(release.version, release.type, maxVersionLength)
    const description = jiraDescriptions.get(release.version)

    if (description) {
      return `${label}  ${description}`
    }

    return label
  })

  logger.info('All release branches: \n')
  logger.info(`\n${formattedLines.join('\n')}\n`)

  const structuredContent = {
    releases: releases.map((release) => {
      return {
        version: release.version,
        type: release.type,
        description: jiraDescriptions.get(release.version) || null,
      }
    }),
    count: releases.length,
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

// MCP Tool Registration
export const ghReleaseListMcpTool = {
  name: 'gh-release-list',
  description:
    'List every open release PR with its version, type (regular / hotfix), and associated Jira fix-version description. Read-only; sourced from GitHub and Jira.',
  inputSchema: {},
  outputSchema: {
    releases: z
      .array(
        z.object({
          version: z.string().describe('Release version'),
          type: z.enum(['regular', 'hotfix']).describe('Release type'),
          description: z.string().nullable().describe('Jira version description'),
        }),
      )
      .describe('List of all release branches'),
    count: z.number().describe('Number of release branches'),
  },
  handler: ghReleaseList,
}
