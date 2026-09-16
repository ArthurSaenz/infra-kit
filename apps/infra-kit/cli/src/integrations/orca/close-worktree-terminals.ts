import { logger } from 'src/lib/logger'

import type { OrcaProbe } from './availability'
import { listOrcaTerminals } from './list-terminals-by-cwd'
import { OrcaAbsentError, OrcaError, OrcaMalformedError, runOrca } from './run-orca'

export type CloseOrcaWorktreeTerminalsOutcome =
  | { closed: true; count: number }
  | { closed: false; skipped: 'absent' | 'unreachable' | 'not_found' }
  | { closed: false; error: OrcaError }

type RetireOutcome = 'retired' | 'not_found'

/**
 * `--all` refuses (`terminal_close_incomplete`) while any terminal is live and
 * on an empty row only retires the tab surfaces and resume records — so it runs
 * LAST, after every handle was closed one by one, and its refusal is not a
 * failure (docs/orca-cli-findings.md §3.4).
 */
const retireSurfaces = async (cwd: string): Promise<RetireOutcome> => {
  try {
    await runOrca(['terminal', 'close', '--worktree', `path:${cwd}`, '--all'])

    return 'retired'
  } catch (error) {
    if (error instanceof OrcaError && error.code === 'selector_not_found') {
      return 'not_found'
    }

    if (error instanceof OrcaError && error.code === 'terminal_close_incomplete') {
      logger.debug({ cwd, error }, 'orca: surfaces not retired')

      return 'retired'
    }

    throw error
  }
}

const closeEach = async (cwd: string): Promise<CloseOrcaWorktreeTerminalsOutcome> => {
  const { terminals } = await listOrcaTerminals(cwd)

  // Sequential on purpose: the tab is torn down pane by pane and Orca serializes these anyway.
  for (const terminal of terminals) {
    await runOrca(['terminal', 'close', '--terminal', terminal.handle])
  }

  const retired = await retireSurfaces(cwd)

  if (terminals.length === 0 && retired === 'not_found') {
    return { closed: false, skipped: 'not_found' }
  }

  return { closed: true, count: terminals.length }
}

const asOutcome = (cwd: string, error: unknown): CloseOrcaWorktreeTerminalsOutcome => {
  if (error instanceof OrcaAbsentError) {
    return { closed: false, skipped: 'absent' }
  }

  if (error instanceof OrcaError) {
    return { closed: false, error }
  }

  if (error instanceof OrcaMalformedError) {
    return {
      closed: false,
      error: new OrcaError({
        code: 'orca_malformed_output',
        message: error.message,
        data: { exitCode: error.exitCode, stderrTail: error.stderrTail },
      }),
    }
  }

  logger.debug({ cwd, error }, 'orca: close failed outside the Orca contract')

  return {
    closed: false,
    error: new OrcaError({
      code: 'orca_close_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  }
}

/**
 * Tears down every Orca terminal of the worktree at `cwd` — called right before
 * `git worktree remove`, and nowhere else (a closed GUI is never a precondition
 * for anything that survives). Never throws: the caller decides whether an error
 * outcome blocks git, and a probe that is not `ready` skips without spawning.
 * The Orca-side row is pruned by Orca itself once the directory is gone.
 */
export const closeOrcaWorktreeTerminals = async (
  cwd: string,
  probe: OrcaProbe,
): Promise<CloseOrcaWorktreeTerminalsOutcome> => {
  if (probe !== 'ready') {
    return { closed: false, skipped: probe }
  }

  try {
    return await closeEach(cwd)
  } catch (error) {
    return asOutcome(cwd, error)
  }
}
