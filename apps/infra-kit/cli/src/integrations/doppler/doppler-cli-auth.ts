import { $ } from 'zx'

/**
 * Hard upper bound for the Doppler auth probes. `doppler me` is a network call;
 * without a timeout a hung VPN/connection would stall every caller indefinitely
 * (notably the env auto-load preAction hook, which runs before each CLI command).
 */
const DOPPLER_AUTH_TIMEOUT_MS = 5_000

/**
 * Validate Doppler CLI installation and authentication status. Throws on failure
 * so callers (CLI entry, MCP tool handler) can translate to the right surface —
 * CLI exits non-zero; MCP returns a structured tool error instead of tearing
 * down the server. Both probes are time-bounded so a hung Doppler/network never
 * blocks the caller (a timeout surfaces as the same "not authenticated" path).
 */
export const validateDopplerCliAndAuth = async (): Promise<void> => {
  try {
    await $`doppler --version`.timeout(DOPPLER_AUTH_TIMEOUT_MS)
  } catch (error: unknown) {
    throw new Error('Doppler CLI is not installed. Install it from: https://docs.doppler.com/docs/install-cli', {
      cause: error,
    })
  }

  try {
    await $`doppler me`.timeout(DOPPLER_AUTH_TIMEOUT_MS)
  } catch (error: unknown) {
    throw new Error('Doppler CLI is not authenticated (or timed out). Run: doppler login', { cause: error })
  }
}
