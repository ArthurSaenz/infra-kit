import fs from 'node:fs/promises'
import { $ } from 'zx'

import { OrcaError, probeOrca, runOrca } from 'src/integrations/orca'
import type { OrcaTerminalCreateResult } from 'src/integrations/orca'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { WORKTREES_DIR_SUFFIX } from 'src/lib/constants'
import { OperationError } from 'src/lib/errors/operation-error'
import { getMainRepoRoot, getProjectRoot, listWorktrees } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { isReleaseBranch } from 'src/lib/release-id'
import { releaseBranchLabels } from 'src/lib/release-utils'
import { shellLine } from 'src/lib/shell-quote'
import type { RemovalStructuredContent } from 'src/lib/worktrees'
import { textContent } from 'src/types'
import type { ToolsExecutionResult } from 'src/types'

const OPERATION = 'remove this worktree'

export interface SelfRemovalStructuredContent extends RemovalStructuredContent {
  handedOff: { branch: string; worktreePath: string; terminal: string }
}

/**
 * Lets the caller (typically the Claude Code session that ran `--self`) finish its reply before the
 * removal closes its tab.
 */
const HANDOFF_GRACE_SECONDS = 2

/** How long the hand-off tab shows a successful result before it closes itself. */
const SUCCESS_LINGER_SECONDS = 3

interface SelfTarget {
  worktreePath: string
  mainRoot: string
  branch: string
  /** The `worktrees remove` flags that name this worktree from the main checkout. */
  targetArgs: string[]
}

const canonical = async (value: string): Promise<string> => {
  try {
    return await fs.realpath(value)
  } catch {
    return value
  }
}

const refuse = (remediation: string, stderrExcerpt: string): never => {
  throw new OperationError(undefined, { operation: OPERATION, remediation, stderrExcerpt })
}

const targetArgsFor = (branch: string): string[] => {
  if (branch.startsWith('feature/')) return ['--feature', branch.slice('feature/'.length)]

  const [label] = releaseBranchLabels([branch])

  if (isReleaseBranch(branch) && label) return ['--versions', label]

  return refuse(
    'only feature/* and release worktrees created by `infra-kit worktrees add` can be removed with --self',
    `branch ${branch} is neither a feature nor a release branch`,
  )
}

const resolveSelfTarget = async (): Promise<SelfTarget> => {
  const worktreePath = await canonical(await getProjectRoot())
  const mainRoot = await canonical(await getMainRepoRoot(worktreePath))

  if (worktreePath === mainRoot) {
    refuse(
      'run --self from inside the worktree to remove, or name it with --feature / --versions',
      'this is the main checkout, not a linked worktree',
    )
  }

  let branch: string | null = null

  for (const entry of await listWorktrees(mainRoot)) {
    if ((await canonical(entry.path)) === worktreePath) branch = entry.branch
  }

  if (!branch) {
    return refuse('check out a branch in this worktree first', `no branch is checked out at ${worktreePath}`)
  }

  // `worktrees remove` rebuilds the path from the branch name, so a worktree outside infra-kit's
  // layout would resolve to a different directory.
  const managedPath = await canonical(`${mainRoot}${WORKTREES_DIR_SUFFIX}/${branch}`)

  if (managedPath !== worktreePath) {
    refuse(
      'remove it with `git worktree remove` from the main checkout',
      `${worktreePath} is not an infra-kit worktree (expected ${managedPath})`,
    )
  }

  return { worktreePath, mainRoot, branch, targetArgs: targetArgsFor(branch) }
}

const porcelainStatus = async (dir: string): Promise<string[]> => {
  const result = await $({ quiet: true })`git -C ${dir} status --porcelain`

  return result.stdout.split('\n').filter((line) => {
    return line.trim().length > 0
  })
}

/**
 * Every refusal the hand-off would hit is asked here, while nothing is closed yet: this worktree
 * must be clean for `git worktree remove`, and the main checkout for the guard of the command that
 * runs there.
 */
const assertHandoffWouldSucceed = async (target: SelfTarget): Promise<void> => {
  const [own, main] = await Promise.all([porcelainStatus(target.worktreePath), porcelainStatus(target.mainRoot)])

  if (own.length > 0) {
    refuse('commit or stash your changes (`git stash -u`), then retry', `uncommitted changes: ${own.join(', ')}`)
  }

  if (main.length > 0) {
    refuse(
      `commit or stash the changes in the main checkout ${target.mainRoot}, then retry`,
      `the main checkout has uncommitted changes: ${main.join(', ')}`,
    )
  }

  const probe = await probeOrca()

  if (probe !== 'ready') {
    refuse(
      `run \`infra-kit worktrees remove ${shellLine(target.targetArgs)}\` from the main checkout ${target.mainRoot}`,
      `--self hands the removal to an Orca terminal, and Orca is ${probe}`,
    )
  }
}

/**
 * The removal cannot run in the caller's own terminal: closing that worktree's tabs kills the
 * process doing the closing. Orca runs it instead, in a new tab of the main checkout — a process
 * Orca owns, which outlives the tab it removes and leaves any failure on screen.
 */
const handOffToOrca = async (target: SelfTarget): Promise<string> => {
  const removal = shellLine(['infra-kit', 'worktrees', 'remove', ...target.targetArgs, '--yes'])
  const command = `sleep ${HANDOFF_GRACE_SECONDS}; ${removal} && { sleep ${SUCCESS_LINGER_SECONDS}; exit; }`

  try {
    const result = await runOrca<OrcaTerminalCreateResult>([
      'terminal',
      'create',
      '--worktree',
      `path:${target.mainRoot}`,
      '--title',
      `ik: remove ${target.branch}`,
      '--command',
      command,
    ])

    return result.terminal.handle
  } catch (error) {
    if (error instanceof OrcaError) {
      throw new OperationError(error, {
        operation: OPERATION,
        remediation: `run \`infra-kit worktrees remove ${shellLine(target.targetArgs)}\` from the main checkout ${target.mainRoot}`,
        stderrExcerpt: error.message,
      })
    }

    throw error
  }
}

/**
 * `worktrees remove --self`: removes the worktree the command runs in, tabs included. Everything is
 * checked here; the removal itself is the ordinary `worktrees remove`, run by Orca from the main
 * checkout.
 */
export const worktreesRemoveSelf = async (
  confirmedCommand: boolean | undefined,
): Promise<ToolsExecutionResult<SelfRemovalStructuredContent>> => {
  const target = await resolveSelfTarget()

  await assertHandoffWouldSucceed(target)

  commandEcho.addOption('--self', true)

  await confirmOrExit(
    confirmedCommand,
    `Remove ${target.branch} at ${target.worktreePath} and close every Orca tab in it (this terminal included)?`,
  )

  if (!confirmedCommand) commandEcho.addOption('--yes', true)

  const terminal = await handOffToOrca(target)

  logger.info(`➡️ Removal of ${target.branch} handed off to Orca (main checkout tab "ik: remove ${target.branch}")`)

  commandEcho.print()

  const handedOff = { branch: target.branch, worktreePath: target.worktreePath, terminal }

  return {
    content: textContent(JSON.stringify({ status: 'handed_off', ...handedOff }, null, 2)),
    structuredContent: { removedWorktrees: [], failedWorktrees: [], count: 0, handedOff },
  }
}
