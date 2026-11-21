import { atom } from 'jotai'

import { ATLAS_CONTRACT_VERSION } from '../../lib/atlas-contract'
import type { AtlasSnapshot } from '../../lib/atlas-contract'
import { httpGet } from '../../lib/http-client'
import type { PollFetch, Poller, PollerDeps, PollerState } from './types'

export const STATE_URL = '/__atlas/state.json'
export const POLL_MS = 2000
export const MAX_BACKOFF_MS = 10_000
/** One miss is a vite restart in flight; two in a row is a runner that went away. */
export const FAILURES_BEFORE_DISCONNECT = 2

/** 2 s while healthy; once disconnected 2 → 4 → 8 → 10 s, so a dead runner is not hammered. */
export const delayAfter = (failures: number): number => {
  if (failures < FAILURES_BEFORE_DISCONNECT) return POLL_MS

  return Math.min(POLL_MS * 2 ** (failures - FAILURES_BEFORE_DISCONNECT), MAX_BACKOFF_MS)
}

type Outcome = { kind: 'fresh'; snapshot: AtlasSnapshot; etag: string | null } | { kind: 'same' } | { kind: 'failed' }

const isSnapshot = (body: unknown): body is AtlasSnapshot => {
  return typeof body === 'object' && body !== null && 'revision' in body && 'sites' in body
}

const fetchOnce = async (fetch: PollFetch, etag: string | null): Promise<Outcome> => {
  try {
    const response = await fetch(STATE_URL, {
      headers: etag === null ? {} : { 'If-None-Match': etag },
      cache: 'no-store',
    })

    if (response.status === 304) return { kind: 'same' }
    if (response.status !== 200) return { kind: 'failed' }

    const body = await response.json()

    return isSnapshot(body) ? { kind: 'fresh', snapshot: body, etag: response.headers.get('ETag') } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * Polls the runner's snapshot. Every browser API arrives through `deps`, so the whole schedule — repaint
 * rules, the disconnect banner, the backoff and the hidden-tab pause — runs under vitest without a DOM.
 */
export const createPoller = (deps: PollerDeps): Poller => {
  let state: PollerState = { status: 'connecting', snapshot: null, lastUpdate: null }
  let etag: string | null = null
  let failures = 0
  let timer: unknown = null
  let inFlight = false
  let stopped = true
  let unsubscribe: (() => void) | null = null

  const publish = (next: PollerState): void => {
    state = next
    deps.onChange(state)
  }

  const schedule = (ms: number): void => {
    if (stopped || deps.visibility.isHidden()) return
    timer = deps.timers.setTimeout(tick, ms)
  }

  const apply = (outcome: Outcome): void => {
    if (outcome.kind === 'failed') {
      failures += 1
      if (failures === FAILURES_BEFORE_DISCONNECT) publish({ ...state, status: 'disconnected' })

      return
    }

    failures = 0

    const lastUpdate = deps.now()

    if (outcome.kind === 'same') {
      // A 304 changes nothing on screen unless it ends a disconnect; the timestamp is kept for the banner.
      if (state.status === 'live') state = { ...state, lastUpdate }
      else publish({ ...state, status: 'live', lastUpdate })

      return
    }

    etag = outcome.etag ?? `"${outcome.snapshot.revision}"`

    // A page left open across a CLI self-update must not draw a shape it does not understand.
    const status = outcome.snapshot.v === ATLAS_CONTRACT_VERSION ? 'live' : 'outdated'
    const changed = outcome.snapshot.revision !== state.snapshot?.revision || status !== state.status

    if (changed) publish({ status, snapshot: outcome.snapshot, lastUpdate })
    else state = { ...state, lastUpdate }
  }

  async function tick(): Promise<void> {
    timer = null
    if (inFlight) return
    inFlight = true

    const outcome = await fetchOnce(deps.fetch, etag)

    inFlight = false
    if (stopped) return
    apply(outcome)
    if (state.status !== 'outdated') schedule(delayAfter(failures))
  }

  const cancelTimer = (): void => {
    if (timer === null) return
    deps.timers.clearTimeout(timer)
    timer = null
  }

  const onVisibility = (): void => {
    if (deps.visibility.isHidden()) {
      cancelTimer()

      return
    }

    if (timer === null && !inFlight) void tick()
  }

  return {
    start: () => {
      if (!stopped) return
      stopped = false
      unsubscribe = deps.visibility.subscribe(onVisibility)
      if (!deps.visibility.isHidden()) void tick()
    },
    stop: () => {
      stopped = true
      cancelTimer()
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

/** The one place the feature touches `document` and the timers; the poller itself stays pure. */
const createBrowserPoller = (onChange: (state: PollerState) => void): Poller => {
  return createPoller({
    fetch: httpGet,
    visibility: {
      isHidden: () => {
        return document.visibilityState === 'hidden'
      },
      subscribe: (listener) => {
        document.addEventListener('visibilitychange', listener)

        return () => {
          document.removeEventListener('visibilitychange', listener)
        }
      },
    },
    timers: {
      setTimeout: (run, ms) => {
        return window.setTimeout(run, ms)
      },
      clearTimeout: (handle) => {
        window.clearTimeout(handle as number)
      },
    },
    now: () => {
      return new Date()
    },
    onChange,
  })
}

export const $connection = atom<PollerState>({ status: 'connecting', snapshot: null, lastUpdate: null })

// Polling is tied to the atom having a reader: it starts with the first subscriber and stops with the last.
$connection.onMount = (setConnection) => {
  const poller = createBrowserPoller(setConnection)

  poller.start()

  return () => {
    poller.stop()
  }
}
