import { logger } from 'src/lib/logger'

import type { RemoveWorktreesResult } from './remove-worktrees'

/**
 * Human-readable summary of a batch removal. A branch that was not removed is listed with its
 * reason — never folded into a "nothing to do" line, which is what made a failed removal look like
 * a clean no-op before.
 */
export const logRemovalResults = (result: RemoveWorktreesResult): void => {
  const { removed, failed } = result

  if (removed.length > 0) {
    logger.info('❌ Removed worktrees:')

    for (const branch of removed) {
      logger.info(branch)
    }

    logger.info('')
  }

  if (failed.length > 0) {
    logger.warn('⚠️ Not removed:')

    for (const { branch, reason } of failed) {
      logger.warn(`${branch} — ${reason}`)
    }

    logger.warn('')
  }

  if (removed.length === 0 && failed.length === 0) {
    logger.info('ℹ️ No worktrees to remove')
  }
}
