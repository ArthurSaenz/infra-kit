import type { ExperimentNameValue } from './types'
import { EXPERIMENT_STATE } from './types'

export const DEBUG_EXPERIMENTS_KEY = 'DEBUG_EXPERIMENTS'

/**
 * The structure of experiment ID naming is `nameOfExperiment` + _ + JIRA ticket number + type (optional) VWO
 */
export enum ExperimentsNames {
  demoExperiment_950 = 'demoExperiment_950', // https://marcom-it.atlassian.net/browse/HULY-950
  exampleExperiment_123 = 'exampleExperiment_123', // https://marcom-it.atlassian.net/browse/HULY-950
  moreRoomImages_987 = '12', // https://marcom-it.atlassian.net/browse/HULY-987
  passengersConfirmation_1887 = '59', // https://marcom-it.atlassian.net/browse/HULY-1887
}

export const initialExperimentsValues: Record<ExperimentsNames, ExperimentNameValue> = {
  [ExperimentsNames.demoExperiment_950]: EXPERIMENT_STATE.DEFAULT,
  [ExperimentsNames.exampleExperiment_123]: EXPERIMENT_STATE.PENDING,
  [ExperimentsNames.moreRoomImages_987]: EXPERIMENT_STATE.DEFAULT,
  [ExperimentsNames.passengersConfirmation_1887]: EXPERIMENT_STATE.DEFAULT,
}

export const defaultExperimentsValues: Record<ExperimentsNames, ExperimentNameValue> = {
  [ExperimentsNames.demoExperiment_950]: EXPERIMENT_STATE.DEFAULT,
  [ExperimentsNames.exampleExperiment_123]: EXPERIMENT_STATE.DEFAULT,
  [ExperimentsNames.moreRoomImages_987]: EXPERIMENT_STATE.DEFAULT,
  [ExperimentsNames.passengersConfirmation_1887]: EXPERIMENT_STATE.DEFAULT,
}
