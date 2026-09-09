/* eslint-disable sonarjs/cognitive-complexity */
import confirm from '@inquirer/confirm'
import path from 'node:path'
import { z } from 'zod'
import { $ } from 'zx'

import {
  buildCmuxWorkspaceTitle,
  createCmuxGroupFrom,
  findCmuxGroupRefByName,
  listCmuxWorkspacesByCwd,
  openCmuxWorkspaceWithLayout,
  realpathForCmuxCwd,
} from 'src/integrations/cmux'
import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { IDE_MODES, addIdeWorktreeFolders } from 'src/integrations/ide'
import type { IdeMode } from 'src/integrations/ide'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { OperationError } from 'src/lib/errors/operation-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { pickReleaseBranches } from 'src/lib/prompts/release-picker'
import { formatBranchName, isReleaseBranch, parseReleaseRef } from 'src/lib/release-id'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getJiraDescriptions,
  releaseBranchLabels,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

// Constants
const FEATURE_DIR = 'feature'
const RELEASE_DIR = 'release'

// The two optional follow-ups below declare `whenHeadless: { value: false }`, and that value is not
// a convenience — it is what `githubDesktop`/`cmux`'s own `.describe()` text already promises:
// "interactive prompt (CLI) / false (MCP, no TTY)". It was documented and never implemented. With
// neither the flag nor the config key set, an MCP call fell through to a real `@inquirer/confirm`,
// which writes to `process.stdout` — the JSON-RPC transport under MCP — corrupting the stream rather
// than hanging. This tool is ungated (`requiresHumanConfirm` is unset), so one call carrying
// `versions` or `all` reached both prompts: the happy path was the defect path.
//
// `{ value: false }` rather than `withEscape`'s `'refuse'` default, and the difference is the whole
// reason the policy is declared per site. Refusing here would be right-outcome-by-accident at best:
// it keeps the bytes out of the stream, but turns a documented harmless default into a hard failure
// and makes the tool unusable over MCP unless a caller passes both booleans explicitly.
//
// The guard lives in `withEscape` keyed on `isMcpMode()`, never `process.stdin.isTTY` —
// `commands/mcp/mcp.ts` spawns the server with `stdio: 'inherit'`, so a terminal-launched
// `infra-kit mcp` has a real TTY stdin and an isTTY-keyed guard would not fire. And never on
// `confirmedCommand`, which carries the CLI's `--yes` (`program.ts:109`): keying on that would stop
// `worktrees add --yes` prompting on a terminal, breaking the documented order in the CLI direction
// in order to fix it in the MCP one.

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

  // Branch-agnostic: `git worktree add` addresses branches by name and never
  // reads HEAD, so only the worktree + clean-tree legs apply.
  await assertManagementContext({ operation: 'create worktrees' })

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

        selectedReleaseBranches = await pickReleaseBranches(
          formatBranchPickerItems({ branches: releasePRsList, descriptions, types: releaseTypes }),
          { required: true },
        )
      }
    }

    // Track --all flag if all branches were selected (either via flag or interactively)
    if (all) {
      commandEcho.addOption('--all', true)
    } else {
      commandEcho.addOption('--versions', releaseBranchLabels(selectedReleaseBranches))
    }

    // Ask for confirmation
    await confirmOrExit(confirmedCommand, 'Are you sure you want to proceed with these worktree changes?')

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
      (await withEscape(
        (context) => {
          return confirm({ message: 'Open created worktrees in GitHub Desktop?' }, context)
        },
        { whenHeadless: { value: false } },
      ))

    if (typeof githubDesktop === 'undefined' && config.worktrees?.openInGithubDesktop === undefined) {
      commandEcho.setInteractive()
    }

    if (openInGithubDesktop) {
      commandEcho.addOption('--github-desktop', true)
    } else {
      commandEcho.addOption('--no-github-desktop', true)
    }

    const openInCmux =
      cmux ??
      config.worktrees?.openInCmux ??
      (await withEscape(
        (context) => {
          return confirm({ message: 'Open created worktrees in cmux?' }, context)
        },
        { whenHeadless: { value: false } },
      ))

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
      // Group name keys on the STABLE main-repo basename (not the worktree-local
      // `getRepoName()`), so every worktree of a repo lands in the same sidebar
      // group regardless of which checkout this runs from.
      const repoName = path.basename(await getMainRepoRoot(projectRoot))
      const openByCwd = await listCmuxWorkspacesByCwd()

      let groupRef = await findCmuxGroupRefByName(repoName)
      let bootstrapAttempted = false

      for (const branch of createdWorktrees) {
        const cwd = `${worktreeDir}/${branch}`

        // Skip branches whose cmux workspace is already open (matched by cwd, not
        // title), so re-running worktrees-add never duplicates an existing workspace.
        if (openByCwd.has(await realpathForCmuxCwd(cwd))) {
          continue
        }

        const title = buildCmuxWorkspaceTitle({ branch })

        try {
          if (groupRef) {
            await openCmuxWorkspaceWithLayout({ cwd, title, group: groupRef })
          } else {
            // No group yet: open ungrouped, then seed the group from this first
            // workspace via `--from` (capture-free). Attempt the seed once, so a
            // failed create doesn't spawn a group per iteration.
            const workspaceRef = await openCmuxWorkspaceWithLayout({ cwd, title })

            if (!bootstrapAttempted) {
              groupRef = await createCmuxGroupFrom(repoName, [workspaceRef])
              bootstrapAttempted = true
            }
          }
        } catch (error) {
          logger.warn({ error, branch }, `⚠️ Failed to open cmux workspace for ${branch}`)
        }
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
    // A cancelled prompt (Ctrl-C / Esc) is a user back-out, not a failure: let it
    // reach the top-level boundary untouched so it exits cleanly, instead of being
    // logged as an error with a misleading "branches already exist" remediation.
    if (isPromptCancellation(error)) throw error

    // `debug`, not `error`: this rethrows as an OperationError, and `entry/cli.ts` logs any
    // uncaught error at ERROR and exits 1 — so logging here too printed one fault as two red
    // lines. Kept (demoted, not deleted) because the wrapped message renders only the operation
    // and remediation; the cause's stack survives here and is reachable with `--debug`.
    logger.debug({ err: error }, 'Error managing worktrees')
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
        'Open each created worktree in a new cmux workspace, all rooted at the worktree directory. Pane layout follows "worktrees.cmux.layout" (default "two-columns": left | right; or "three-pane": left split top/bottom + full-height right). Resolution order: this flag → "worktrees.openInCmux" from infra-kit config → interactive prompt (CLI) / false (MCP, no TTY).',
      ),
  },
  outputSchema: {
    createdWorktrees: z.array(z.string()).describe('List of created git worktree branches'),
    count: z.number().describe('Number of git worktrees created'),
  },
  handler: worktreesAdd,
})
