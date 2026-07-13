/**
 * `infra-kit doctor --fix`: remove the portless routes a DEAD dev-server left behind.
 *
 * A runner deregisters its aliases in `shutdown()` — but `shutdown()` only runs when a signal handler
 * gets to run. `kill -9`, an OOM kill, a force-quit or a power loss all skip it, and alias removal is an
 * async subprocess, so neither the synchronous force-quit path nor a `process.on('exit')` hook could ever
 * do it either. The route then outlives its server: a name in portless's table pointing at a port nothing
 * serves. Hit that URL and you get an opaque 502. This command is the ONLY thing that can clean that up.
 *
 * ─── Why "nothing is listening" is NOT, on its own, a safe test ───
 *
 * It is the test {@link checkPortlessStaleRoutes} already uses, and it is unsound. It is only harmless
 * there because that check merely PRINTS. Making it ACT on the same evidence would delete live routes:
 *
 *   - `assignUiPort` picks a UI port with `getFreePort()`, which binds a probe socket and RELEASES it.
 *     The alias is registered immediately; `vite` only binds the port seconds later, when it boots. For
 *     that entire window a perfectly healthy UI route has nothing listening on its port.
 *   - A UI alias has no dev-context fragment either (only `startOneApp` writes those, and only for
 *     backends), so there is no second source of evidence to fall back on.
 *   - A watch-restart re-closes and re-binds a backend port, so even an API route has brief dead windows.
 *
 * ─── The invariant that makes it safe ───
 *
 * Every one of those false-positives requires a dev session to be RUNNING. So:
 *
 *     prune only when no dev session is alive anywhere on this machine.
 *
 * With nothing running, nothing can be mid-boot or mid-restart, and a port with no listener is genuinely
 * dead. The check is deliberately OVER-eager (see {@link DEV_ACTIVITY_PATTERNS}): a false "dev is running"
 * costs the user one retry, while a false "dev is stopped" deletes a live route. The costs are not
 * symmetric, so neither is the default.
 *
 * Removal is also the mildest possible action: it kills no process, and the next `infra-kit dev` simply
 * re-registers the alias. This module never signals anything.
 */
import { execFileSync } from 'node:child_process'

/** A portless route after its port has been probed on the wire. */
export interface ProbedRoute {
  name: string
  port: number
  /** Is something listening on `port` right now? */
  live: boolean
}

/** What {@link decidePrune} concluded, split by what may actually be touched. */
export interface PruneDecision {
  /** Dead on the wire AND no dev session is running: safe to remove. */
  prunable: string[]
  /**
   * Dead on the wire, but a dev session IS running — so "dead" is unprovable: this is exactly the shape
   * of a UI route whose vite has not bound its port yet. Reported, never removed.
   */
  withheld: string[]
}

/**
 * Decide which routes may be removed. Pure — the whole safety property lives here, so it is testable
 * without a daemon, a process table, or a network.
 *
 * @example
 * decidePrune([{ name: 'x.api', port: 1, live: false }], false) // => { prunable: ['x.api'], withheld: [] }
 * decidePrune([{ name: 'x.api', port: 1, live: false }], true)  // => { prunable: [], withheld: ['x.api'] }
 */
export const decidePrune = (probed: readonly ProbedRoute[], devSessionRunning: boolean): PruneDecision => {
  const dead = probed
    .filter((route) => {
      return !route.live
    })
    .map((route) => {
      return route.name
    })

  // A live dev session makes "nothing is listening" meaningless — it is indistinguishable from a UI that
  // is still booting. Withhold ALL of them rather than guess which are which.
  if (devSessionRunning) return { prunable: [], withheld: dead }

  return { prunable: dead, withheld: [] }
}

/**
 * Command lines of a live `infra-kit dev` RUNNER. Matched against `ps -eo command=`.
 *
 * Deliberately the runner and NOTHING ELSE — not `turbo`, not `vite`. That looks too narrow, and the first
 * draft of this file did include them, reasoning that "over-matching only withholds a prune". Running it
 * disproved that: a crashed session leaves `turbo run dev` orphans alive (exactly the orphan class
 * `managed-child` exists to prevent), so matching turbo means the leftovers of a dead session permanently
 * block the cleanup of that same session's routes — `--fix` would be inert on precisely the machine that
 * needs it. Observed: three orphaned `turbo run dev` processes withholding six dead routes.
 *
 * The runner is also the CORRECT thing to gate on, not merely the workable one. It is the only process that
 * registers a portless alias, so only its presence can mean "a route may be about to become live":
 *   - a route can only appear at all while a runner is alive;
 *   - the booting-UI window (alias registered, vite has not bound the port yet) is bounded by the runner;
 *   - an orphaned turbo/vite registers no new routes, and if one still HOLDS a route's port then the wire
 *     probe already sees it as live and it is never a prune candidate in the first place.
 */
const DEV_RUNNER_PATTERNS: readonly RegExp[] = [/\binfra-kit\s+dev\b/, /cli\.js\s+dev\b/, /dev-server\.(?:js|ts)\b/]

/**
 * Does this `ps` command line belong to a live `infra-kit dev` runner?
 *
 * @example
 * looksLikeDevRunner('node /x/dist/cli.js dev --watch') // => true
 * looksLikeDevRunner('node /x/node_modules/.bin/turbo run dev') // => false — an orphan, not a runner
 */
export const looksLikeDevRunner = (command: string): boolean => {
  return DEV_RUNNER_PATTERNS.some((pattern) => {
    return pattern.test(command)
  })
}

/** Absolute path to `ps` — never resolved through `PATH`, which a writable entry could substitute. */
const PS_BIN = '/bin/ps'

/** Every running process's command line, one per entry. */
const defaultReadCommands = (): string[] => {
  return execFileSync(PS_BIN, ['-eo', 'command='], { encoding: 'utf8', maxBuffer: 8 << 20 }).split('\n')
}

/**
 * Is an `infra-kit dev` runner alive anywhere on this machine?
 *
 * Machine-wide, not repo-wide: portless routes are machine-global, and a runner in another worktree can be
 * mid-boot against a route this repo can see.
 *
 * Fails CLOSED: if `ps` cannot be read we report `true` — "a runner might be up" — so an unreadable process
 * table withholds the prune instead of authorising it.
 */
export const isDevSessionRunning = (readCommands: () => string[] = defaultReadCommands): boolean => {
  try {
    return readCommands().some(looksLikeDevRunner)
  } catch {
    // No process table, no proof of safety.
    return true
  }
}
