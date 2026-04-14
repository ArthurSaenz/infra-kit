import process from 'node:process'
import { $ } from 'zx'

import { logger } from 'src/lib/logger'

/**
 * Validate Doppler CLI installation and authentication status and throw an error if not valid
 */
export const validateDopplerCliAndAuth = async () => {
  try {
    await $`doppler --version`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: Doppler CLI is not installed.')
    logger.error('Please install it from: https://docs.doppler.com/docs/install-cli')
    process.exit(1)
  }

  try {
    await $`doppler me`
  } catch (error: unknown) {
    logger.error({ error }, 'Error: Doppler CLI is not authenticated.')
    logger.error('Please authenticate by running: doppler login')
    process.exit(1)
  }
}
