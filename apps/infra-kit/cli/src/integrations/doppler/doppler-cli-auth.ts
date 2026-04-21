import { $ } from 'zx'

/**
 * Validate Doppler CLI installation and authentication status. Throws on failure
 * so callers (CLI entry, MCP tool handler) can translate to the right surface —
 * CLI exits non-zero; MCP returns a structured tool error instead of tearing
 * down the server.
 */
export const validateDopplerCliAndAuth = async (): Promise<void> => {
  try {
    await $`doppler --version`
  } catch (error: unknown) {
    throw new Error('Doppler CLI is not installed. Install it from: https://docs.doppler.com/docs/install-cli', {
      cause: error,
    })
  }

  try {
    await $`doppler me`
  } catch (error: unknown) {
    throw new Error('Doppler CLI is not authenticated. Run: doppler login', { cause: error })
  }
}
