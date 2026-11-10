export interface RestartSchedulerDeps {
  /** How long a key stays quiet before its work runs: a burst of saves collapses into one run. */
  debounceMs: number
  /** Once true, nothing is scheduled and an armed timer does nothing when it fires. */
  isStopped: () => boolean
  /** A scheduled unit of work rejected. Reported, never thrown. */
  onError: (key: string, error: unknown) => void
}

/**
 * The debounce timers of the watch loop and the changed files each pending restart was triggered by.
 * It decides WHEN a restart runs and WHAT changed; the runner supplies what a restart is.
 *
 * The changed files are accumulated here rather than carried in the scheduled closure because
 * {@link RestartScheduler.debounce} REPLACES the closure for a key it sees again, and one shared-lib
 * save deliberately produces two events on the same key: the package's own dist, then moments later the
 * dependent app's. The package event is the stale one and it arrives FIRST — a closure-carried flag
 * would be overwritten by the app event and the restart would print a green line for a reload that did
 * not happen.
 */
export class RestartScheduler {
  /** Key of the restart-every-app fail-safe; never an app name (apps are folder names). */
  private static readonly ALL_KEY = '__packages__'

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly changes = new Map<string, Set<string>>()
  private readonly deps: RestartSchedulerDeps

  constructor(deps: RestartSchedulerDeps) {
    this.deps = deps
  }

  /** Is a restart of every app pending? A change to any one app is then already covered by it. */
  isAllPending(): boolean {
    return this.timers.has(RestartScheduler.ALL_KEY)
  }

  /**
   * Debounce a restart of the unit named `key`, recording `filePath` among what triggered it. `work`
   * receives every file recorded for the key by the time it fires, so the whole burst is accounted for.
   */
  schedule(key: string, filePath: string, work: (changed: string[]) => Promise<void>): void {
    this.mark(key, filePath)
    this.debounce(key, () => {
      return work(this.take(key))
    })
  }

  /**
   * Debounce one restart of everything, absorbing any restart still pending under `keys`: those units
   * are about to restart anyway, and their recorded changes belong to this restart's report.
   */
  scheduleAll(keys: string[], filePath: string, work: (changed: string[]) => Promise<void>): void {
    const all = RestartScheduler.ALL_KEY

    this.mark(all, filePath)

    for (const key of keys) {
      const pending = this.timers.get(key)

      if (pending) {
        clearTimeout(pending)
        this.timers.delete(key)
      }

      for (const file of this.take(key)) this.mark(all, file)
    }

    this.debounce(all, () => {
      return work(this.take(all))
    })
  }

  /**
   * Cancel any pending timer for `key` and start a fresh one. Errors from the scheduled work are
   * reported through `onError`, never thrown.
   */
  debounce(key: string, work: () => Promise<void>): void {
    if (this.deps.isStopped()) return

    const existing = this.timers.get(key)

    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.timers.delete(key)
      if (this.deps.isStopped()) return
      work().catch((error: unknown) => {
        this.deps.onError(key, error)
      })
    }, this.deps.debounceMs)

    this.timers.set(key, timer)
  }

  /** Disarm every pending restart — the first step of teardown. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)

    this.timers.clear()
  }

  private mark(key: string, filePath: string): void {
    const existing = this.changes.get(key)

    if (existing) existing.add(filePath)
    else this.changes.set(key, new Set([filePath]))
  }

  private take(key: string): string[] {
    const files = this.changes.get(key)

    this.changes.delete(key)

    return files ? [...files] : []
  }
}
