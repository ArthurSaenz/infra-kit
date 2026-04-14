import { useAtomValue } from 'jotai'

import type { ExperimentsNames } from './constants'
import { Experiment } from './experiment'
import { $experimentsValuesMap } from './model'
import type { Variants } from './types'

interface FeatureFlagProps {
  variants: Variants
  experimentId: ExperimentsNames
}

export const FeatureFlag = (props: FeatureFlagProps) => {
  const { variants, experimentId } = props

  const featuresFlagsValues = useAtomValue($experimentsValuesMap)

  return <Experiment value={featuresFlagsValues[experimentId]} variants={variants} />
}
