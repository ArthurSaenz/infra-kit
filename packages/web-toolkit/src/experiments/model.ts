import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'

import { isSSR } from '../ssr'
import { ExperimentsNames, initialExperimentsValues } from './constants'
import type { ExperimentNameValue } from './types'
import { EXPERIMENT_STATE } from './types'
import { attachImplementedExperiments, getDevDebugExperimentsValues } from './utils'

declare global {
  interface Window {
    VWO?: any[]
    _vwo_exp?: Record<string, any>
    _vwo_exp_ids?: string[]
    _app?: Record<string, any>
  }
}

/**
 * @see DEBUG
 * @description Debug utils for test and assign experiment variants
 */
export const $experimentsValuesMap = atom(initialExperimentsValues)

interface UseExperimentsInitArgs {
  isEnabledDebug: boolean
}

export const useExperimentsInit = (args: UseExperimentsInitArgs) => {
  const { isEnabledDebug } = args

  const setOptimizeAtom = useSetAtom($experimentsValuesMap)

  useEffect(() => {
    const onReadyVwo = () => {
      const values = {} as Record<ExperimentsNames, ExperimentNameValue>

      // eslint-disable-next-line sonarjs/no-unused-vars
      for (const [_, expId] of Object.entries(ExperimentsNames)) {
        const newValue = window._vwo_exp?.[expId]?.combination_chosen

        if (newValue) {
          values[expId] = newValue
        }
      }

      setOptimizeAtom((prevValues) => {
        return { ...prevValues, ...values }
      })
    }

    window.VWO = window.VWO || []

    if (!isSSR) {
      if (isEnabledDebug) {
        // eslint-disable-next-line react-web-api/no-leaked-timeout
        setTimeout(() => {
          attachImplementedExperiments()

          const data = getDevDebugExperimentsValues()

          if (data) setOptimizeAtom(data as Record<ExperimentsNames, ExperimentNameValue>)
        }, 1500)
      } else {
        window.VWO.push(['onVariationApplied', onReadyVwo])
        window.VWO.push([
          'isLoaded',
          () => {
            // eslint-disable-next-line no-console
            console.info('VWO activate', window._vwo_exp_ids)
          },
        ])
      }
    }
  }, [])
}

export const useExperimentByName = (id: ExperimentsNames): ExperimentNameValue => {
  const featuresFlagsValues = useAtomValue($experimentsValuesMap)

  return featuresFlagsValues[id]
}

/**
 * Atom that sets the default values for loaded experiments in VWO.
 * @remarks
 * This atom iterates through the `ExperimentsNames` object and checks if the experiment is enabled in VWO.
 * If the experiment is not enabled, it sets the value to `EXPERIMENT_STATE.DEFAULT`.
 * The resulting values are then merged with the previous values in `$experimentsValuesMap`.
 * @returns The resulting merged values.
 */
export const setLoaddedDefaultExperimentsVWO = atom(null, (_, set) => {
  const values = {} as Record<ExperimentsNames, ExperimentNameValue>

  // eslint-disable-next-line sonarjs/no-unused-vars
  for (const [_, expId] of Object.entries(ExperimentsNames)) {
    const enabledExperiments = window._vwo_exp_ids || []

    if (!enabledExperiments.includes(expId)) {
      values[expId] = EXPERIMENT_STATE.DEFAULT
    }
  }

  set($experimentsValuesMap, (prevValues) => {
    return { ...prevValues, ...values }
  })
})
