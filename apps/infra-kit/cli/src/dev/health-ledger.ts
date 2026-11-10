import { describeForeign, isForeign } from './health-probe.js'
import type { ProbeOutcome, ProbeTarget } from './health-probe.js'
import type { HealthState } from './render.js'

type LogFn = (msg: string, level?: 'info' | 'warn' | 'error' | 'debug') => void

/**
 * One row's probe history — the state the 5-arm {@link HealthState} is derived from, keyed by TAG (never
 * by app name: `foo/api` and `foo/ui` are different rows on the same app, and a name-keyed counter
 * collides them).
 */
interface HealthEntry {
  kind: ProbeTarget['kind']
  /** Consecutive `refused` probes. `>= FAILURE_THRESHOLD` is what "down" MEANS. */
  failures: number
  /** Consecutive `foreign` probes — a separate counter, because a foreign answer must never go red. */
  foreignStreak: number
  /** Has this row EVER proved it was serving? Until it has, a UI is `starting`, not `down`. */
  everUp: boolean
  /** A CERTAINTY of death from outside the probe loop: a thrown restart, a dead UI engine. */
  dead: boolean
  /** The port answers, but not with what we asked for — liveness cannot be established either way. */
  unverified: boolean
}

/**
 * The probe history of every endpoint row, and the row state derived from it. It owns no timer and
 * makes no probe: the runner feeds it outcomes and certainties, and asks it what to draw.
 *
 * Probe history per row, keyed by TAG (`<app>/api`, `<app>/ui`) — never by app name, which would
 * collide an app's two halves into one counter the moment the frontends joined the tick. It survives an
 * ephemeral-port rebind on restart, because the tag does.
 */
export class HealthLedger {
  /** Consecutive failures before a row is declared down — the anti-flap / restart-window filter. */
  static readonly FAILURE_THRESHOLD = 2
  /**
   * Refused probes a UI that has NEVER been up may take before its `◌ starting` turns `● down` (~30s at
   * the 5s cadence). Far above the backend threshold on purpose: a cold vite on a big frontend genuinely
   * takes tens of seconds to bind, and a red dot over a UI that is merely still booting is the one false
   * red this whole design refuses to ship. A UI that has been up once is not covered by it — its death is
   * probe-established at the ordinary threshold.
   */
  static readonly NEVER_UP_DOWN_THRESHOLD = 6

  private readonly entries = new Map<string, HealthEntry>()
  private readonly log: LogFn

  constructor(log: LogFn) {
    this.log = log
  }

  /** Start tracking a row before its first probe, so it renders as never-up rather than `unknown`. */
  track(tag: string, kind: ProbeTarget['kind']): void {
    this.entry(tag, kind)
  }

  /** Record a certainty of death for a row that was never up (see `neverUpState`). */
  markDead(tag: string, kind: ProbeTarget['kind']): void {
    this.entry(tag, kind).dead = true
  }

  /** This tag's entry, created on first sight. */
  private entry(tag: string, kind: ProbeTarget['kind']): HealthEntry {
    const existing = this.entries.get(tag)

    if (existing) return existing

    const fresh: HealthEntry = { kind, failures: 0, foreignStreak: 0, everUp: false, dead: false, unverified: false }

    this.entries.set(tag, fresh)

    return fresh
  }

  /**
   * Fold one probe outcome into a row's history and fire the edge logs — each exactly once, so a steady
   * state (healthy OR wedged) says nothing.
   *
   * The `foreign` arms are where the two kinds part company. A backend answering non-2xx is OUR fastify
   * failing, so it counts as a failure like any other. A UI answering something that is not vite's ping is
   * unverifiable — a squatter, a proxy shadowing the ping, a future vite that dropped it — so it counts
   * toward nothing and only raises `unverified`, which renders `◍ ?` and never red.
   */
  record(target: ProbeTarget, outcome: ProbeOutcome): void {
    const entry = this.entry(target.tag, target.kind)
    const threshold = HealthLedger.FAILURE_THRESHOLD

    if (outcome === 'ok') {
      const wasDown = entry.failures >= threshold

      entry.everUp = true
      entry.failures = 0
      entry.foreignStreak = 0
      entry.unverified = false
      if (wasDown) this.log(`✅ ${target.tag} recovered`)

      return
    }

    if (isForeign(outcome) && target.kind === 'ui') {
      entry.foreignStreak += 1
      entry.unverified = entry.foreignStreak >= threshold
      if (entry.foreignStreak === threshold) {
        this.log(`⚠️  ${target.tag}: ${describeForeign(target.port, outcome)}`, 'warn')
      }

      return
    }

    entry.foreignStreak = 0
    entry.failures += 1
    // A port that answers SOMETHING is not provably dead — so a UI drops `unverified` only once its refusals
    // have earned a real `down`, and never on the way there.
    if (target.kind === 'ui' && entry.failures >= threshold) entry.unverified = false
    if (entry.failures === threshold) {
      const why = target.kind === 'api' ? '/__health not responding' : "not answering vite's ping"

      this.log(`⚠️  ${target.tag} unhealthy (${why})`, 'warn')
    }
  }

  /**
   * Declare a row down WITHOUT a probe — for the two facts the probe loop cannot establish: a restart whose
   * `startOneApp` threw (there is no server left to probe), and a UI whose engine died before it was ever
   * up. Routing those through the soft probe path would leave the row one failure short of the threshold,
   * i.e. GREEN, for something that demonstrably does not exist.
   */
  markDown(tag: string, kind: ProbeTarget['kind']): void {
    const entry = this.entry(tag, kind)

    entry.dead = true
    entry.failures = HealthLedger.FAILURE_THRESHOLD
    entry.foreignStreak = 0
    entry.unverified = false
  }

  /** The 5-arm row state for a tag. No entry at all → `unknown` (a `UiRef`, or `--no-ui-health`). */
  stateOf(tag: string): HealthState {
    const entry = this.entries.get(tag)

    if (entry == null) return 'unknown'
    if (entry.unverified) return 'unverified'
    if (!entry.everUp) return this.neverUpState(entry)

    return entry.failures >= HealthLedger.FAILURE_THRESHOLD ? 'down' : 'ok'
  }

  /**
   * A row that has never proved it was serving. A backend is `down` on sight — it is started in-process and
   * probed the moment it binds, so "up but never answered" is already a failure. A UI is `starting` until it
   * has burned the whole never-up budget: vite is spawned AFTER the ready frame and takes real seconds to
   * bind, and a red dot over a UI that is merely still booting is the one false red this design refuses.
   *
   * `dead` is read HERE and nowhere else, and the narrowness is the point: an `everUp` UI's death must stay
   * probe-established. Turbo puts each task in its OWN process group and reaps none of them on death
   * (`managed-child.ts`), and our own reap is best-effort — so "the engine exited ⇒ every vite is dead" is
   * simply false, and believing it would red-dot a live, hot-reloading UI.
   */
  private neverUpState(entry: HealthEntry): HealthState {
    if (entry.kind === 'api' || entry.dead) return 'down'

    return entry.failures >= HealthLedger.NEVER_UP_DOWN_THRESHOLD ? 'down' : 'starting'
  }
}
