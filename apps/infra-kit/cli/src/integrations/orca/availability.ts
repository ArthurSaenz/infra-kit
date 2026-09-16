import { logger } from 'src/lib/logger'

import { OrcaAbsentError, runOrca } from './run-orca'

export type OrcaProbe = 'absent' | 'unreachable' | 'ready'

interface OrcaStatus {
  app?: { running?: boolean }
  runtime?: { reachable?: boolean; appVersion?: string }
}

/**
 * Three-state readiness probe behind every fallback branch and doctor's Orca row.
 * `ready` needs both halves: a headless `orca serve` runtime is reachable but has
 * no UI to adopt a tab, so it reads as `unreachable`. `runtime.appVersion` is the
 * only trustworthy version source (`ORCA_APP_VERSION` is spawn-time stale).
 */
export const probeOrca = async (): Promise<OrcaProbe> => {
  try {
    const status = await runOrca<OrcaStatus>(['status'])

    logger.debug({ appVersion: status.runtime?.appVersion }, 'orca: status')

    return status.app?.running === true && status.runtime?.reachable === true ? 'ready' : 'unreachable'
  } catch (error) {
    if (error instanceof OrcaAbsentError) {
      return 'absent'
    }

    logger.debug({ error }, 'orca: status probe failed')

    return 'unreachable'
  }
}
