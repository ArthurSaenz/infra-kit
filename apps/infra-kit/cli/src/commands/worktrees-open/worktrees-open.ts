import { z } from 'zod/v4'
import { $ } from 'zx'

import { buildCmuxWorkspaceTitle, listCmuxWorkspaceTitles, openCmuxWorkspaceWithLayout } from 'src/integrations/cmux'
import { reconcileCursorWorkspaceFolders, resolveCursorWorkspacePath } from 'src/integrations/cursor'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

interface WorktreesOpenResult {
  openedCmux: string[]
  skippedCmux: string[]
  cursorFoldersAdded: number
  cursorFoldersRemoved: number
}

/**
 * Cold-start restore command: reconciles `Main.code-workspace` against the set
 * of release worktrees on disk, opens Cursor against it, and ensures one cmux
 * workspace exists per worktree. Idempotent and additive — never removes
 * worktrees, never recreates running cmux workspaces.
 */
export const worktreesOpen = async () => {
  commandEcho.start('worktrees-open')

  try {
    const projectRoot = await getProjectRoot()
    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
    const currentBranches = await getCurrentWorktrees('release')

    const cursorOutcome = await openCursor({ projectRoot, worktreeDir, currentBranches })
    const cmuxOutcome = await openCmux({ worktreeDir, currentBranches })

    const result: WorktreesOpenResult = {
      openedCmux: cmuxOutcome.opened,
      skippedCmux: cmuxOutcome.skipped,
      cursorFoldersAdded: cursorOutcome.added,
      cursorFoldersRemoved: cursorOutcome.removed,
    }

    logResults(result, { cursorRan: cursorOutcome.ran, cmuxRan: cmuxOutcome.ran })

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

interface OpenCursorArgs {
  projectRoot: string
  worktreeDir: string
  currentBranches: string[]
}

interface OpenCursorOutcome {
  ran: boolean
  added: number
  removed: number
}

const openCursor = async (args: OpenCursorArgs): Promise<OpenCursorOutcome> => {
  const { projectRoot, worktreeDir, currentBranches } = args

  const config = await getInfraKitConfig()
  const cursorConfig = config.ide?.provider === 'cursor' ? config.ide.config : undefined

  if (!cursorConfig || cursorConfig.mode !== 'workspace' || !cursorConfig.workspaceConfigPath) {
    logger.warn('⚠️ Skipping Cursor: ide.provider must be "cursor", mode "workspace", and workspaceConfigPath set.')

    return { ran: false, added: 0, removed: 0 }
  }

  const workspacePath = resolveCursorWorkspacePath(cursorConfig.workspaceConfigPath, projectRoot)

  try {
    const { added, removed } = await reconcileCursorWorkspaceFolders({
      workspacePath,
      worktreeDir,
      currentBranches,
    })

    await $`cursor ${workspacePath}`

    return { ran: true, added: added.length, removed: removed.length }
  } catch (error) {
    logger.warn({ error }, `⚠️ Failed to reconcile/open Cursor workspace at ${workspacePath}`)

    return { ran: false, added: 0, removed: 0 }
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

const openCmux = async (args: OpenCmuxArgs): Promise<OpenCmuxOutcome> => {
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

    if (existingTitles.has(title)) {
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
  cursorRan: boolean
  cmuxRan: boolean
}

const logResults = (result: WorktreesOpenResult, context: LogResultsContext): void => {
  if (context.cursorRan) {
    if (result.cursorFoldersAdded > 0) {
      logger.info(`✅ Added ${result.cursorFoldersAdded} folder(s) to Cursor workspace`)
    }

    if (result.cursorFoldersRemoved > 0) {
      logger.info(`🧹 Removed ${result.cursorFoldersRemoved} dangling folder(s) from Cursor workspace`)
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
    !context.cursorRan &&
    result.openedCmux.length === 0 &&
    result.skippedCmux.length === 0 &&
    result.cursorFoldersAdded === 0 &&
    result.cursorFoldersRemoved === 0
  ) {
    logger.info('ℹ️ Nothing to open')
  }
}

// MCP Tool Registration
export const worktreesOpenMcpTool = defineMcpTool({
  name: 'worktrees-open',
  description:
    'Open Cursor against the configured workspace file and ensure a cmux workspace exists for each existing release worktree. Idempotent and additive — never removes worktrees, never recreates running cmux workspaces. Use after a cold start (Cursor + cmux closed). For stale-worktree cleanup, use worktrees-sync.',
  inputSchema: {},
  outputSchema: {
    openedCmux: z.array(z.string()).describe('Titles of cmux workspaces opened during this run'),
    skippedCmux: z.array(z.string()).describe('Titles of cmux workspaces that were already open'),
    cursorFoldersAdded: z.number().describe('Number of worktree folders added to the Cursor workspace file'),
    cursorFoldersRemoved: z
      .number()
      .describe('Number of dangling worktree folders removed from the Cursor workspace file'),
  },
  handler: worktreesOpen,
})
