import { $ } from 'zx'
import type { ProcessPromise } from 'zx'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'

/**
 * Hard upper bound for the Doppler list probes. These run only on error/diagnostic
 * paths (download-failure enrichment, `doctor`), but a hung VPN/connection must not
 * stall them — mirrors the auth-probe budget in `doppler-cli-auth.ts`.
 */
const DOPPLER_LIST_TIMEOUT_MS = 5_000

/**
 * Resolve Doppler project name from infra-kit.json at the project root
 */
export const getDopplerProject = async (): Promise<string> => {
  const { envManagement } = await getInfraKitConfig()

  return envManagement.config.name
}

/**
 * List the Doppler project names for the authenticated account, or `null` when the
 * lookup itself fails (CLI missing, unauthenticated, network/timeout, malformed
 * JSON). NEVER throws. Callers MUST distinguish `null` ("couldn't tell") from `[]`
 * ("told: none exist") so an enrichment or diagnostic message never misreports a
 * failed probe as "no projects available".
 *
 * @example
 * await listDopplerProjects() // => ['example-project', 'nomadream']  (or null on failure)
 */
export const listDopplerProjects = async (): Promise<string[] | null> => {
  return runDopplerNameList(() => {
    return $`doppler projects --json`
  })
}

/**
 * List the Doppler config names for a project, or `null` when the lookup itself
 * fails (see {@link listDopplerProjects} for the `null` vs `[]` contract).
 *
 * @example
 * await listDopplerConfigs('nomadream') // => ['dev', 'oleg', 'prod', 'arthur']  (or null on failure)
 */
export const listDopplerConfigs = async (project: string): Promise<string[] | null> => {
  return runDopplerNameList(() => {
    return $`doppler configs --project ${project} --json`
  })
}

/**
 * Run a `doppler ... --json` listing quietly + time-bounded and extract the `name`
 * field of each entry. Returns `null` on any failure (subprocess error, timeout,
 * non-array/malformed JSON) so the caller can tell a failed probe from an empty set.
 */
const runDopplerNameList = async (run: () => ProcessPromise): Promise<string[] | null> => {
  const prevQuiet = $.quiet

  $.quiet = true
  try {
    const result = await run().timeout(DOPPLER_LIST_TIMEOUT_MS)

    return parseDopplerNames(result.stdout)
  } catch {
    return null
  } finally {
    $.quiet = prevQuiet
  }
}

/** Parse a Doppler `--json` array into its `name` strings, or `null` if the shape is unexpected. */
const parseDopplerNames = (stdout: string): string[] | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null

  return parsed
    .map((entry) => {
      return entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined
    })
    .filter((name): name is string => {
      return typeof name === 'string'
    })
}
