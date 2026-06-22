import { z } from 'zod'

import {
  buildCmuxWorkspaceTitle,
  canonicalizeCmuxTitle,
  listCmuxWorkspaceTitles,
  openCmuxWorkspaceWithLayout,
} from 'src/integrations/cmux'
import { ideProviderLabel, openIdeWorkspace } from 'src/integrations/ide'
import type { IdeProvider } from 'src/integrations/ide'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

interface WorktreesOpenResult {
  openedCmux: string[]
  skippedCmux: string[]
  ideProviders: IdeProvider[]
  ideFoldersAdded: number
  ideFoldersRemoved: number
}

/**
 * Cold-start restore command: reconciles the configured editor workspace against
 * the set of release worktrees on disk, opens the editor against it, and ensures
 * one cmux workspace exists per worktree. Idempotent and additive — never removes
 * worktrees, never recreates running cmux workspaces.
 */
export const worktreesOpen = async () => {
  commandEcho.start('worktrees-open')

  try {
    const projectRoot = await getProjectRoot()
    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
    const currentBranches = await getCurrentWorktrees('release')

    const ideOutcomes = await openIdeWorkspace({
      projectRoot,
      worktreeDir,
      currentBranches,
      skipRelaunchWhenEmpty: false,
    })
    const cmuxOutcome = await openCmux({ worktreeDir, currentBranches })

    const result: WorktreesOpenResult = {
      openedCmux: cmuxOutcome.opened,
      skippedCmux: cmuxOutcome.skipped,
      ideProviders: ideOutcomes
        .filter((outcome) => {
          return outcome.ran
        })
        .map((outcome) => {
          return outcome.provider
        }),
      ideFoldersAdded: ideOutcomes.reduce((sum, outcome) => {
        return sum + outcome.added
      }, 0),
      ideFoldersRemoved: ideOutcomes.reduce((sum, outcome) => {
        return sum + outcome.removed
      }, 0),
    }

    logResults(result, {
      ideRan: ideOutcomes.some((outcome) => {
        return outcome.ran
      }),
      cmuxRan: cmuxOutcome.ran,
    })

    commandEcho.print()

    return {
      content: textContent(JSON.stringify(result, null, 2)),
      structuredContent: { ...result },
    }
  } catch (error) {
    logger.error({ error }, '❌ Error opening worktrees')
    throw new OperationError(error, {
      operation: 'open worktrees',
      remediation: "run 'worktrees-list' to confirm the branches exist",
    })
  }
}

interface OpenCmuxArgs {
  worktreeDir: string
  currentBranches: string[]
}

interface OpenCmuxOutcome {
  ran: boolean
  opened: string[]
  skipped: string[]
}

export const openCmux = async (args: OpenCmuxArgs): Promise<OpenCmuxOutcome> => {
  const { worktreeDir, currentBranches } = args

  if (currentBranches.length === 0) {
    return { ran: true, opened: [], skipped: [] }
  }

  const repoName = await getRepoName()
  const existingTitles = await listCmuxWorkspaceTitles()

  const opened: string[] = []
  const skipped: string[] = []

  for (const branch of currentBranches) {
    const title = buildCmuxWorkspaceTitle({ repoName, branch })

    // existingTitles holds canonical keys; match the built title the same way so
    // dedup survives whitespace / cross-CLI-version title drift (no duplicates).
    if (existingTitles.has(canonicalizeCmuxTitle(title))) {
      skipped.push(title)
      continue
    }

    try {
      await openCmuxWorkspaceWithLayout({ cwd: `${worktreeDir}/${branch}`, title })
      opened.push(title)
    } catch (error) {
      logger.warn({ error, title }, `⚠️ Failed to open cmux workspace for ${branch}`)
    }
  }

  return { ran: true, opened, skipped }
}

interface LogResultsContext {
  ideRan: boolean
  cmuxRan: boolean
}

const logResults = (result: WorktreesOpenResult, context: LogResultsContext): void => {
  if (context.ideRan) {
    const ideLabels = result.ideProviders
      .map((provider) => {
        return ideProviderLabel(provider)
      })
      .join(', ')

    if (result.ideFoldersAdded > 0) {
      logger.info(`✅ Added ${result.ideFoldersAdded} folder(s) to ${ideLabels} workspace(s)`)
    }

    if (result.ideFoldersRemoved > 0) {
      logger.info(`🧹 Removed ${result.ideFoldersRemoved} dangling folder(s) from ${ideLabels} workspace(s)`)
    }
  }

  if (result.openedCmux.length > 0) {
    logger.info('✅ Opened cmux workspaces:')
    for (const title of result.openedCmux) {
      logger.info(title)
    }
  }

  if (result.skippedCmux.length > 0) {
    logger.info(`ℹ️ Skipped ${result.skippedCmux.length} cmux workspace(s) already open`)
  }

  if (
    !context.ideRan &&
    result.openedCmux.length === 0 &&
    result.skippedCmux.length === 0 &&
    result.ideFoldersAdded === 0 &&
    result.ideFoldersRemoved === 0
  ) {
    logger.info('ℹ️ Nothing to open')
  }
}

// MCP Tool Registration
export const worktreesOpenMcpTool = defineMcpTool({
  name: 'worktrees-open',
  description:
    'Open every configured editor (Cursor and/or Zed) against its workspace and ensure a cmux workspace exists for each existing release worktree. Idempotent and additive — never removes worktrees, never recreates running cmux workspaces. Use after a cold start (editor + cmux closed). For stale-worktree cleanup, use worktrees-sync.',
  inputSchema: {},
  outputSchema: {
    openedCmux: z.array(z.string()).describe('Titles of cmux workspaces opened during this run'),
    skippedCmux: z.array(z.string()).describe('Titles of cmux workspaces that were already open'),
    ideProviders: z
      .array(z.string())
      .describe('Configured IDE providers that were opened (cursor | zed); empty if none configured'),
    ideFoldersAdded: z.number().describe('Total worktree folders added across all configured editor workspaces'),
    ideFoldersRemoved: z
      .number()
      .describe('Total dangling worktree folders removed across all configured editor workspaces'),
  },
  handler: worktreesOpen,
})
