import { z } from 'zod'

import {
  buildCmuxWorkspaceTitle,
  canonicalizeCmuxTitle,
  closeCmuxWorkspaceByTitle,
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

interface WorktreesReloadResult {
  closedCmux: string[]
  openedCmux: string[]
  ideProviders: IdeProvider[]
  ideFoldersAdded: number
  ideFoldersRemoved: number
}

/**
 * Reload command: closes every open cmux workspace for the release worktrees on
 * disk, then reopens the full set — cmux workspaces are recreated fresh and the
 * configured editor workspace is reconciled and relaunched. The single
 * window-restore command: also serves the cold-start case (editor + cmux closed),
 * at the cost of tearing down any live cmux windows first.
 *
 * The editor has no per-window close primitive, so its "reload" is a reconcile +
 * relaunch of the configured workspace. Safe to run from any branch
 * (non-destructive to git — only cmux/editor view state is touched).
 */
export const worktreesReload = async () => {
  commandEcho.start('worktrees-reload')

  try {
    const projectRoot = await getProjectRoot()
    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`
    const currentBranches = await getCurrentWorktrees('release')
    const repoName = await getRepoName()

    // Phase 1 — close (cmux only; Cursor has no per-window close).
    const closedCmux = await closeCmux({ currentBranches, repoName })

    // Phase 2 — reopen. cmux and Cursor are independent surfaces, so reopen them
    // concurrently to shrink the window where the just-closed cmux workspaces are gone.
    const [ideOutcomes, { opened: openedCmux }] = await Promise.all([
      openIdeWorkspace({ projectRoot, worktreeDir, currentBranches }),
      reopenCmux({ worktreeDir, currentBranches, repoName }),
    ])

    const result: WorktreesReloadResult = {
      closedCmux,
      openedCmux,
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
    })

    commandEcho.print()

    return {
      content: textContent(JSON.stringify(result, null, 2)),
      structuredContent: { ...result },
    }
  } catch (error) {
    logger.error({ error }, '❌ Error reloading worktrees')
    throw new OperationError(error, {
      operation: 'reload worktrees',
      remediation: "run 'worktrees-list' to confirm the branches exist",
    })
  }
}

interface CloseCmuxArgs {
  currentBranches: string[]
  repoName: string
}

/**
 * Close the cmux workspace for each release worktree that is currently open.
 * Snapshots `listCmuxWorkspaceTitles()` up front purely so the returned list
 * reflects which workspaces were actually open (the close itself is best-effort
 * and per-title). Returns the titles a close was attempted for.
 */
export const closeCmux = async (args: CloseCmuxArgs): Promise<string[]> => {
  const { currentBranches, repoName } = args

  if (currentBranches.length === 0) {
    return []
  }

  const openBefore = await listCmuxWorkspaceTitles()

  const closed: string[] = []

  for (const branch of currentBranches) {
    const title = buildCmuxWorkspaceTitle({ repoName, branch })

    // openBefore holds canonical keys; match the built title the same way so a
    // workspace stored under a drifted title (whitespace / old v-prefix) resolves.
    if (!openBefore.has(canonicalizeCmuxTitle(title))) {
      continue
    }

    await closeCmuxWorkspaceByTitle(title)
    closed.push(title)
  }

  return closed
}

interface ReopenCmuxArgs {
  worktreeDir: string
  currentBranches: string[]
  repoName: string
}

interface ReopenCmuxOutcome {
  opened: string[]
}

/**
 * Recreate a cmux workspace for every release worktree on disk. Force-opens each
 * branch (no dedup against the live workspace list): reload has just awaited the
 * close of these workspaces, so it favours liveness — guaranteeing every branch
 * ends up open.
 */
export const reopenCmux = async (args: ReopenCmuxArgs): Promise<ReopenCmuxOutcome> => {
  const { worktreeDir, currentBranches, repoName } = args

  const opened: string[] = []

  for (const branch of currentBranches) {
    const title = buildCmuxWorkspaceTitle({ repoName, branch })

    try {
      await openCmuxWorkspaceWithLayout({ cwd: `${worktreeDir}/${branch}`, title })
      opened.push(title)
    } catch (error) {
      logger.warn({ error, title }, `⚠️ Failed to reopen cmux workspace for ${branch}`)
    }
  }

  return { opened }
}

interface LogResultsContext {
  ideRan: boolean
}

const logResults = (result: WorktreesReloadResult, context: LogResultsContext): void => {
  if (result.closedCmux.length > 0) {
    logger.info(`🧹 Closed ${result.closedCmux.length} cmux workspace(s)`)
  }

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
    logger.info('✅ Reopened cmux workspaces:')
    for (const title of result.openedCmux) {
      logger.info(title)
    }
  }

  if (
    !context.ideRan &&
    result.closedCmux.length === 0 &&
    result.openedCmux.length === 0 &&
    result.ideFoldersAdded === 0 &&
    result.ideFoldersRemoved === 0
  ) {
    logger.info('ℹ️ Nothing to reload')
  }
}

// MCP Tool Registration
export const worktreesReloadMcpTool = defineMcpTool({
  name: 'worktrees-reload',
  description:
    'Close all open cmux workspaces for the current release worktrees, then reopen the full set — the single window-restore command. Every configured editor (Cursor and/or Zed) is reconciled + relaunched (no per-window close). Disruptive: closes live cmux windows first. Safe to run from any branch. Use to refresh stale windows or to restore everything after a cold start (editor + cmux closed).',
  inputSchema: {},
  outputSchema: {
    closedCmux: z.array(z.string()).describe('Titles of cmux workspaces a close was attempted for (best-effort)'),
    openedCmux: z.array(z.string()).describe('Titles of cmux workspaces reopened during this run'),
    ideProviders: z
      .array(z.string())
      .describe('Configured IDE providers that were reloaded (cursor | zed); empty if none configured'),
    ideFoldersAdded: z.number().describe('Total worktree folders added across all configured editor workspaces'),
    ideFoldersRemoved: z
      .number()
      .describe('Total dangling worktree folders removed across all configured editor workspaces'),
  },
  handler: worktreesReload,
})
