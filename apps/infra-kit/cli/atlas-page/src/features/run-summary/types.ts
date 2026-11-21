import type { AtlasSnapshot } from '../../lib/atlas-contract'
import type { LogLink } from '../../lib/log-links'

export interface RunFacts {
  pid: number
  siteCount: number
  backendCount: number
  /** `HH:MM:SS` of the runner's last answer; `null` before the first one. */
  checkedAt: string | null
}

export interface RunFactsComponentProps {
  facts: RunFacts
  className?: string
}

export interface RunSummaryComponentProps {
  /** `null` until the runner has answered once: the header then shows the brand and legend only. */
  facts: RunFacts | null
  logLinks: LogLink[]
  className?: string
}

export interface RunSummaryContainerProps {
  snapshot: AtlasSnapshot | null
  lastUpdate: Date | null
}
