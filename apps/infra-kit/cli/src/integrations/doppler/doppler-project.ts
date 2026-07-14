import { $ } from 'zx'

import { classifyDopplerAuthFailure, classifyDopplerFailure } from 'src/integrations/doppler/doppler-errors'
import { extractStderr } from 'src/lib/errors/operation-error'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

/**
 * Hard upper bound for the Doppler probe. It runs only on the diagnostic path (`doctor`), but a hung
 * VPN/connection must not stall it.
 */
const DOPPLER_PROBE_TIMEOUT_MS = 5_000

/**
 * The one secret every Doppler payload carries, whose value is the config the token is scoped to
 * (SPIKE-0 Q2 — the CONFIG, not `DOPPLER_ENVIRONMENT`, which can differ: config `dev_personal` lives
 * in environment `dev`). Reading it back is what turns a liveness probe into a SCOPE probe.
 */
const SCOPE_KEY = 'DOPPLER_CONFIG'

/**
 * Resolve Doppler project name from infra-kit.json at the project root
 */
export const getDopplerProject = async (): Promise<string> => {
  const { envManagement } = await getInfraKitConfig()

  return envManagement.config.name
}

/**
 * What a service token turned out to be, once Doppler was asked.
 *
 * `'unreachable'` is the load-bearing one and it means "COULDN'T TELL", never "bad": network,
 * timeout, VPN, Doppler down, a CLI that isn't installed. A caller that renders it as a definitive
 * verdict would tell a developer on a plane that their token was revoked. (Same `null`-vs-`[]`
 * contract the deleted `listDopplerProjects` carried, in enum form.)
 */
export type EnvTokenProbeOutcome = 'valid' | 'revoked' | 'mis-scoped' | 'unreachable'

export interface EnvTokenProbe {
  outcome: EnvTokenProbeOutcome
  /** The config the token actually resolved to, when Doppler told us. Never a token value. */
  scopedTo?: string
}

interface EnvTokenProbeArgs {
  /**
   * The child environment carrying the token — built by `buildDopplerChildEnv`, which scrubs the
   * inherited `DOPPLER_*` vars and sets ours. Passed in rather than built here so the token travels
   * by ENV and never by argv (`ps` shows argv to every user on the box), and so this module stays
   * free of a cycle back through `commands/env-load`.
   */
  childEnv: NodeJS.ProcessEnv
  project: string
  config: string
}

/**
 * The cheapest combined VALIDITY + SCOPE probe of a Doppler service token (SPIKE-0): read one secret
 * back — the payload's own `DOPPLER_CONFIG` — and compare it to the config we asked for.
 *
 * `doppler me` is NOT enough: it works under a service token but returns no project/config, so it can
 * only prove the token is alive, never that it points where we think. One `secrets get` answers both
 * questions in one round trip, and the CLI enforces the scope for us on the wire.
 *
 * Never throws. Every failure becomes an outcome, and an unrecognized one becomes `'unreachable'`
 * ("couldn't tell") rather than a guess — the caller is `doctor`, whose whole value is that its
 * verdicts are true.
 *
 * @example
 * await probeEnvToken({ childEnv, project: 'api', config: 'dev' })
 * // => { outcome: 'valid', scopedTo: 'dev' }
 * // revoked token   => { outcome: 'revoked' }
 * // token for prod  => { outcome: 'mis-scoped' }
 * // offline         => { outcome: 'unreachable' }
 */
export const probeEnvToken = async ({ childEnv, project, config }: EnvTokenProbeArgs): Promise<EnvTokenProbe> => {
  const prevQuiet = $.quiet

  $.quiet = true
  try {
    const result = await $({
      env: childEnv,
    })`doppler secrets get ${SCOPE_KEY} --plain --project ${project} --config ${config}`.timeout(
      DOPPLER_PROBE_TIMEOUT_MS,
    )
    const scopedTo = result.stdout.trim()

    // Exit 0 with a DIFFERENT config would mean the CLI's own scope enforcement let a mis-scoped token
    // through — belt and braces, but this is the check that would catch it.
    if (scopedTo !== config) return { outcome: 'mis-scoped', scopedTo }

    return { outcome: 'valid', scopedTo }
  } catch (error: unknown) {
    return { outcome: classifyProbeFailure(error) }
  } finally {
    $.quiet = prevQuiet
  }
}

/**
 * Turn a failed probe into an outcome. Only the two auth-class markers are definitive; a
 * project/config not-found is a config bug rather than a token verdict, so it collapses to
 * `'unreachable'` too — the token check must not claim a token is bad because the PROJECT name is.
 */
const classifyProbeFailure = (error: unknown): EnvTokenProbeOutcome => {
  const stderr = extractStderr(error) ?? (error instanceof Error ? error.message : String(error))

  if (classifyDopplerFailure(stderr) !== 'auth') return 'unreachable'

  return classifyDopplerAuthFailure(stderr) ?? 'unreachable'
}
