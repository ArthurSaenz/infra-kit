import fs from 'node:fs/promises'
import { $ } from 'zx'

import { closeCmuxWorkspaceByCwd } from 'src/integrations/cmux'
import { OperationError } from 'src/lib/errors/operation-error'
import { listWorktrees } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

export interface RemoveWorktreesArgs {
  branches: string[]
  worktreeDir: string
  /** Main checkout of the repo — `git worktree list` must run inside a git-recognised cwd. */
  projectRoot: string
  pruneFolder?: boolean
  /** Injected so tests never wait for the real sweep-retry delay. */
  sleep?: (ms: number) => Promise<void>
}

export interface WorktreeRemovalFailure {
  branch: string
  reason: string
}

export interface RemoveWorktreesResult {
  removed: string[]
  failed: WorktreeRemovalFailure[]
}

type RemovalOutcome = { branch: string; status: 'removed' } | { branch: string; status: 'failed'; reason: string }

interface LeftoverClassification {
  kind: 'gone' | 'sweepable' | 'not-sweepable'
  entries: string[]
}

/**
 * The only things the post-failure sweep may delete. Measured 2026-09-03: a Claude Code session's
 * oh-my-claudecode SessionEnd hook re-creates `<worktree>/.omc/{state,sessions}` ~2 s after the
 * session exits, racing `git worktree remove`; Finder leaves `.DS_Store`. Anything else (a
 * committable `.omc/skills/**`, user files) makes the leftover NOT sweepable.
 */
const SWEEPABLE_TOP_LEVEL = new Set(['.omc', '.DS_Store'])
const SWEEPABLE_OMC_ENTRIES = new Set(['state', 'sessions'])

/** The measured writer burst is ~2 s; one bounded retry covers a sweep that lands mid-burst. */
const SWEEP_RETRY_DELAY_MS = 2000

const DIRTY_TREE_REMEDIATION = "check 'git worktree list' for the path; uncommitted changes block removal"

const defaultSleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const errnoCode = (error: unknown): string | undefined => {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

const stripTrailingSlashes = (value: string): string => {
  let end = value.length

  while (end > 1 && value[end - 1] === '/') end -= 1

  return value.slice(0, end)
}

/**
 * Canonical form for path equality. `realpath` folds macOS's `/var` → `/private/var` asymmetry;
 * when the path no longer exists (ENOENT mid-race) fall back to the raw string.
 */
const canonicalPath = async (value: string): Promise<string> => {
  try {
    return stripTrailingSlashes(await fs.realpath(value))
  } catch {
    return stripTrailingSlashes(value)
  }
}

interface RegistrationArgs {
  projectRoot: string
  worktreePath: string
}

/**
 * Whether git still lists `worktreePath` as a worktree. Unknown (git itself failed) is reported as
 * `true`: the sweep must never run when git cannot be asked.
 */
const isWorktreeRegisteredOrUnknown = async (args: RegistrationArgs): Promise<boolean> => {
  const { projectRoot, worktreePath } = args

  try {
    const entries = await listWorktrees(projectRoot)
    const target = await canonicalPath(worktreePath)

    for (const entry of entries) {
      if ((await canonicalPath(entry.path)) === target) return true
    }

    return false
  } catch {
    return true
  }
}

/**
 * Two-level, name-only classification of what git left behind. Any read error other than ENOENT is
 * treated as not sweepable — the CLI never deletes what it could not inspect.
 */
const classifyLeftover = async (worktreePath: string): Promise<LeftoverClassification> => {
  let entries: string[]

  try {
    entries = await fs.readdir(worktreePath)
  } catch (error) {
    return { kind: errnoCode(error) === 'ENOENT' ? 'gone' : 'not-sweepable', entries: [] }
  }

  const topLevelOk = entries.every((entry) => {
    return SWEEPABLE_TOP_LEVEL.has(entry)
  })

  if (!topLevelOk) return { kind: 'not-sweepable', entries }
  if (!entries.includes('.omc')) return { kind: 'sweepable', entries }

  try {
    const omcEntries = await fs.readdir(`${worktreePath}/.omc`)

    const omcOk = omcEntries.every((entry) => {
      return SWEEPABLE_OMC_ENTRIES.has(entry)
    })

    return { kind: omcOk ? 'sweepable' : 'not-sweepable', entries }
  } catch (error) {
    return { kind: errnoCode(error) === 'ENOENT' ? 'sweepable' : 'not-sweepable', entries }
  }
}

interface SweepArgs {
  worktreePath: string
  sleep: (ms: number) => Promise<void>
}

type RemoveTreeOutcome = 'removed' | 'busy' | 'failed'

/** One recursive removal attempt; `busy` is ENOTEMPTY — a writer got in between readdir and rmdir. */
const removeTree = async (worktreePath: string): Promise<RemoveTreeOutcome> => {
  try {
    await fs.rm(worktreePath, { recursive: true, force: true })

    return 'removed'
  } catch (error) {
    return errnoCode(error) === 'ENOTEMPTY' ? 'busy' : 'failed'
  }
}

/** Recursive removal with exactly one retry when a concurrent writer makes it ENOTEMPTY again. */
const sweepLeftover = async (args: SweepArgs): Promise<boolean> => {
  const { worktreePath, sleep } = args

  const first = await removeTree(worktreePath)

  // Only a concurrent writer earns the single retry; anything else is final.
  if (first !== 'busy') return first === 'removed'

  await sleep(SWEEP_RETRY_DELAY_MS)

  return (await removeTree(worktreePath)) === 'removed'
}

interface RecoverArgs {
  branch: string
  worktreePath: string
  projectRoot: string
  error: unknown
  sleep: (ms: number) => Promise<void>
}

const failedOutcome = (branch: string, error: unknown, remediation: string): RemovalOutcome => {
  const err = new OperationError(error, { operation: `remove worktree for ${branch}`, remediation })

  logger.error({ error, branch, msg: err.message })

  return { branch, status: 'failed', reason: err.message }
}

/**
 * `git worktree remove` rejected. git deletes the tree first and unregisters the worktree LAST, so a
 * rejection with the path already unregistered means git finished its own work and only a
 * post-deletion write (the measured case: a session-end hook re-creating `.omc/`) kept `rmdir` from
 * succeeding. That leftover — and only an allowlisted one — is swept here. A path git still lists
 * is a real refusal (dirty tree) and is reported as such.
 */
const recoverFromRejectedRemove = async (args: RecoverArgs): Promise<RemovalOutcome> => {
  const { branch, worktreePath, projectRoot, error, sleep } = args

  if (await isWorktreeRegisteredOrUnknown({ projectRoot, worktreePath })) {
    return failedOutcome(branch, error, DIRTY_TREE_REMEDIATION)
  }

  const leftover = await classifyLeftover(worktreePath)

  if (leftover.kind === 'gone') return { branch, status: 'removed' }

  const manualRemediation = `git already unregistered this worktree; inspect and remove it manually: rm -r ${worktreePath}`

  if (leftover.kind === 'not-sweepable') return failedOutcome(branch, error, manualRemediation)

  if (!(await sweepLeftover({ worktreePath, sleep }))) return failedOutcome(branch, error, manualRemediation)

  logger.warn(
    `⚠️ swept leftover ${leftover.entries.join(', ')} from ${worktreePath}: a post-exit hook (e.g. oh-my-claudecode SessionEnd) wrote into the worktree while git was deleting it; set OMC_STATE_DIR to keep tool state out of worktrees`,
  )

  return { branch, status: 'removed' }
}

interface RemoveOneArgs {
  branch: string
  worktreeDir: string
  projectRoot: string
  sleep: (ms: number) => Promise<void>
}

const removeOne = async (args: RemoveOneArgs): Promise<RemovalOutcome> => {
  const { branch, worktreeDir, projectRoot, sleep } = args
  const worktreePath = `${worktreeDir}/${branch}`

  // Close the cmux workspace by its cwd (the worktree path still exists here —
  // close runs before `git worktree remove`). Anchors are excluded, so a group
  // header is never closed. Kept OUTSIDE the git try: a cmux failure means git never
  // ran, so it must not enter the post-git recovery below.
  try {
    await closeCmuxWorkspaceByCwd(worktreePath)
  } catch (error) {
    return failedOutcome(branch, error, 'close the cmux workspace for this worktree manually and re-run')
  }

  try {
    await $`git worktree remove ${worktreePath}`

    return { branch, status: 'removed' }
  } catch (error) {
    return recoverFromRejectedRemove({ branch, worktreePath, projectRoot, error, sleep })
  }
}

/**
 * Close any cmux workspace for each branch and run `git worktree remove`, returning the branches
 * that were removed and, separately, the ones that were not (with the reason). Failures are
 * reported, never thrown, so a single bad worktree doesn't poison a batch removal — callers decide
 * how to surface `failed` (see `toRemovalToolResult`).
 *
 * When `pruneFolder` is true and every branch was removed, also run `git worktree prune` to clear
 * stale worktree metadata. The `<repo>-worktrees` container directory and its `release/`/`feature/`
 * subfolders are deliberately left in place so the per-repo worktree scaffold persists even when
 * empty.
 */
export const removeWorktrees = async (args: RemoveWorktreesArgs): Promise<RemoveWorktreesResult> => {
  const { branches, worktreeDir, projectRoot, pruneFolder = false, sleep = defaultSleep } = args

  // removeOne never rejects (both of its steps catch), so a plain Promise.all keeps the
  // one-bad-branch-never-poisons-the-batch contract.
  const outcomes = await Promise.all(
    branches.map((branch) => {
      return removeOne({ branch, worktreeDir, projectRoot, sleep })
    }),
  )

  const result: RemoveWorktreesResult = { removed: [], failed: [] }

  for (const outcome of outcomes) {
    if (outcome.status === 'removed') {
      result.removed.push(outcome.branch)
    } else {
      result.failed.push({ branch: outcome.branch, reason: outcome.reason })
    }
  }

  // `git worktree remove` deletes only the leaf worktree. We intentionally leave
  // the `<repo>-worktrees` container and its `release/`/`feature/` group folders
  // in place so the worktree scaffold survives an empty state (it is recreated
  // lazily by `worktrees-add` via `mkdir -p` regardless).
  if (pruneFolder && result.removed.length === branches.length) {
    await $`git worktree prune`
  }

  return result
}
