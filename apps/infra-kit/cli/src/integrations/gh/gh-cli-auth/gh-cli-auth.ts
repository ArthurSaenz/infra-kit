import process from 'node:process'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'

/**
 * Validate GitHub CLI installation and authentication status and throw an error if not valid
 */
export const validateGitHubCliAndAuth = async () => {
  try {
    await $`gh --version`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: GitHub CLI (gh) is not installed.')
    logger.error('Please install it from: https://cli.github.com/')
    process.exit(1)
  }

  try {
    await $`gh auth status`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: GitHub CLI (gh) is not authenticated.')
    logger.error('Please authenticate it from: https://cli.github.com/manual/gh_auth_login or type "gh auth login"')
    process.exit(1)
  }
}
