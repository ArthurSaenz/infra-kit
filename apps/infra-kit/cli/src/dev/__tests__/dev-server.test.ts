import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'

import {
  canBind,
  createTempTracker,
  getFreePort,
  handlerSource,
  makeMonorepo,
  restoreCwd,
  restoreEnv,
  snapshotCwd,
  snapshotEnv,
  spyStdoutWrite,
} from './fixtures'

/**
 * Deterministic orchestration tier: a real monorepo fixture + the REAL ServerlessLocalRun
 * spawn, but the turbo build is replaced with an injected fake (2nd constructor arg) that
 * records its calls and refreshes each app's dist output. No chokidar, no watch, no timers
 * — start() then shutdown() is the whole lifecycle under test.
 */
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

describe('devServerRunner — start/shutdown lifecycle (fake build, real spawn)', () => {
  it('boots each discovered app on its resolved port and serves /__health, then frees every port on shutdown', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'alpha', packageName: 'alpha-api', withHandler: true },
        { name: 'beta', packageName: 'beta-api', withHandler: true },
      ]),
    )

    // Distinct free ports via env keep the conflict pre-check happy and avoid collisions.
    const alphaPort = await getFreePort()
    const betaPort = await getFreePort()

    process.env.ALPHA_PORT = String(alphaPort)
    process.env.BETA_PORT = String(betaPort)

    // Fake build: record the command and (re)write fresh dist output for each app.
    const buildCalls: string[] = []
    const apiDirs = ['alpha', 'beta'].map((name) => {
      return path.join(root, 'apps', name, 'api')
    })
    const fakeRunBuild = async (cmd: string): Promise<void> => {
      buildCalls.push(cmd)
      for (const dir of apiDirs) {
        fs.writeFileSync(path.join(dir, 'dist', 'handler.js'), handlerSource(1))
      }
    }

    // The runner resolves the monorepo root from cwd, so run from the fixture root.
    process.chdir(root)
    const runner = new DevServerRunner({}, fakeRunBuild)

    await runner.start()

    // The build seam was invoked (the initial turbo build).
    expect(buildCalls.length).toBeGreaterThan(0)

    // Both real servers are listening and answer their health route with their own port.
    const alphaHealth = (await (await fetch(`http://127.0.0.1:${alphaPort}/__health`)).json()) as {
      app: string
      port: number
    }
    const betaHealth = (await (await fetch(`http://127.0.0.1:${betaPort}/__health`)).json()) as {
      app: string
      port: number
    }

    expect(alphaHealth).toMatchObject({ app: 'alpha', port: alphaPort })
    expect(betaHealth).toMatchObject({ app: 'beta', port: betaPort })

    // Ports are held while running.
    expect(await canBind(alphaPort)).toBe(false)
    expect(await canBind(betaPort)).toBe(false)

    await runner.shutdown()

    // shutdown() releases every port so a fresh listener can bind again.
    expect(await canBind(alphaPort)).toBe(true)
    expect(await canBind(betaPort)).toBe(true)
  })
})

describe('start — port-conflict pre-check', () => {
  it('throws a clear error naming the port when two apps are EXPLICITLY pinned to the same port', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // Both apps explicitly pinned to the SAME port via {APP}_PORT => a real conflict.
    // The duplicate-port guard runs before any turbo build, so start() rejects
    // hermetically without ever shelling out.
    delete process.env.PORT
    process.env.CLIENT_PORT = '3010'
    process.env.BACKOFFICE_PORT = '3010'
    process.chdir(root)
    const runner = new DevServerRunner({})

    await expect(runner.start()).rejects.toThrow(/Port conflict detected: 3010/)
  })

  it('t2: does NOT throw for ≥2 apps with no explicit port (relaxed gate: unconfigured apps bind ephemeral)', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // No per-app {APP}_PORT / dev.<app>.port and no PORT => both are unconfigured.
    // They'd both resolve to DEFAULT_PORT statically, but the relaxed gate excludes
    // unconfigured apps (each binds its own `listen(0)` port), so it must NOT throw.
    // The build step then fails (no turbo in the fixture) — proving we got past the gate.
    delete process.env.PORT
    delete process.env.CLIENT_PORT
    delete process.env.BACKOFFICE_PORT
    process.chdir(root)
    const runner = new DevServerRunner({})

    await expect(runner.start()).rejects.not.toThrow(/Port conflict/)
  })

  it('does not throw the conflict error when apps are explicitly pinned to distinct ports', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // Distinct per-app ports via env keep the pre-check happy; the build step then
    // fails (no turbo in the fixture) — proving we got past the port guard.
    process.env.CLIENT_PORT = '3010'
    process.env.BACKOFFICE_PORT = '3011'
    process.chdir(root)
    const runner = new DevServerRunner({})

    await expect(runner.start()).rejects.not.toThrow(/Port conflict/)
  })
})

describe('start — --app selection + env-resolved port', () => {
  it('runs only the --app subset (skipping the rest) and resolves its port from {APP}_PORT', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'client', packageName: 'client-api', withHandler: true },
        { name: 'backoffice', packageName: 'backoffice-api', withHandler: true },
      ]),
    )
    const apiDirs = ['client', 'backoffice'].map((name) => {
      return path.join(root, 'apps', name, 'api')
    })
    const fakeRunBuild = async (): Promise<void> => {
      for (const dir of apiDirs) {
        fs.writeFileSync(path.join(dir, 'dist', 'handler.js'), handlerSource(1))
      }
    }

    // `--app client` selects one app; its port comes purely from the CLIENT_PORT env var.
    const clientPort = await getFreePort()
    const backofficePort = await getFreePort()

    delete process.env.PORT
    process.env.CLIENT_PORT = String(clientPort)
    process.env.BACKOFFICE_PORT = String(backofficePort)
    process.chdir(root)
    const runner = new DevServerRunner({ include: ['client'] }, fakeRunBuild)

    await runner.start()

    try {
      // Only `client` booted, on its {APP}_PORT-resolved port.
      const health = (await (await fetch(`http://127.0.0.1:${clientPort}/__health`)).json()) as {
        app: string
        port: number
      }

      expect(health).toMatchObject({ app: 'client', port: clientPort })

      // `backoffice` was filtered out by --app, so its port never gets bound.
      expect(await canBind(backofficePort)).toBe(true)
    } finally {
      await runner.shutdown()
    }
  })
})

/** Boot a single-app monorepo fixture, capturing stdout across start(); returns the output + runner. */
const bootAndCaptureStdout = async (
  temp: ReturnType<typeof createTempTracker>,
  appName: string,
): Promise<{ out: string; runner: DevServerRunner }> => {
  const root = temp.register(makeMonorepo([{ name: appName, packageName: `${appName}-api`, withHandler: true }]))
  const port = await getFreePort()

  process.env[`${appName.replace(/-/g, '_').toUpperCase()}_PORT`] = String(port)

  const apiDir = path.join(root, 'apps', appName, 'api')
  const fakeRunBuild = async (): Promise<void> => {
    fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
  }

  const writes: string[] = []
  const spy = spyStdoutWrite(writes)

  process.chdir(root)
  const runner = new DevServerRunner({}, fakeRunBuild)

  try {
    await runner.start()
  } finally {
    spy.mockRestore()
  }

  return { out: writes.join(''), runner }
}

describe('devServerRunner — startup server table', () => {
  it('renders truthful, aligned rows: prefix in the base URL, a /__health URL, equal-width lines', async () => {
    // A long app name is exactly what broke the old fixed-width padEnd(24) table.
    const longName = 'super-long-application-name'
    const { out, runner } = await bootAndCaptureStdout(temp, longName)

    try {
      // Truthful: the base URL carries the /api/v1 prefix and the health URL is shown.
      expect(out).toContain('/api/v1')
      expect(out).toContain('/__health')
      expect(out).toContain(longName)

      // Aligned: every box-drawn line shares one width (measured in UTF-16 units, as the
      // renderer computes them — the title emoji is a surrogate pair, so code-point counts differ).
      const tableLines = out.split('\n').filter((line) => {
        return /^[┌│├└]/.test(line)
      })

      expect(tableLines.length).toBeGreaterThan(0)
      expect(
        new Set(
          tableLines.map((line) => {
            return line.length
          }),
        ).size,
      ).toBe(1)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — startup route dump', () => {
  it('lists each app registered METHOD /path routes at startup', async () => {
    const { out, runner } = await bootAndCaptureStdout(temp, 'epsilon')

    try {
      expect(out).toContain('Registered routes')
      expect(out).toContain('epsilon')
      // The monorepo fixture declares a single GET /api/v1/ping route.
      expect(out).toContain('GET /api/v1/ping')
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — watch mode (dist-watch, build-less restart)', () => {
  it('restarts on a dist change without rebuilding, spawns the turbo engine, and reaps it on shutdown', async () => {
    const root = temp.register(makeMonorepo([{ name: 'omega', packageName: 'omega-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const apiDir = path.join(realRoot, 'apps', 'omega', 'api')
    const distHandler = path.join(apiDir, 'dist', 'handler.js')

    const omegaPort = await getFreePort()

    process.env.OMEGA_PORT = String(omegaPort)
    // Hermetic polling so the dist watcher fires without relying on native fs events.
    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    // Fake build: boot build only. In turbo mode the on-change rebuild is owned by the
    // (faked) turbo engine, so runBuild must NOT be called again after boot.
    const buildCalls: string[] = []
    const fakeRunBuild = async (cmd: string): Promise<void> => {
      buildCalls.push(cmd)
      fs.writeFileSync(distHandler, handlerSource(1))
    }

    // No-op turbo engine: record that it was asked to start (+ with which packages) and
    // that it was killed on shutdown, without spawning a real child.
    let killed = false
    let spawnedPackages: string[] | null = null
    const fakeTurboWatch = (opts: { packageNames: string[] }): { kill: () => Promise<void> } => {
      spawnedPackages = opts.packageNames

      return {
        kill: (): Promise<void> => {
          killed = true

          return Promise.resolve()
        },
      }
    }

    process.chdir(root)
    const runner = new DevServerRunner({ watch: true }, fakeRunBuild, fakeTurboWatch)

    await runner.start()

    try {
      const v1 = (await (await fetch(`http://127.0.0.1:${omegaPort}/api/v1/ping`)).json()) as { version: number }

      expect(v1.version).toBe(1)

      // The turbo engine was started, scoped to the app package.
      expect(spawnedPackages).toEqual(['omega-api'])

      // Exactly one build so far: the boot build. No rebuild happens on a dist change.
      const buildsAfterBoot = buildCalls.length

      expect(buildsAfterBoot).toBe(1)

      // Let chokidar finish its initial scan, then simulate the turbo engine emitting a
      // fresh dist build (v2) — the signal the dev-server restarts on.
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      fs.writeFileSync(distHandler, handlerSource(2))

      const deadline = Date.now() + 8000
      let sawV2 = false

      while (Date.now() < deadline && !sawV2) {
        try {
          const body = (await (await fetch(`http://127.0.0.1:${omegaPort}/api/v1/ping`)).json()) as { version: number }

          if (body.version === 2) {
            sawV2 = true
            break
          }
        } catch {
          // Server briefly down mid-restart; keep polling.
        }
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      // Restarted and served the new dist on the same port…
      expect(sawV2).toBe(true)
      // …without any additional build (the restart is build-less in turbo mode).
      expect(buildCalls).toHaveLength(buildsAfterBoot)
    } finally {
      await runner.shutdown()
    }

    // shutdown() reaped the turbo engine and freed the port.
    expect(killed).toBe(true)
    expect(await canBind(omegaPort)).toBe(true)
  }, 15000)
})

describe('devServerRunner — frontends (default preset runs api + ui)', () => {
  it('warms UI deps, spawns the ui-dev child scoped to ui packages, and reaps it on shutdown', async () => {
    const root = temp.register(
      makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui' } }]),
    )
    const apiDir = path.join(root, 'apps', 'shop', 'api')
    const shopPort = await getFreePort()

    process.env.SHOP_PORT = String(shopPort)

    const buildCalls: string[] = []
    const fakeRunBuild = async (cmd: string): Promise<void> => {
      buildCalls.push(cmd)
      fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
    }

    // turbo watch isn't used without --watch; a no-op factory keeps the seam satisfied.
    const noopTurboWatch = (): { kill: () => Promise<void> } => {
      return {
        kill: (): Promise<void> => {
          return Promise.resolve()
        },
      }
    }

    let uiKilled = false
    let uiPackages: string[] | null = null
    let uiConcurrency = 0
    const fakeUiDev = (opts: { packageNames: string[]; concurrency: number }): { kill: () => Promise<void> } => {
      uiPackages = opts.packageNames
      uiConcurrency = opts.concurrency

      return {
        kill: (): Promise<void> => {
          uiKilled = true

          return Promise.resolve()
        },
      }
    }

    process.chdir(root)
    // No preset → default `*` runs everything the app exposes (api + ui).
    const runner = new DevServerRunner({}, fakeRunBuild, noopTurboWatch, fakeUiDev)

    await runner.start()

    try {
      // The API app still boots and serves (api + ui run together).
      const health = (await (await fetch(`http://127.0.0.1:${shopPort}/__health`)).json()) as { app: string }

      expect(health.app).toBe('shop')

      // The ui-dev child was spawned, scoped to the UI package only, with adequate concurrency.
      expect(uiPackages).toEqual(['shop-ui'])
      expect(uiConcurrency).toBeGreaterThanOrEqual(1)

      // A UI dependency-closure warm build ran (deps-only `^...`, not the UI's own build).
      expect(
        buildCalls.some((c) => {
          return c.includes('shop-ui^...')
        }),
      ).toBe(true)
    } finally {
      await runner.shutdown()
    }

    // shutdown() reaped the ui-dev child and freed the API port.
    expect(uiKilled).toBe(true)
    expect(await canBind(shopPort)).toBe(true)
  }, 15000)
})
