import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'

import { ls } from '../ls-slim'
import { isSSR } from '../ssr'
import { Experiment } from './experiment'
import type { ExperimentNameValue, Variants } from './types'
import { EXPERIMENT_STATE } from './types'

const DEBUG_EXPERIMENTS_KEY = 'DEBUG_EXPERIMENTS'

declare global {
  interface Window {
    VWO?: any[]
    _vwo_exp?: Record<string, any>
    _vwo_exp_ids?: string[]
    _app?: Record<string, any>
  }
}

export interface ExperimentDefinition {
  /** VWO experiment ID, read from window._vwo_exp[id].combination_chosen. */
  vwoId: string
  /** State shown before VWO resolves. Defaults to 'default'. */
  initial?: 'pending' | 'default'
}

export type ExperimentsConfig = Record<string, ExperimentDefinition>

type NamesOf<T extends ExperimentsConfig> = { [K in keyof T]: T[K]['vwoId'] }

/**
 * Statically injects a project's experiments map into web-toolkit and returns
 * a fully-typed module bound to those keys.
 *
 * Each project calls this exactly once with its own config. The returned
 * `ExperimentsNames`, `experimentsModel` and `FeatureFlag` are project-local —
 * autocomplete and `useExperimentByName` are narrowed to the keys declared here,
 * so the toolkit itself stays data-free and can be shared across repos.
 *
 * Under the hood the factory:
 *  - Builds an `ExperimentsNames` const map ({ key → vwoId }) for call-site use.
 *  - Creates a Jotai atom seeded with each entry's `initial` state.
 *  - Wires `useExperimentsInit` to VWO (`window.VWO` / `window._vwo_exp`) in
 *    production, and to the `DEBUG_EXPERIMENTS` localStorage override in debug.
 *  - Exposes `window._app.experiments` (`data`, `setVariant`, `reset`) in debug
 *    so QA can flip variants from the browser console.
 *
 * Pass `<const T>` is used so literal `vwoId` strings survive type inference —
 * required for safe indexed access under `noUncheckedIndexedAccess`.
 *
 * @param config - Map of `experimentKey → { vwoId, initial? }`. `vwoId` must
 *   match the experiment ID returned by VWO (`window._vwo_exp[id].combination_chosen`).
 *   `initial` defaults to `'default'`; use `'pending'` to render the `_pending`
 *   variant until VWO resolves.
 *
 * @example
 * // apps/client/ui/src/lib/experiments/index.ts
 * import { defineExperiments } from '@pkg/web-toolkit'
 *
 * export const { ExperimentsNames, experimentsModel, FeatureFlag } = defineExperiments({
 *   moreRoomImages_987:        { vwoId: '12' },
 *   passengersConfirmation_1887: { vwoId: '59', initial: 'pending' },
 * })
 *
 * // In a component:
 * const variant = experimentsModel.useExperimentByName(ExperimentsNames.moreRoomImages_987)
 */
export const defineExperiments = <const T extends ExperimentsConfig>(config: T) => {
  type IdValue = T[keyof T]['vwoId']

  const ExperimentsNames = {} as NamesOf<T>
  const idsList: IdValue[] = []
  const initialExperimentsValues = {} as Record<IdValue, ExperimentNameValue>
  const defaultExperimentsValues = {} as Record<IdValue, ExperimentNameValue>

  for (const [key, def] of Object.entries(config) as Array<[keyof T & string, ExperimentDefinition]>) {
    const id = def.vwoId as IdValue

    ExperimentsNames[key as keyof T] = id as NamesOf<T>[keyof T]
    idsList.push(id)
    initialExperimentsValues[id] = def.initial === 'pending' ? EXPERIMENT_STATE.PENDING : EXPERIMENT_STATE.DEFAULT
    defaultExperimentsValues[id] = EXPERIMENT_STATE.DEFAULT
  }

  if (new Set(idsList).size !== idsList.length) {
    console.warn('defineExperiments: duplicate vwoId values detected', idsList)
  }

  const $experimentsValuesMap = atom(initialExperimentsValues)

  const getDevDebugExperimentsValues = (): Record<IdValue, ExperimentNameValue> => {
    const experimentsLS = ls.get(DEBUG_EXPERIMENTS_KEY) as Record<string, string> | null

    if (!experimentsLS) {
      console.warn(`${DEBUG_EXPERIMENTS_KEY} is empty or undefined in LocalStorage`)

      return { ...defaultExperimentsValues }
    }

    const values = { ...defaultExperimentsValues }

    for (const [experimentId, variantId] of Object.entries(experimentsLS)) {
      if (experimentId in defaultExperimentsValues) {
        values[experimentId as IdValue] = variantId as ExperimentNameValue

        console.warn(`Experiment ID - ${experimentId} is mocked with value - ${variantId}`)
      } else {
        console.warn(
          `Experiment ID - ${experimentId} is not implemented in codebase or not defined in initial list in code!`,
        )
      }
    }

    return values
  }

  const attachImplementedExperiments = () => {
    window._app = window._app || {}
    window._app.experiments = {
      data: { ...ExperimentsNames },
      reset: () => {
        ls.remove(DEBUG_EXPERIMENTS_KEY)
        // eslint-disable-next-line no-console
        console.log('Refresh the page!')
      },
      setVariant: (exp: IdValue, variant: ExperimentNameValue) => {
        const data = ls.get(DEBUG_EXPERIMENTS_KEY)

        ls.set(DEBUG_EXPERIMENTS_KEY, { ...(data || {}), [exp]: variant })
        // eslint-disable-next-line no-console
        console.log('Refresh the page!')
      },
    }
  }

  const applyVwoUpdate = (prev: Record<IdValue, ExperimentNameValue>) => {
    let next: Record<IdValue, ExperimentNameValue> | null = null

    for (const expId of idsList) {
      const v = window._vwo_exp?.[expId]?.combination_chosen

      if (v && prev[expId] !== v) {
        next ||= { ...prev }
        next[expId] = v as ExperimentNameValue
      }
    }

    return next ?? prev
  }

  const useExperimentsInit = (args: { isEnabledDebug: boolean }) => {
    const { isEnabledDebug } = args
    const setOptimizeAtom = useSetAtom($experimentsValuesMap)

    useEffect(() => {
      const onReadyVwo = () => {
        setOptimizeAtom(applyVwoUpdate)
      }

      window.VWO = window.VWO || []

      if (isSSR) return

      if (isEnabledDebug) {
        // eslint-disable-next-line react-web-api/no-leaked-timeout
        setTimeout(() => {
          attachImplementedExperiments()
          setOptimizeAtom(getDevDebugExperimentsValues())
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
    }, [])
  }

  const useExperimentByName = (id: IdValue): ExperimentNameValue => {
    const values = useAtomValue($experimentsValuesMap)

    return values[id]
  }

  const FeatureFlag = (props: { variants: Variants; experimentId: IdValue }) => {
    const { variants, experimentId } = props
    const values = useAtomValue($experimentsValuesMap)

    return <Experiment value={values[experimentId]} variants={variants} />
  }

  return {
    ExperimentsNames,
    experimentsModel: {
      $experimentsValuesMap,
      useExperimentsInit,
      useExperimentByName,
    },
    FeatureFlag,
  }
}
