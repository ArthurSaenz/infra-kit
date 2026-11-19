import { OperationError } from 'src/lib/errors/operation-error'
import { classifyDirectory, removeTree } from 'src/lib/worktrees/sweep-leftover'

export interface WaitAndSweepArgs {
  oldPath: string
  sleep: (ms: number) => Promise<void>
  now: () => number
  boundMs?: number
  quietMs?: number
  tickMs?: number
}

/**
 * True when something was found at `oldPath` (and a sweep was attempted); throws on non-sweepable entries
 * and on a removal that failed for any reason but a concurrent writer.
 */
const sweepIfPresent = async (oldPath: string): Promise<boolean> => {
  const state = await classifyDirectory(oldPath)

  if (state.state === 'absent') return false

  if (state.state === 'has-other-entries') {
    throw new OperationError(undefined, {
      operation: `sweep ${oldPath} after the worktree move`,
      remediation: `move or delete those entries by hand, then re-run — nothing was deleted`,
      stderrExcerpt: `${oldPath} holds entries the sweep may not delete: ${state.otherEntries.join(', ') || '(unreadable)'}`,
    })
  }

  // `removeTree`, not `sweepLeftover`: its boolean folds a busy writer into a failure, and a busy writer
  // is this loop's to wait out on the next tick.
  if ((await removeTree(oldPath)) === 'failed') {
    throw new OperationError(undefined, {
      operation: `sweep ${oldPath} after the worktree move`,
      remediation: `check the permissions under ${oldPath}, delete it by hand, then re-run`,
      stderrExcerpt: `could not delete ${oldPath}: the removal failed with a permission or I/O error, not a busy writer`,
    })
  }

  return true
}

/**
 * The OMC SessionEnd hook re-creates `<old>/.omc/{state,sessions}` after Orca closes the terminals
 * (measured ~2 s burst, `sweep-leftover.ts`), i.e. after the move. Poll and sweep until the old path
 * stays absent for `quietMs`; the 10 s bound is planner-chosen, and a writer still active at the bound
 * is left for the re-run's pending-sweep row.
 */
export const waitAndSweepOldPath = async (args: WaitAndSweepArgs): Promise<void> => {
  const { oldPath, sleep, now, boundMs = 10_000, quietMs = 3_000, tickMs = 500 } = args
  const deadline = now() + boundMs
  let absentSince: number | null = null

  while (now() < deadline) {
    if (await sweepIfPresent(oldPath)) {
      absentSince = null
    } else {
      absentSince ??= now()

      if (now() - absentSince >= quietMs) return
    }

    await sleep(tickMs)
  }

  if (!(await sweepIfPresent(oldPath))) return

  throw new OperationError(undefined, {
    operation: `sweep ${oldPath} after the worktree move`,
    remediation: 're-run the same rename once the session hooks have finished: it only sweeps the old path',
    stderrExcerpt: `a writer is still active in ${oldPath} after ${boundMs / 1000} s`,
  })
}
