/**
 * Translate Doppler `secrets download` not-found failures into actionable,
 * point-at-the-fix guidance. Pure (no I/O) so the classification + message policy
 * is unit-testable without spawning the Doppler CLI — mirroring the pure-helper
 * pattern in `commands/env-load/env-load.ts`.
 *
 * Observed Doppler output on a not-found download (verified 2026-06-27, doppler
 * v3.76.0), exit 1, written to STDERR (stdout empty):
 *   Unable to download secrets
 *   Doppler Error: Could not find requested project 'name'
 *   Doppler Error: Could not find requested config 'name'
 * Only the "Doppler Error:" prefix is ANSI-colored; the "Could not find requested
 * ..." text is plain, so substring matching is color-safe. zx's
 * `ProcessOutput.message` also concatenates stdout+stderr, so the same markers are
 * matchable off `.message` when `.stderr` is unavailable.
 */

/** Which kind of Doppler not-found a download failure represents (`unknown` = not a not-found error). */
export type DopplerNotFoundKind = 'project' | 'config' | 'unknown'

const PROJECT_NOT_FOUND_MARKER = 'Could not find requested project'
const CONFIG_NOT_FOUND_MARKER = 'Could not find requested config'

/**
 * Classify a Doppler download failure from its stderr/message text. Returns
 * `'unknown'` for anything that isn't a recognized not-found error so the caller
 * rethrows the original untouched (degrades to status quo, never worse).
 *
 * @example
 * classifyDopplerDownloadError("Doppler Error: Could not find requested project 'x'") // => 'project'
 * classifyDopplerDownloadError("Doppler Error: Could not find requested config 'dev'") // => 'config'
 * classifyDopplerDownloadError('network unreachable')                                  // => 'unknown'
 */
export const classifyDopplerDownloadError = (stderr: string): DopplerNotFoundKind => {
  if (stderr.includes(PROJECT_NOT_FOUND_MARKER)) return 'project'

  if (stderr.includes(CONFIG_NOT_FOUND_MARKER)) return 'config'

  return 'unknown'
}

interface DopplerNotFoundMessageArgs {
  /** Whether the missing entity is the project or the config within it. */
  kind: 'project' | 'config'
  project: string
  config: string
  /**
   * Names to suggest. `null` = lookup failed/unavailable, `[]` = none exist; both
   * omit the suggestion line so a failed enrichment probe is never misreported as
   * a definitive "none available".
   */
  available?: string[] | null
}

/**
 * Build the actionable, multi-line error body for a Doppler not-found failure:
 * states what's missing, points at the exact infra-kit.json field, lists available
 * names when known, and gives a concrete fix.
 *
 * @example
 * buildDopplerNotFoundMessage({ kind: 'project', project: 'infra-kit', config: 'dev', available: ['nomadream'] })
 * // => 'Doppler project "infra-kit" not found (set in infra-kit.json → envManagement.config.name).\nAvailable projects: nomadream.\nFix: ...'
 */
export const buildDopplerNotFoundMessage = ({
  kind,
  project,
  config,
  available,
}: DopplerNotFoundMessageArgs): string => {
  const lines: string[] =
    kind === 'project'
      ? [`Doppler project "${project}" not found (set in infra-kit.json → envManagement.config.name).`]
      : [`Doppler config "${config}" not found in project "${project}" (set in infra-kit.json → environments).`]

  if (available && available.length > 0) {
    const label = kind === 'project' ? 'Available projects' : `Available configs in "${project}"`

    lines.push(`${label}: ${available.join(', ')}.`)
  }

  lines.push(
    kind === 'project'
      ? 'Fix: update envManagement.config.name to an existing project, or create it in Doppler.'
      : 'Fix: update environments to an existing config, or create it in Doppler.',
  )

  return lines.join('\n')
}
