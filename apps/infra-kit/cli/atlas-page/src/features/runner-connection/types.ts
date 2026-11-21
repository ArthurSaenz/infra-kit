import type { AtlasSnapshot } from '../../lib/atlas-contract'

export type PollerStatus = 'connecting' | 'live' | 'disconnected' | 'outdated'

export interface PollerState {
  status: PollerStatus
  snapshot: AtlasSnapshot | null
  /** When the runner last answered, 200 or 304 alike. */
  lastUpdate: Date | null
}

export interface PollResponse {
  status: number
  headers: { get: (name: string) => string | null }
  json: () => Promise<unknown>
}

export type PollFetch = (
  url: string,
  init: { headers: Record<string, string>; cache: 'no-store' },
) => Promise<PollResponse>

export interface VisibilitySource {
  isHidden: () => boolean
  /** Returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void
}

export interface PollerTimers {
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface PollerDeps {
  fetch: PollFetch
  visibility: VisibilitySource
  timers: PollerTimers
  now: () => Date
  /** Called only when something the page draws changed: a new revision or a new status. */
  onChange: (state: PollerState) => void
}

export interface Poller {
  start: () => void
  stop: () => void
}

export interface ConnectionBannerComponentProps {
  status: PollerStatus
  lastUpdate: Date | null
  className?: string
}
