import { $ } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'

/**
 * Validate GitHub CLI installation and authentication status and throw an error if not valid
 */
export const validateGitHubCliAndAuth = async () => {
  try {
    await $`gh --version`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: GitHub CLI (gh) is not installed.')
    throw new OperationError(error, {
      operation: 'verify GitHub CLI is installed',
      remediation: 'install gh from https://cli.github.com/',
    })
  }

  try {
    await $`gh auth status`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: GitHub CLI (gh) is not authenticated.')
    throw new OperationError(error, {
      operation: 'verify GitHub CLI authentication',
      remediation: 'run "gh auth login" (https://cli.github.com/manual/gh_auth_login)',
    })
  }
}
