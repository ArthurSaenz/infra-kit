import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

/**
 * The root `audit.exclude` globs, or none when the project config cannot be read: `audit --root`
 * reports that failure, and skipping nothing is the fail-safe direction for `--all`.
 */
export const readAuditExclude = async (): Promise<string[]> => {
  try {
    return (await getInfraKitConfig()).audit?.exclude ?? []
  } catch (err) {
    logger.debug({ err, msg: 'audit.exclude unreadable — no workspace package is excluded' })

    return []
  }
}
