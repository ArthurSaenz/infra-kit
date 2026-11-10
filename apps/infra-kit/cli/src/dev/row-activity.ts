/** The rpm window: a request older than this no longer counts toward a row's `N/min`. */
const RATE_WINDOW_MS = 60_000

export interface RowActivityDeps {
  /** A row's error count so far (the log sink's counter). */
  errorsOf: (tag: string) => number
  /** Called once per row, on its first error. */
  onFirstError: (tag: string) => void
}

/**
 * The two live numbers a panel row carries besides its health: requests in the last minute, and
 * errors — with the 0 → >0 edge of the error count announced exactly once per row.
 */
export class RowActivity {
  private readonly requestTimes = new Map<string, number[]>()
  private readonly firstErrorSeen = new Set<string>()
  private readonly deps: RowActivityDeps

  constructor(deps: RowActivityDeps) {
    this.deps = deps
  }

  recordRequest(tag: string, at: number): void {
    // Mutate in place: spreading into a fresh array copied the whole window on every single request.
    const window = this.requestTimes.get(tag)

    if (window) window.push(at)
    else this.requestTimes.set(tag, [at])
  }

  /**
   * Drop request timestamps older than the rpm window. Must run on every tick, painting or not: a
   * window pruned only when a panel repaints is never pruned on a piped run, and grows without bound
   * on exactly the runs that live longest.
   */
  prune(now: number): void {
    const cutoff = now - RATE_WINDOW_MS

    for (const [tag, times] of this.requestTimes) {
      this.requestTimes.set(
        tag,
        times.filter((at) => {
          return at > cutoff
        }),
      )
    }
  }

  /** Requests recorded for the row since the last {@link RowActivity.prune}. */
  requestsPerMinute(tag: string): number {
    return (this.requestTimes.get(tag) ?? []).length
  }

  /**
   * This row's error count, announcing the 0 → >0 EDGE once.
   *
   * The counter alone is not enough, and the reason is the honest cost of a liveness dot: a frontend
   * that fails to compile still serves and still answers vite's ping, so its dot stays a truthful green
   * while the app is unusable. `⚠ N` is then the only thing on screen that disagrees — and a number
   * quietly ticking up in a panel corner is not a thing anyone notices. The edge is; it also reaches a
   * non-TTY run, which has no panel at all.
   */
  errors(tag: string): number {
    const errors = this.deps.errorsOf(tag)

    if (errors > 0 && !this.firstErrorSeen.has(tag)) {
      this.firstErrorSeen.add(tag)
      this.deps.onFirstError(tag)
    }

    return errors
  }
}
