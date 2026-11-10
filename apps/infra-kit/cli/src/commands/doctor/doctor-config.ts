import { getInfraKitConfig, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'

/**
 * The merged infra-kit config, read ONCE per `doctor()` run and threaded into every check that needs
 * it. Either half is populated, never both.
 *
 * Reading it once is not an optimization, it is the fix for a real race: two checks each called
 * `resetInfraKitConfigCache()` and were dispatched together inside one `Promise.all`, so they
 * clobbered the same module-level cache slot — whichever reset landed second could blow away a config
 * the other had just populated. One read, no shared slot.
 */
export interface DoctorConfig {
  config: InfraKitConfig | null
  error: Error | null
}

/**
 * Read the merged config once for the whole run, resetting the module cache exactly once so `doctor`
 * always reports what is on disk NOW (it is the command a user runs right after editing the file).
 * Never throws: a broken config is the thing `doctor` exists to explain, so it is captured and
 * threaded rather than allowed to abort the run.
 *
 * @example
 * await readDoctorConfig() // => { config: { environments: ['dev'], … }, error: null }
 * //                       // broken file => { config: null, error: Error('…unrecognized key…') }
 */
export const readDoctorConfig = async (): Promise<DoctorConfig> => {
  try {
    resetInfraKitConfigCache()

    return { config: await getInfraKitConfig(), error: null }
  } catch (err) {
    return { config: null, error: err as Error }
  }
}
