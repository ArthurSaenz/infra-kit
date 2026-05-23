export type Variants = {
  _default: React.ReactNode
  _pending?: React.ReactNode
} & Record<string, React.ReactNode>

export const EXPERIMENT_STATE = {
  PENDING: 'pending',
  DEFAULT: 'default',
}

export type ExperimentNameValue = string | (typeof EXPERIMENT_STATE)['PENDING'] | (typeof EXPERIMENT_STATE)['DEFAULT']
