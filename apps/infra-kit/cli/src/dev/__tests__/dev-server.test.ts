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
  it('throws a clear error naming the port when two apps resolve to the same port', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // No per-app config and no env override => both resolve to 3010.
    delete process.env.PORT
    process.chdir(root)
    const runner = new DevServerRunner({})

    // The duplicate-port guard runs before any turbo build, so start() rejects
    // hermetically without ever shelling out.
    await expect(runner.start()).rejects.toThrow(/Port conflict detected: 3010/)
  })

  it('does not throw the conflict error when apps resolve to distinct ports', async () => {
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
