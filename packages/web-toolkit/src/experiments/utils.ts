import { ls } from '../ls-slim'
import { ExperimentsNames, defaultExperimentsValues } from './constants'
import type { ExperimentNameValue } from './types'

const DEBUG_EXPERIMENTS_KEY = 'DEBUG_EXPERIMENTS'

/**
 * @see DEBUG
 * @description Debug utils for test and assign experiment variants
 */

export const getDevDebugExperimentsValues = (): Record<ExperimentsNames, ExperimentNameValue> | null => {
  const experimentsLS = ls.get(DEBUG_EXPERIMENTS_KEY)

  if (!experimentsLS) {
    console.warn(`${DEBUG_EXPERIMENTS_KEY} is empty or don't undefined in LocalStorage`)

    return { ...defaultExperimentsValues }
  }

  const values = { ...defaultExperimentsValues }

  for (const [experimentId, variantId] of Object.entries(experimentsLS as Record<string, string>)) {
    const existsInInitial = experimentId in defaultExperimentsValues

    if (existsInInitial) {
      values[experimentId as ExperimentsNames] = variantId as ExperimentNameValue
      console.warn(`Experiment ID - ${experimentId} is mocked with value - ${variantId}`)
    } else {
      console.warn(
        `Experiment ID - ${experimentId} is not implemented in codebase or not defined in initial list in code!`,
      )
    }
  }

  return values
}

export const attachImplementedExperiments = () => {
  window._app = window._app || {}
  window._app.experiments = {
    data: { ...ExperimentsNames },
    reset: () => {
      ls.remove(DEBUG_EXPERIMENTS_KEY)
      // eslint-disable-next-line no-console
      console.log('Refresh the page!')
    },
    setVariant: (exp: string, variant: string) => {
      const data = ls.get(DEBUG_EXPERIMENTS_KEY)

      ls.set(DEBUG_EXPERIMENTS_KEY, { ...(data || {}), [exp]: variant })
      // eslint-disable-next-line no-console
      console.log('Refresh the page!')
    },
  }
}
