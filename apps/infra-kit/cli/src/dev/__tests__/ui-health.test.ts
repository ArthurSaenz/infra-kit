/**
 * The health STATE MACHINE, driven through a real {@link DevServerRunner} with an injected
 * {@link HealthProbe} and a fast `livenessIntervalMs`.
 *
 * Every assertion here is about what the PANEL says, not about what the probe returned. That distinction
 * is the whole reason this file exists: the panel is the only signal left on the screen, so a bug that
 * lets a row report a state better than its evidence is a bug that ships a lie. The `refresh()` seam is
 * where the panel's rows are painted, so the frames it emits — not the runner's internals — are the
 * subject under test.
 *
 * The probe verdicts themselves (204 → ok, `200 text/html` → foreign, redirects, timeouts) are covered
 * against a real `node:http` server in `health-probe.test.ts`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import type { DevServerOptions, HealthProbe, ProbeOutcome, ProbeTarget } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'
import type { PortlessDriver } from 'src/dev/proxy/portless-driver'
import { DevRenderer } from 'src/dev/render'
import type { HealthState, LogLevel, ReadySummary } from 'src/dev/render'

import {
  createTempTracker,
  handlerSource,
  makeFakeProxy,
  makeMonorepo,
  restoreCwd,
  restoreEnv,
  snapshotCwd,
  snapshotEnv,
  workingProxy,
} from './fixtures'
import type { AppSpec } from './fixtures'

/**
 * A `foreign` outcome for the probe scripts below. Defaults to the case that motivated the whole probe: a
 * `200 text/html`, which is what vite's html fallback answers for a broken app — and what a naive `GET /`
 * would have reported as healthy.
 */
const foreign = (status = 200, contentType: string | null = 'text/html'): ProbeOutcome => {
  return { kind: 'foreign', status, contentType }
}

const temp = createTempTracker()
let envSnapshot: NodeJS.ProcessEnv
let cwdSnapshot: string

beforeEach(() => {
  envSnapshot = snapshotEnv()
  cwdSnapshot = snapshotCwd()
})

afterEach(() => {
  restoreCwd(cwdSnapshot)
  restoreEnv(envSnapshot)
  temp.cleanup()
})

/** A no-op turbo child (watch build / run dev): spawns nothing, resolves on kill. */
const noopTurboChild = (): { kill: () => Promise<void> } => {
  return {
    kill: (): Promise<void> => {
      return Promise.resolve()
    },
  }
}

/** One painted panel frame: what the rows said, and everything the runner had logged by that moment. */
interface Frame {
  /** Row health by tag, exactly as the panel would draw its dot. */
  health: Record<string, HealthState>
  /**
   * A COPY of the log lines emitted before this frame. Snapshotting per frame is what lets a warn be
   * pinned to the tick that earned it — `logs.length` at the end of a run cannot say when it fired.
   */
  logs: string[]
  summary: ReadySummary
}

const healthByTag = (summary: ReadySummary): Record<string, HealthState> => {
  return Object.fromEntries(
    summary.endpoints.map((endpoint) => {
      return [endpoint.tag, endpoint.health]
    }),
  )
}

/** A silent {@link DevUi} that records every `refresh()` frame, the boot summary, and every log line. */
const makeHealthRenderer = (): {
  renderer: DevUi
  frames: Frame[]
  logs: string[]
  ready: () => ReadySummary
} => {
  const frames: Frame[] = []
  const logs: string[] = []
  let captured: ReadySummary | null = null
  const noop = (): void => {}
  const renderer: DevUi = {
    narrate: noop,
    log: (message: string) => {
      logs.push(message)
    },
    logFn: noop,
    bootStep: noop,
    ready: (summary) => {
      captured = summary
    },
    refresh: (summary) => {
      frames.push({ summary, logs: [...logs], health: healthByTag(summary) })
    },
    dispose: noop,
  }

  return {
    renderer,
    frames,
    logs,
    ready: (): ReadySummary => {
      if (captured == null) throw new Error('ready() was never called')

      return captured
    },
  }
}

/** A per-tag scripted probe: a queue of outcomes, then a held one. Records every target it was asked. */
interface ProbeScript {
  probe: HealthProbe
  /** Every target the runner probed — the `--no-ui-health` proof is that no `kind: 'ui'` target is here. */
  calls: ProbeTarget[]
  /** Queue outcomes for a tag, one per probe; the LAST one keeps repeating once the queue drains. */
  script: (tag: string, outcomes: ProbeOutcome[]) => void
  /** Drop any queue for a tag and hold it at one outcome from here on. */
  hold: (tag: string, outcome: ProbeOutcome) => void
}

const makeProbe = (fallback: ProbeOutcome = 'ok'): ProbeScript => {
  const queues = new Map<string, ProbeOutcome[]>()
  const held = new Map<string, ProbeOutcome>()
  const calls: ProbeTarget[] = []
  const probe: HealthProbe = (target) => {
    calls.push(target)
    const next = queues.get(target.tag)?.shift()

    if (next != null) {
      // The tail of a script is its steady state — a drained queue must not silently flip a row healthy.
      held.set(target.tag, next)

      return Promise.resolve(next)
    }

    return Promise.resolve(held.get(target.tag) ?? fallback)
  }

  return {
    probe,
    calls,
    script: (tag, outcomes) => {
      queues.set(tag, [...outcomes])
    },
    hold: (tag, outcome) => {
      queues.delete(tag)
      held.set(tag, outcome)
    },
  }
}

/** Wait until at least `count` panel frames have been painted (each tick paints exactly one). */
const waitForFrames = async (frames: Frame[], count: number, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (frames.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${frames.length} of ${count} panel frames arrived within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => {
      return setTimeout(resolve, 5)
    })
  }
}

/** Wait until some frame reports `state` for `tag`, and return that frame's index. */
const waitForHealth = async (frames: Frame[], tag: string, state: HealthState, timeoutMs = 8000): Promise<number> => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const idx = frames.findIndex((frame) => {
      return frame.health[tag] === state
    })

    if (idx >= 0) return idx
    if (Date.now() > deadline) {
      throw new Error(`${tag} never reached \`${state}\` (last: ${String(frames.at(-1)?.health[tag])})`)
    }
    await new Promise((resolve) => {
      return setTimeout(resolve, 5)
    })
  }
}

/**
 * The private surface these tests drive directly. Reaching in is deliberate and follows the existing
 * teardown tests: a restart's only public trigger is a chokidar `dist/` event, whose timing is far too
 * loose to aim at a specific frame, and the log sink is the only way to make a row's error counter move
 * without a real vite. App configs stay opaque (`unknown`) — they are only round-tripped back into
 * `restart`.
 */
interface RunnerPrivates {
  appServers: Array<{ app: unknown }>
  failedApps: Array<{ app: unknown; reason: string }>
  restart: (apps: unknown[]) => Promise<void>
  sink: { write: (service: string, text: string, meta?: { level?: LogLevel }) => void }
}

interface Harness {
  runner: DevServerRunner
  frames: Frame[]
  logs: string[]
  ready: () => ReadySummary
  /** Fire the turbo `run dev` child's `onUnexpectedExit` — the engine dying on its own. */
  killEngine: () => void
  privates: RunnerPrivates
  root: string
}

/**
 * Boot a hermetic monorepo through the REAL runner with an injected probe, a fake build, a fake ui-dev
 * child and a fake portless driver. A UI-only spec (`api: false`) skips the fastify boot entirely, which
 * is what keeps the tick-driven sequence tests fast and free of a real server's timing.
 */
const boot = async (
  apps: AppSpec[],
  probe: HealthProbe,
  options: DevServerOptions = {},
  proxy: PortlessDriver = workingProxy(),
): Promise<Harness> => {
  const root = temp.register(makeMonorepo(apps))
  const fakeRunBuild = async (): Promise<void> => {
    for (const app of apps) {
      if (!app.withHandler) continue
      fs.writeFileSync(path.join(root, 'apps', app.name, 'api', 'dist', 'handler.js'), handlerSource(1))
    }
  }

  let fireExit: (() => void) | null = null
  const fakeUiDev = (opts: { onUnexpectedExit?: (detail: string) => void }): { kill: () => Promise<void> } => {
    fireExit = (): void => {
      opts.onUnexpectedExit?.('exited with code 1')
    }

    return { kill: noopTurboChild().kill }
  }

  process.chdir(root)
  const { renderer, frames, logs, ready } = makeHealthRenderer()
  const runner = new DevServerRunner(
    options,
    fakeRunBuild,
    noopTurboChild,
    fakeUiDev,
    undefined,
    renderer,
    probe,
    proxy,
  )

  await runner.start()

  return {
    runner,
    frames,
    logs,
    ready,
    root,
    privates: runner as unknown as RunnerPrivates,
    killEngine: (): void => {
      if (fireExit == null) throw new Error('the ui-dev child was never spawned')
      fireExit()
    },
  }
}

/** A UI-only app: a managed vite port, no backend at all — the fastest way to drive the UI arms. */
const uiOnlyApp: AppSpec = { name: 'shop', api: false, ui: { packageName: 'shop-ui' } }
/** An app with both halves — the shape that makes a tag collision possible. */
const fullApp: AppSpec = { name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui' } }

const warnsMatching = (logs: string[], needle: string): string[] => {
  return logs.filter((line) => {
    return line.includes(needle)
  })
}

/**
 * THE regression this whole state machine exists to prevent.
 *
 * An earlier design cleared `unverified` unconditionally on a `refused` probe. So a UI answering something
 * that was not vite's ping (dim `◍ ?`) and then going silent flipped to a confident GREEN `● ok` on step 4
 * — the display IMPROVING on a strictly worse probe outcome, and staying green until the second refusal.
 * An endpoint-only assertion ("it ends up down") passed the whole time while the panel lied for a tick.
 *
 * So the state is asserted at EVERY step, not just the last one.
 */
describe('ui health — the full ok → foreign → foreign → refused → refused sequence', () => {
  it('paints exactly ok, ok, unverified, unverified, down — and never green on a refused connection', async () => {
    const probe = makeProbe()

    probe.script('shop/ui', ['ok', foreign(), foreign(), 'refused', 'refused'])

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForFrames(h.frames, 6)

      // Frame 0 is the boot frame (printReady); frames 1..5 are the five ticks above, one probe each.
      expect(h.frames[0]?.health['shop/ui']).toBe('starting')
      expect(
        h.frames.slice(1, 6).map((frame) => {
          return frame.health['shop/ui']
        }),
      ).toEqual(['ok', 'ok', 'unverified', 'unverified', 'down'])

      // Stated again as the invariant, because the sequence above is easy to "fix" by weakening: the first
      // refusal (step 4) may not improve the row. `unverified` is a refusal to claim; `ok` is a claim.
      expect(h.frames[4]?.health['shop/ui']).not.toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — a foreign answer is never red, and never silent twice', () => {
  it('holds ok on ONE foreign probe with no warn, turns ◍ ? on the second with exactly one warn, and re-arms after a recovery', async () => {
    // `foreign` on a UI is unverifiable, not broken: a squatter, a proxy shadowing the ping and a future
    // vite that dropped it are all consistent with it. So it costs no failure and can never paint red —
    // but two in a row DO earn a warn naming the symptom, and a later `ok` must re-arm that warn rather
    // than latching it off for the session.
    const probe = makeProbe()

    probe.script('shop/ui', ['ok', foreign(), foreign(), 'ok', foreign(), foreign()])

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForFrames(h.frames, 7)

      const states = h.frames.slice(1, 7).map((frame) => {
        return frame.health['shop/ui']
      })
      const warnsAt = h.frames.slice(1, 7).map((frame) => {
        return warnsMatching(frame.logs, 'liveness cannot be verified').length
      })

      expect(states).toEqual(['ok', 'ok', 'unverified', 'ok', 'ok', 'unverified'])
      // One foreign probe: no warn at all. Two: exactly one. A recovery re-arms it; the next pair warns again.
      expect(warnsAt).toEqual([0, 0, 1, 1, 1, 2])
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)

  it('names WHAT answered, because a `◍ ?` row has no dot and the warn is the entire signal', async () => {
    // The dot deliberately stays dim here, so this line is all the user gets — and "not vite's ping" alone
    // cannot separate the three causes it exists to tell apart. `200 text/html` is vite having dropped the
    // ping (ours to fix and ship); a 502 is portless or a proxy shadowing the port; a 404 is a squatter that
    // won the free-port race. Same dot, three different next moves.
    //
    // It also carries the weight of a deliberate gap: this change ships with NO in-repo test of the real
    // vite (that would mean a heavyweight dep in a published package), so this warn IS the compensating
    // control. If vite ever drops the ping, every UI row goes `◍ ?` at once and this line says `200 text/html`.
    const probe = makeProbe()

    probe.script('shop/ui', ['ok', foreign(502, 'text/plain'), foreign(502, 'text/plain')])

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      const idx = await waitForHealth(h.frames, 'shop/ui', 'unverified')
      const warns = warnsMatching(h.frames[idx]!.logs, 'liveness cannot be verified')

      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('502 text/plain')
      expect(warns[0]).toContain('shop/ui')
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — anti-flap (one refusal is a restart, two is a death)', () => {
  it('keeps an ok row ok through a single refused tick and takes it down on the second — for a backend AND a frontend', async () => {
    // A watch restart takes a backend down for well under one interval. Flipping the dot on the first
    // refusal would red-dot a healthy app on every save; the threshold is what makes a normal restart
    // invisible while a genuinely wedged app still goes red within two ticks.
    const probe = makeProbe()

    // The api's index 0 is consumed by printReady's boot probe, so its script carries a leading `ok`.
    probe.script('shop/api', ['ok', 'ok', 'refused', 'refused'])
    probe.script('shop/ui', ['ok', 'refused', 'refused'])

    const h = await boot([fullApp], probe.probe, { livenessIntervalMs: 25 })

    try {
      await waitForFrames(h.frames, 4)

      // One refusal each: both rows hold.
      expect(h.frames[2]?.health['shop/api']).toBe('ok')
      expect(h.frames[2]?.health['shop/ui']).toBe('ok')

      // Two: both are down, and each logged exactly one unhealthy warn.
      expect(h.frames[3]?.health['shop/api']).toBe('down')
      expect(h.frames[3]?.health['shop/ui']).toBe('down')
      expect(warnsMatching(h.frames[3]!.logs, 'shop/api unhealthy')).toHaveLength(1)
      expect(warnsMatching(h.frames[3]!.logs, 'shop/ui unhealthy')).toHaveLength(1)
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('names the FRONTEND in the frontend’s unhealthy log — the suffix used to be hardcoded `/api`', async () => {
    // Bug 2: the unhealthy/recovered lines appended a literal `/api` to the app name, so a dead frontend
    // announced itself as a dead backend. A UI-only fixture is used deliberately: there is no `/api`
    // anywhere in this run, so the assertion cannot pass by accident.
    const probe = makeProbe()

    probe.script('shop/ui', ['ok', 'refused', 'refused'])

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForHealth(h.frames, 'shop/ui', 'down')

      const [warn, ...rest] = warnsMatching(h.logs, 'unhealthy')

      expect(rest).toEqual([])
      expect(warn).toContain('shop/ui')
      expect(warn).not.toContain('/api')
      // And it names the symptom, so a uniform `◍ ?` across every row is diagnosable from the log alone.
      expect(warn).toContain("not answering vite's ping")
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — the boot frame tells the truth about the backends', () => {
  it('keeps a backend probed DOWN at boot down through printReady’s own refreshStatus', async () => {
    // Bug 1: `printReady` probed, painted the dot from that local result, and left the failure counter
    // empty — so the `refreshStatus()` at the bottom of the SAME method, reading the empty map, repainted
    // the backend a confident green one line later and held it green until the first tick. The boot frame
    // and the panel under it disagreed about a single probe.
    const probe = makeProbe()

    probe.hold('shop/api', 'refused')

    // Default liveness interval (5s): nothing ticks during this test, so both readings are the boot probe's.
    const h = await boot([{ name: 'shop', packageName: 'shop-api', withHandler: true }], probe.probe)

    try {
      const row = h.ready().endpoints.find((endpoint) => {
        return endpoint.tag === 'shop/api'
      })

      expect(row?.health).toBe('down')
      expect(h.frames[0]?.health['shop/api']).toBe('down')
      expect(h.frames[0]?.health['shop/api']).not.toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('reads a HEALTHY backend as ok in that same frame — no ● down flash on a good boot', async () => {
    // The other half of the same bug, and the reason `printReady`'s probe routes through `recordProbe`
    // rather than seeding a blank map: a blank seed would flash `● down` on every healthy backend.
    const probe = makeProbe()

    probe.hold('shop/api', 'ok')

    const h = await boot([{ name: 'shop', packageName: 'shop-api', withHandler: true }], probe.probe)

    try {
      expect(
        h.ready().endpoints.find((endpoint) => {
          return endpoint.tag === 'shop/api'
        })?.health,
      ).toBe('ok')
      expect(h.frames[0]?.health['shop/api']).toBe('ok')
      // Not one frame in the whole boot said `down`.
      expect(
        h.frames.some((frame) => {
          return frame.health['shop/api'] === 'down'
        }),
      ).toBe(false)
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('opens every managed UI row on ◌ starting, before a single UI probe has been issued', async () => {
    // Vite is spawned AFTER the ready frame, so a `● down` here would be a claim about a server that has
    // not been asked a single question yet — the one false red this design refuses to ship.
    const probe = makeProbe()
    const h = await boot(
      [
        { name: 'shop', api: false, ui: { packageName: 'shop-ui' } },
        { name: 'admin', api: false, ui: { packageName: 'admin-ui' } },
      ],
      probe.probe,
    )

    try {
      const ui = h.ready().endpoints.filter((endpoint) => {
        return endpoint.tag.endsWith('/ui')
      })

      // Discovery is directory order, so sort — the claim is "every managed UI", not "in this order".
      expect(
        ui
          .map((row) => {
            return row.tag
          })
          .sort(),
      ).toEqual(['admin/ui', 'shop/ui'])
      expect(
        ui.every((row) => {
          return row.health === 'starting'
        }),
      ).toBe(true)
      // Seeded, not probed: `starting` is an honest prior, and the proof is that nothing was asked yet.
      expect(probe.calls).toEqual([])
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — a UI that never comes up still reaches red', () => {
  it('holds ◌ starting for five refused ticks and goes ● down on the sixth', async () => {
    // A cold vite on a big frontend genuinely takes tens of seconds to bind, which is why the never-up
    // budget is far above the backend threshold. But it IS a budget: a UI pinned to a port the runner
    // never assigned never binds ours, its alias 502s forever, and the red is honest.
    const probe = makeProbe()

    probe.hold('shop/ui', 'refused')

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForFrames(h.frames, 7)

      expect(
        h.frames.slice(1, 6).map((frame) => {
          return frame.health['shop/ui']
        }),
      ).toEqual(['starting', 'starting', 'starting', 'starting', 'starting'])
      expect(h.frames[6]?.health['shop/ui']).toBe('down')
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — the UI engine dying is evidence about a never-up UI, and about nothing else', () => {
  it('takes a UI that never came up straight to ● down when `turbo run dev` exits', async () => {
    // Its vite either never bound or went down with the engine, and no further probe is going to tell us
    // anything the engine's corpse has not already said.
    const probe = makeProbe()

    probe.hold('shop/ui', 'refused')

    // Default interval: not one probe fires in this test, so `down` can only have come from the engine.
    const h = await boot([uiOnlyApp], probe.probe)

    try {
      expect(h.frames[0]?.health['shop/ui']).toBe('starting')

      h.killEngine()

      expect(h.frames.at(-1)?.health['shop/ui']).toBe('down')
      expect(probe.calls).toEqual([])
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)

  it('leaves an orphaned-but-still-serving vite GREEN — turbo does not kill its task process groups', async () => {
    // This is load-bearing, not a nicety. Turbo puts each task in its own process group and reaps none of
    // them on death; our own reap is best-effort. So "the engine exited ⇒ every vite is dead" is simply
    // FALSE, and believing it would paint a live, hot-reloading UI red. The probe still says 204; the row
    // still says ok. (The engine's death is reported on its own line — it is not a health claim.)
    const probe = makeProbe()

    probe.hold('shop/ui', 'ok')

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForHealth(h.frames, 'shop/ui', 'ok')

      h.killEngine()

      const afterKill = h.frames.length

      expect(h.frames[afterKill - 1]?.health['shop/ui']).toBe('ok')

      // And it STAYS ok across further ticks — the `dead` flag is read only in the never-up branch.
      await waitForFrames(h.frames, afterKill + 4)
      expect(
        h.frames.slice(afterKill).every((frame) => {
          return frame.health['shop/ui'] === 'ok'
        }),
      ).toBe(true)
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)

  it('takes an everUp UI down only once TWO probes refuse it, engine or no engine', async () => {
    const probe = makeProbe()

    probe.hold('shop/ui', 'ok')

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForHealth(h.frames, 'shop/ui', 'ok')
      h.killEngine()

      // Now the vite really does stop answering.
      const switched = h.frames.length

      probe.hold('shop/ui', 'refused')

      const downAt = await waitForHealth(h.frames, 'shop/ui', 'down')

      // The death is probe-established, at the ordinary threshold: the frame before the red one still said
      // ok (one refusal is not proof), and it landed after the switch — never on the engine's word alone.
      expect(downAt).toBeGreaterThan(switched)
      expect(h.frames[downAt - 1]?.health['shop/ui']).toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — the map is keyed by TAG, so an app’s two halves cannot collide', () => {
  it('takes foo/api down without touching foo/ui', async () => {
    // Bug 3: the failure counter was keyed by APP NAME. The moment the frontends joined the tick, a
    // backend's failures and its frontend's failures folded into one counter — one dead half took the
    // healthy one red with it.
    const probe = makeProbe()

    probe.script('shop/api', ['ok', 'ok', 'refused', 'refused'])
    probe.hold('shop/ui', 'ok')

    const h = await boot([fullApp], probe.probe, { livenessIntervalMs: 25 })

    try {
      const downAt = await waitForHealth(h.frames, 'shop/api', 'down')

      expect(h.frames[downAt]?.health['shop/ui']).toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('takes foo/ui down without touching foo/api', async () => {
    const probe = makeProbe()

    probe.hold('shop/api', 'ok')
    probe.script('shop/ui', ['ok', 'refused', 'refused'])

    const h = await boot([fullApp], probe.probe, { livenessIntervalMs: 25 })

    try {
      const downAt = await waitForHealth(h.frames, 'shop/ui', 'down')

      expect(h.frames[downAt]?.health['shop/api']).toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)
})

describe('ui health — restarts', () => {
  it('paints a restart whose startOneApp THREW as ● down in the very next frame', async () => {
    // A thrown restart is a CERTAINTY, not probe noise: there is no server left to probe. Routed through
    // the soft probe path it would land one failure short of the threshold — i.e. GREEN — for a server
    // that demonstrably does not exist.
    const probe = makeProbe()

    probe.hold('shop/api', 'ok')

    // The alias registration is what fails: portless accepts the boot registration and refuses the restart's.
    let refuse = false
    const base = makeFakeProxy(true).driver
    const flaky: PortlessDriver = {
      ...base,
      registerAlias: (name, port) => {
        return refuse ? Promise.resolve(false) : base.registerAlias(name, port)
      },
    }

    const h = await boot([{ name: 'shop', packageName: 'shop-api', withHandler: true }], probe.probe, {}, flaky)

    try {
      expect(h.frames[0]?.health['shop/api']).toBe('ok')

      refuse = true
      await h.privates.restart([h.privates.appServers[0]!.app])

      expect(h.frames.at(-1)?.health['shop/api']).toBe('down')
      expect(h.frames.at(-1)?.health['shop/api']).not.toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('paints a recovered boot-failed backend ok in the frame immediately after its restart', async () => {
    // A recovered app has no `appServers` slot to overwrite: it is appended, and its health entry has to be
    // seeded BEFORE it becomes visible, or the row it never had at boot would render `unknown` (no dot at
    // all) for a server that is already serving. Nor may it read `down` — it was just probed healthy.
    const probe = makeProbe()

    probe.hold('shop/api', 'ok')
    probe.hold('broken/api', 'ok')

    const root = temp.register(
      makeMonorepo([
        { name: 'shop', packageName: 'shop-api', withHandler: true },
        { name: 'broken', packageName: 'broken-api', withHandler: true },
      ]),
    )
    const brokenHandler = path.join(root, 'apps', 'broken', 'api', 'dist', 'handler.js')
    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'shop', 'api', 'dist', 'handler.js'), handlerSource(1))
      fs.writeFileSync(brokenHandler, 'throw new Error("config is missing field: \'connectionURL\'")\n')
    }

    process.chdir(root)
    const { renderer, frames, ready } = makeHealthRenderer()
    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      noopTurboChild,
      noopTurboChild,
      undefined,
      renderer,
      probe.probe,
      workingProxy(),
    )

    await runner.start()

    const priv = runner as unknown as RunnerPrivates

    try {
      // It really did fail to boot: a `● failed` row, no endpoint row at all.
      expect(ready().failed).toContainEqual({ tag: 'broken/api', reason: expect.any(String) })
      expect(frames[0]?.health['broken/api']).toBeUndefined()

      // The user fixes the bug and saves; watch rebuilds `dist/` and the runner restarts the app.
      fs.writeFileSync(brokenHandler, handlerSource(1))
      await priv.restart([priv.failedApps[0]!.app])

      const row = frames.at(-1)?.health['broken/api']

      expect(row).toBe('ok')
      expect(row).not.toBe('unknown')
      expect(row).not.toBe('down')
    } finally {
      await runner.shutdown()
    }
  }, 20000)
})

describe('ui health — the escape hatch (--no-ui-health / INFRA_KIT_NO_UI_HEALTH=1)', () => {
  /**
   * What the panel and the probe seam actually did after four ticks — enough that a UI probe would
   * certainly have fired had the feature been on. Returned rather than asserted here: the assertions
   * belong in the test that owns them.
   */
  const observe = async (
    h: Harness,
    probe: ProbeScript,
  ): Promise<{ uiHealth: HealthState | undefined; apiHealth: HealthState | undefined; kinds: string[] }> => {
    await waitForFrames(h.frames, 4)

    const frame = h.frames.at(-1)!

    return {
      uiHealth: frame.health['shop/ui'],
      apiHealth: frame.health['shop/api'],
      kinds: probe.calls.map((target) => {
        return target.kind
      }),
    }
  }

  it('gives every UI row `unknown` and issues zero UI probes under --no-ui-health', async () => {
    const probe = makeProbe()
    const h = await boot([fullApp], probe.probe, { livenessIntervalMs: 20, uiHealth: false })

    try {
      const seen = await observe(h, probe)

      expect(seen.uiHealth).toBe('unknown')
      expect(seen.kinds).not.toContain('ui')
      // The tick itself is alive — the backend is still probed, so `unknown` is the switch, not a hang.
      expect(seen.kinds).toContain('api')
      expect(seen.apiHealth).toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)

  it('honours INFRA_KIT_NO_UI_HEALTH=1 identically (the env is the same switch)', async () => {
    process.env.INFRA_KIT_NO_UI_HEALTH = '1'

    const probe = makeProbe()
    const h = await boot([fullApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      const seen = await observe(h, probe)

      expect(seen.uiHealth).toBe('unknown')
      expect(seen.kinds).not.toContain('ui')
      expect(seen.kinds).toContain('api')
      expect(seen.apiHealth).toBe('ok')
    } finally {
      await h.runner.shutdown()
    }
  }, 20000)
})

describe('ui health — a UI with no managed port', () => {
  it('gets no probe target and no dot, but keeps its error counter', async () => {
    // A UI whose vite config never wires `infraKitDev()` ignores the assigned port and binds its own, so
    // the runner owns no port to probe. `unknown` (no dot) is the honest answer — but the row still has to
    // be able to REPORT, and this is precisely the app most likely to be misconfigured.
    const probe = makeProbe()
    const h = await boot(
      [{ name: 'shop', api: false, ui: { packageName: 'shop-ui', viteConfig: false } }],
      probe.probe,
      { livenessIntervalMs: 20 },
    )

    try {
      await waitForFrames(h.frames, 3)

      const frame = h.frames.at(-1)!

      // A reference row, never a fabricated endpoint — and nothing was ever probed.
      expect(frame.summary.uiRefs).toEqual([{ tag: 'shop/ui', errors: 0 }])
      expect(frame.health['shop/ui']).toBeUndefined()
      expect(probe.calls).toEqual([])

      // What the panel actually draws for it: the error counter, and no health dot of any kind.
      const painted = new DevRenderer({ isTTY: false }).formatFooterLines(frame.summary).join('\n')

      expect(painted).toMatch(/shop\/ui\s+⚠ 0/)
      expect(painted).not.toContain('●')
      expect(painted).not.toContain('◌')
      expect(painted).not.toContain('◍')
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})

describe('ui health — the first-error edge log', () => {
  it('announces a row’s first error exactly once, however many ticks repaint it', async () => {
    // The honest cost of a liveness dot: a frontend that fails to compile still serves and still answers
    // vite's ping, so its dot stays a truthful green while the app is unusable. `⚠ N` is then the only
    // thing on screen that disagrees — and a number quietly ticking up in a panel corner is not a thing
    // anyone notices. The edge log is; it must fire once per tag, not once per tick.
    const probe = makeProbe()

    probe.hold('shop/ui', 'ok')

    const h = await boot([uiOnlyApp], probe.probe, { livenessIntervalMs: 20 })

    try {
      await waitForFrames(h.frames, 2)

      // Two errors on the UI's stream — exactly what a vite transform failure writes.
      h.privates.sink.write('shop/ui', 'ERROR pre-transform error', { level: 'error' })
      h.privates.sink.write('shop/ui', 'ERROR failed to load', { level: 'error' })

      const before = h.frames.length

      await waitForFrames(h.frames, before + 4)

      const frame = h.frames.at(-1)!

      expect(
        frame.summary.endpoints.find((endpoint) => {
          return endpoint.tag === 'shop/ui'
        })?.errors,
      ).toBe(2)
      // Four more repaints, still one announcement.
      expect(warnsMatching(h.logs, 'shop/ui reported its first error')).toHaveLength(1)
    } finally {
      await h.runner.shutdown()
    }
  }, 15000)
})
