import { OperationError } from 'src/lib/errors/operation-error'

import { canPromptForDeploySource, pickDeploySource } from './source-picker'

/**
 * Where a deploy runs — the one choice this command exists to make explicit.
 *
 * `ci` dispatches the GitHub workflow for a release ref; `local` runs the repo's own
 * devops/scripts/deploy-*.sh here, against the current checkout. The two also differ in WHAT ships
 * (a named ref vs your working tree), but that follows from the runner rather than being a separate
 * axis: there is no path that builds a release ref locally, and none that ships a working tree via
 * CI. The artifact difference is surfaced in the option help and the confirm prompt, where it is
 * useful, instead of being encoded in cryptic flag values.
 */
export const DEPLOY_SOURCES = ['ci', 'local'] as const

export type DeploySource = (typeof DEPLOY_SOURCES)[number]

/** Flags that only mean something for one source, so the other must refuse them rather than ignore them. */
const SOURCE_ONLY_FLAGS: Record<DeploySource, readonly string[]> = {
  ci: ['--version', '--skip-terraform'],
  local: ['--dry-run', '--print-env'],
}

/**
 * Validate `--from`. Deliberately has NO default: the choice between a reviewed ref built in CI and
 * your working tree built here is the most consequential one in the command, so it is stated on every
 * invocation. A default here would silently re-create the ambiguity this argument was added to remove.
 */
export const parseDeploySource = (from: string | undefined): DeploySource => {
  if (!from) {
    throw new OperationError(undefined, {
      operation: 'resolve the deploy source',
      remediation: `pass --from with one of: ${DEPLOY_SOURCES.join(', ')}`,
      stderrExcerpt: '--from is required — it decides whether this deploy runs in CI or on this machine',
    })
  }

  const match = DEPLOY_SOURCES.find((source) => {
    return source === from
  })

  if (!match) {
    throw new OperationError(undefined, {
      operation: 'resolve the deploy source',
      remediation: `use one of: ${DEPLOY_SOURCES.join(', ')}`,
      stderrExcerpt: `unknown --from value "${from}"`,
    })
  }

  return match
}

/**
 * Refuse a flag that belongs to the other runner.
 *
 * These combinations used to be unrepresentable — `--skip-terraform` simply did not exist on the local
 * command — so merging the two surfaces has to keep them impossible. Ignoring an inert flag would be
 * worse than the old split: `--skip-terraform` silently dropped reads as "terraform was skipped".
 *
 * Commander gives `undefined` for an absent option and `false` for an absent boolean flag; both count
 * as absent. There is deliberately no array case: every flag in {@link SOURCE_ONLY_FLAGS} is a boolean
 * or a single string. `--skip-preflight` was the only variadic one, and an emptiness check kept for a
 * variadic flag that no longer exists would be exactly the unreachable-branch defect its removal
 * cleared. Add the check back with the next variadic source-only flag, not before it.
 */
export const assertFlagsMatchSource = (source: DeploySource, present: Record<string, unknown>) => {
  const foreign = SOURCE_ONLY_FLAGS[source === 'ci' ? 'local' : 'ci']

  const offenders = foreign.filter((flag) => {
    const value = present[flag]

    return value !== undefined && value !== false
  })

  if (offenders.length === 0) return

  throw new OperationError(undefined, {
    operation: `deploy --from ${source}`,
    remediation:
      source === 'ci'
        ? 'drop the flag, or use --from local to deploy from this machine'
        : 'drop the flag, or use --from ci to dispatch the release workflow',
    stderrExcerpt: `${offenders.join(', ')} ${offenders.length === 1 ? 'is' : 'are'} not valid with --from ${source}`,
  })
}

/**
 * Resolve `--from`, asking for it when the run can be asked.
 *
 * Still no default and still stated on every invocation — the interactive path answers the question
 * rather than assuming it. Non-TTY, `--json` and MCP runs fall through to {@link parseDeploySource}'s
 * hard error, so scripts, `--yes` and CI keep the strict contract where a wrong guess is unattended.
 */
export const resolveDeploySource = async (from: string | undefined): Promise<DeploySource> => {
  if (from || !canPromptForDeploySource()) return parseDeploySource(from)

  return pickDeploySource()
}
