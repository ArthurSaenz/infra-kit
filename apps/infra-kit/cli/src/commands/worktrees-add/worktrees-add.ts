/* eslint-disable sonarjs/cognitive-complexity */
import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import {
  buildCmuxWorkspaceTitle,
  canonicalizeCmuxTitle,
  listCmuxWorkspaceTitles,
  openCmuxWorkspaceWithLayout,
} from 'src/integrations/cmux'
import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { IDE_MODES, addIdeWorktreeFolders } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import { commandEcho } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { formatBranchName, isReleaseBranch, parseReleaseRef } from 'src/lib/release-id'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions, releaseBranchLabels } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

// Constants
const FEATURE_DIR = 'feature'
const RELEASE_DIR = 'release'

interface WorktreeManagementArgs extends RequiredConfirmedOptionArg {
  all?: boolean
  versions?: string
  ide?: IdeMode
  /** @deprecated Alias for `ide`, kept for back-compat. Ignored when `ide` is set. */
  cursor?: IdeMode
  githubDesktop?: boolean
  cmux?: boolean
}

/**
 * Manage git worktrees for release branches
 * Creates worktrees for active release branches and removes unused ones
 */
export const worktreesAdd = async (options: WorktreeManagementArgs) => {
  const { confirmedCommand, all, versions, githubDesktop, cmux } = options
  // `cursor` is the deprecated alias for `ide`; `ide` wins when both are present.
  const ide = options.ide ?? options.cursor

  commandEcho.start('worktrees-add')

  await assertManagementContext({ operation: 'create worktrees', requiredBranch: 'dev' })

  try {
    const currentWorktrees = await getCurrentWorktrees('release')
    const projectRoot = await getProjectRoot()

    const worktreeDir = `${projectRoot}${WORKTREES_DIR_SUFFIX}`

    await ensureWorktreeDirectory(`${worktreeDir}/${RELEASE_DIR}`)
    await ensureWorktreeDirectory(`${worktreeDir}/${FEATURE_DIR}`)

    let selectedReleaseBranches: string[] = []

    if (versions) {
      selectedReleaseBranches = versions.split(',').map((v) => {
        return formatBranchName(parseReleaseRef(v.trim()))
      })
    } else {
      const releasePRsInfo = await getReleasePRsWithInfo()

      const releasePRsList = releasePRsInfo.map((pr) => {
        return pr.branch
      })

      if (releasePRsList.length === 0) {
        logger.info('ℹ️ No open release branches found')

        commandEcho.print()

        return {
          content: textContent(JSON.stringify({ createdWorktrees: [], count: 0 }, null, 2)),
          structuredContent: { createdWorktrees: [], count: 0 },
        }
      }

      if (all) {
        selectedReleaseBranches = releasePRsList
      } else {
        commandEcho.setInteractive()

        const releaseTypes = new Map<string, ReleaseType>(
          releasePRsInfo.map((pr) => {
            return [pr.branch, detectReleaseType(pr.title)]
          }),
        )

        const descriptions = await getJiraDescriptions()

        selectedReleaseBranches = await checkbox({
          required: true,
          message: '🌿 Select release branches',
          choices: formatBranchChoices({ branches: releasePRsList, descriptions, types: releaseTypes }),
        })
      }
    }

    // Track --all flag if all branches were selected (either via flag or interactively)
    if (all) {
      commandEcho.addOption('--all', true)
    } else {
      commandEcho.addOption('--versions', releaseBranchLabels(selectedReleaseBranches))
    }

    // Ask for confirmation
    const answer = confirmedCommand
      ? true
      : await confirm({
          message: 'Are you sure you want to proceed with these worktree changes?',
        })

    if (!confirmedCommand) {
      commandEcho.setInteractive()
    }

    if (!answer) {
      logger.info('Operation cancelled. Exiting...')
      process.exit(0)
    }

    // Track --yes flag if confirmation was interactive (user confirmed)
    if (!confirmedCommand) {
      commandEcho.addOption('--yes', true)
    }

    const config = await getInfraKitConfig()

    // One attach style: every configured editor gets the worktrees added to its
    // workspace. Per-run skip is `--ide none` / `--no-ide`; no editor configured
    // means there's nothing to open.
    const ideMode: IdeMode = ide ?? (resolveConfiguredIdes(config).length > 0 ? 'workspace' : 'none')

    commandEcho.addOption('--ide', ideMode)

    const openInGithubDesktop =
      githubDesktop ??
      config.worktrees?.openInGithubDesktop ??
      (await confirm({ message: 'Open created worktrees in GitHub Desktop?' }))

    if (typeof githubDesktop === 'undefined' && config.worktrees?.openInGithubDesktop === undefined) {
      commandEcho.setInteractive()
    }

    if (openInGithubDesktop) {
      commandEcho.addOption('--github-desktop', true)
    } else {
      commandEcho.addOption('--no-github-desktop', true)
    }

    const openInCmux =
      cmux ?? config.worktrees?.openInCmux ?? (await confirm({ message: 'Open created worktrees in cmux?' }))

    if (typeof cmux === 'undefined' && config.worktrees?.openInCmux === undefined) {
      commandEcho.setInteractive()
    }

    if (openInCmux) {
      commandEcho.addOption('--cmux', true)
    } else {
      commandEcho.addOption('--no-cmux', true)
    }

    const { branchesToCreate } = categorizeWorktrees({
      selectedReleaseBranches,
      currentWorktrees,
    })

    const createdWorktrees = await createWorktrees(branchesToCreate, worktreeDir)

    logResults(createdWorktrees)

    if (ideMode === 'workspace') {
      await addIdeWorktreeFolders({ projectRoot, worktreeDir, branches: createdWorktrees })
    }

    if (openInGithubDesktop) {
      for (const branch of createdWorktrees) {
        await $`github ${worktreeDir}/${branch}`
        await $`sleep 5`
      }
    }

    if (openInCmux) {
      const repoName = await getRepoName()
      const existingTitles = await listCmuxWorkspaceTitles()

      for (const branch of createdWorktrees) {
        const title = buildCmuxWorkspaceTitle({ repoName, branch })

        // Skip branches whose cmux workspace is already open (canonical match),
        // so re-running worktrees-add never duplicates an existing workspace.
        if (existingTitles.has(canonicalizeCmuxTitle(title))) {
          continue
        }

        await openCmuxWorkspaceWithLayout({
          cwd: `${worktreeDir}/${branch}`,
          title,
        })
      }
    }

    commandEcho.print()

    const structuredContent = {
      createdWorktrees,
      count: createdWorktrees.length,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  } catch (error) {
    logger.error({ error }, '❌ Error managing worktrees')
    throw new OperationError(error, {
      operation: 'create worktrees',
      remediation: "verify branches don't already exist as worktrees: 'git worktree list'",
    })
  }
}

/**
 * Ensure the worktree directory exists
 */
const ensureWorktreeDirectory = async (worktreeDir: string): Promise<void> => {
  await $`mkdir -p ${worktreeDir}`
}

interface CategorizeWorktreesArgs {
  selectedReleaseBranches: string[]
  currentWorktrees: string[]
}

/**
 * Categorize release worktrees into those that need to be created or removed
 */
const categorizeWorktrees = (args: CategorizeWorktreesArgs): { branchesToCreate: string[] } => {
  const { selectedReleaseBranches, currentWorktrees } = args

  const currentBranchNames = currentWorktrees.filter((branch) => {
    return isReleaseBranch(branch)
  })

  const branchesToCreate = selectedReleaseBranches.filter((branch) => {
    return !currentBranchNames.includes(branch)
  })

  return { branchesToCreate }
}

/**
 * Create worktrees for the specified branches
 */
const createWorktrees = async (branches: string[], worktreeDir: string): Promise<string[]> => {
  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const worktreePath = `${worktreeDir}/${branch}`

      await $`git worktree add ${worktreePath} ${branch}`
      await $({ cwd: worktreePath })`pnpm install`

      return branch
    }),
  )

  const created: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      created.push(result.value)
    } else {
      const branch = branches[index]
      const err = new OperationError(result.reason, {
        operation: `git worktree add for ${branch}`,
        remediation: 'check the branch name and that the parent dir is writable',
      })

      logger.error({ error: result.reason, msg: err.message })
    }
  }

  return created
}

/**
 * Log the results of worktree management
 */
const logResults = (created: string[]): void => {
  if (created.length > 0) {
    logger.info('✅ Created git worktrees:')
    for (const branch of created) {
      logger.info(branch)
    }
    logger.info('')
  } else {
    logger.info('ℹ️ No new git worktrees to create')
  }
}

// MCP Tool Registration
export const worktreesAddMcpTool = defineMcpTool({
  name: 'worktrees-add',
  description:
    'Create local git worktrees for release branches under the worktrees directory and run "pnpm install" in each. Mutates the local filesystem. When invoked via MCP, pass either "versions" (comma-separated) or all=true — the branch picker and "open in Cursor / GitHub Desktop / cmux" follow-up prompts are unreachable without a TTY, and the CLI confirmation is auto-skipped for MCP calls.',
  inputSchema: {
    all: z
      .boolean()
      .optional()
      .describe(
        'Add worktrees for every open release branch. Either "all" or "versions" must be provided for MCP calls (the interactive picker is unavailable without a TTY). Ignored if "versions" is provided.',
      ),
    versions: z
      .string()
      .optional()
      .describe(
        'Comma-separated release versions or names to target (e.g. "1.2.5, 1.2.6" or "checkout-redesign, 1.2.5"). Either "versions" or all=true must be provided for MCP calls. Overrides "all" when set.',
      ),
    ide: z
      .enum(IDE_MODES)
      .optional()
      .describe(
        'Editor open mode for created worktrees, applied to all configured editors (Cursor and/or Zed, per the "ide" config). "workspace" (the only attach style) adds each worktree to every configured editor workspace and opens it. "none" skips the editor. Resolution order: this flag → "workspace" when at least one "ide" is configured → "none" otherwise.',
      ),
    cursor: z
      .enum(IDE_MODES)
      .optional()
      .describe('Deprecated alias for "ide". Prefer "ide". Ignored when "ide" is provided.'),
    githubDesktop: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in GitHub Desktop. Resolution order: this flag → "worktrees.openInGithubDesktop" from infra-kit config → interactive prompt (CLI) / false (MCP, no TTY).',
      ),
    cmux: z
      .boolean()
      .optional()
      .describe(
        'Open each created worktree in a new cmux workspace with a 3-pane layout (left-top, left-bottom, full-height right), all rooted at the worktree directory. Resolution order: this flag → "worktrees.openInCmux" from infra-kit config → interactive prompt (CLI) / false (MCP, no TTY).',
      ),
  },
  outputSchema: {
    createdWorktrees: z.array(z.string()).describe('List of created git worktree branches'),
    count: z.number().describe('Number of git worktrees created'),
  },
  handler: worktreesAdd,
})
