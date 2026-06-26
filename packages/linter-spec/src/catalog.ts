import type { DetectorId } from '#root/detector-ids'
import { aiAgenticDetectors } from '#root/detectors/ai-agentic'
import { changePatternsDetectors } from '#root/detectors/change-patterns'
import { codeQualityDetectors } from '#root/detectors/code-quality'
import { complexityDetectors } from '#root/detectors/complexity'
import { dependencyDetectors } from '#root/detectors/dependency'
import { metricsDetectors } from '#root/detectors/metrics'
import { moduleDesignDetectors } from '#root/detectors/module-design'
import { runtimeSafetyDetectors } from '#root/detectors/runtime-safety'
import type { DetectorGroup } from '#root/groups'
import { DETECTOR_GROUPS } from '#root/groups'
import type { Detector } from '#root/types'

/** Every detector, flat, in group order. */
export const allDetectors: Detector[] = [
  ...dependencyDetectors,
  ...moduleDesignDetectors,
  ...codeQualityDetectors,
  ...complexityDetectors,
  ...changePatternsDetectors,
  ...runtimeSafetyDetectors,
  ...metricsDetectors,
  ...aiAgenticDetectors,
]

/** All detectors keyed by id — the single typed lookup table (ids are the catalog's source of truth). */
export const detectors = Object.fromEntries(
  allDetectors.map((detector) => {
    return [detector.id, detector]
  }),
) as Record<DetectorId, Detector>

/** Detectors bucketed by their group. */
export const detectorsByGroup: Record<DetectorGroup, Detector[]> = DETECTOR_GROUPS.reduce(
  (acc, group) => {
    acc[group] = allDetectors.filter((detector) => {
      return detector.group === group
    })

    return acc
  },
  {} as Record<DetectorGroup, Detector[]>,
)
