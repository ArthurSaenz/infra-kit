import { z } from 'zod'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { logger } from 'src/lib/logger'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import { formatVersionLabel, getJiraVersionInfo } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'

/**
 * List all open release branches
 */
export const ghReleaseList = async () => {
  const releasePRs = await getReleasePRsWithInfo()

  // Skip branches that do not parse as release ids (lenient discovery source).
  const releases = releasePRs.flatMap((pr) => {
    const id = parseBranchName(pr.branch)

    if (!id) return []

    return [
      {
        // Human display label: `1.2.3` | `<name>`.
        version: displayLabel(id),
        // Jira version-info map is keyed by the Jira version NAME (`v1.2.3` | `<name>`).
        jiraKey: formatJiraName(id),
        type: pr.type,
        titleMismatch: pr.titleMismatch,
      },
    ]
  })

  const jiraVersions = await getJiraVersionInfo()

  const maxVersionLength = Math.max(
    ...releases.map((r) => {
      return r.version.length
    }),
  )

  const formattedLines = releases.map((release) => {
    const label = formatVersionLabel(release.version, release.type, maxVersionLength)
    const jira = jiraVersions.get(release.jiraKey)
    const description = jira?.description ? `  ${jira.description}` : ''
    const shipsOn = jira?.releaseDate ? ` · ships ${jira.releaseDate}` : ''
    // The title lied about the type at least once (`releaseTypeFromBase` won); flag it so a human
    // reading the list catches the same retitle a machine caller sees in `titleMismatch`.
    const mismatchMarker = release.titleMismatch ? ' ⚠ title/base mismatch' : ''

    return `${label}${description}${shipsOn}${mismatchMarker}`
  })

  logger.info('All release branches: \n')
  logger.info(`\n${formattedLines.join('\n')}\n`)

  const structuredContent = {
    releases: releases.map((release) => {
      return {
        version: release.version,
        type: release.type,
        description: jiraVersions.get(release.jiraKey)?.description ?? null,
        releaseDate: jiraVersions.get(release.jiraKey)?.releaseDate ?? null,
        titleMismatch: release.titleMismatch,
      }
    }),
    count: releases.length,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

// MCP Tool Registration
export const ghReleaseListMcpTool = defineMcpTool({
  name: 'gh-release-list',
  description:
    'List every open release PR with its version, type (regular / hotfix), and the associated Jira fix version’s description and planned release date. Read-only; sourced from GitHub and Jira.',
  inputSchema: {},
  outputSchema: {
    releases: z
      .array(
        z.object({
          version: z.string().describe('Release version'),
          type: z.enum(['regular', 'hotfix']).describe('Release type'),
          description: z.string().nullable().describe('Jira version description'),
          releaseDate: z.string().nullable().describe('Planned release date of the Jira version (yyyy-mm-dd)'),
          titleMismatch: z.boolean().describe('The PR title names a different release type than its base branch'),
        }),
      )
      .describe('List of all release branches'),
    count: z.number().describe('Number of release branches'),
  },
  handler: ghReleaseList,
})
