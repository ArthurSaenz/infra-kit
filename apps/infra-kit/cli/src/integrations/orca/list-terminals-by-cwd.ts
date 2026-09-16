import { logger } from 'src/lib/logger'

import { OrcaError, runOrca } from './run-orca'

export interface OrcaTerminal {
  handle: string
  title: string
  tabId: string
  connected: boolean
  orphaned: boolean
}

interface OrcaTerminalListResult {
  terminals?: OrcaTerminal[]
  truncated?: boolean
}

const TERMINAL_LIST_LIMIT = '200'

/**
 * The terminals Orca has open in the worktree at `cwd`. A `selector_not_found`
 * is "nothing open" (probe semantics — the row may not exist yet, or was pruned);
 * any other Orca failure propagates. `truncated` is surfaced, not resolved: a
 * truncated list still proves the worktree is open.
 */
export const listOrcaTerminals = async (cwd: string): Promise<{ terminals: OrcaTerminal[]; truncated: boolean }> => {
  try {
    const result = await runOrca<OrcaTerminalListResult>([
      'terminal',
      'list',
      '--worktree',
      `path:${cwd}`,
      '--limit',
      TERMINAL_LIST_LIMIT,
    ])

    const truncated = result.truncated === true

    if (truncated) {
      logger.debug({ cwd, limit: TERMINAL_LIST_LIMIT }, 'orca: terminal list truncated')
    }

    return { terminals: result.terminals ?? [], truncated }
  } catch (error) {
    if (error instanceof OrcaError && error.code === 'selector_not_found') {
      return { terminals: [], truncated: false }
    }

    throw error
  }
}
