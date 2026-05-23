import type { ExperimentNameValue, Variants } from './types'
import { EXPERIMENT_STATE } from './types'

interface ExperimentProps {
  value: ExperimentNameValue
  variants: Variants
}

export const Experiment = (props: ExperimentProps): React.ReactElement => {
  const { value, variants } = props

  if (value === EXPERIMENT_STATE.PENDING) {
    return variants._pending ? <>{variants._pending}</> : <></>
  }

  if (value === EXPERIMENT_STATE.DEFAULT || !Object.keys(variants).includes(value)) {
    return <>{variants._default}</>
  }

  return <>{variants[value]}</>
}

export interface ExperimentVariantArgs {
  value: ExperimentNameValue
  variants: {
    _default: unknown
    _pending?: unknown
  } & Record<string, unknown>
}

export const getExperimentVariant = (args: ExperimentVariantArgs) => {
  const { value, variants } = args

  if (value === EXPERIMENT_STATE.PENDING) {
    return variants._pending ? variants._pending : null
  }

  if (value === EXPERIMENT_STATE.DEFAULT || !Object.keys(variants).includes(value)) {
    return variants._default
  }

  return variants[value]
}
