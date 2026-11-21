import type { OrcaTerminalCreateResult } from './open-worktree-terminals'
import { OrcaError, runOrca } from './run-orca'

interface OpenOrcaLogTerminalArgs {
  /** `ORCA_WORKTREE_ID` of the terminal the caller runs in: the tab opens beside it. */
  worktreeId: string
  title: string
  logPath: string
}

const ESCAPED_SINGLE_QUOTE = String.raw`'\''`

const shellQuote = (value: string): string => {
  return `'${value.replaceAll("'", ESCAPED_SINGLE_QUOTE)}'`
}

/**
 * Opens a focused Orca terminal tab that follows `logPath`. A terminal rather than a file tab because
 * Orca refuses to open a file outside the worktree, and dev logs live in the cache directory.
 */
export const openOrcaLogTerminal = async (args: OpenOrcaLogTerminalArgs): Promise<string> => {
  const { worktreeId, title, logPath } = args

  const result = await runOrca<OrcaTerminalCreateResult>([
    'terminal',
    'create',
    '--worktree',
    `id:${worktreeId}`,
    '--title',
    title,
    '--command',
    `tail -n 200 -f ${shellQuote(logPath)}`,
    '--focus',
  ])

  return result.terminal.handle
}

/** Brings an already open terminal to the front; `false` when Orca no longer knows the handle. */
export const focusOrcaTerminal = async (handle: string): Promise<boolean> => {
  try {
    await runOrca(['terminal', 'switch', '--terminal', handle])

    return true
  } catch (error) {
    if (error instanceof OrcaError) return false

    throw error
  }
}
