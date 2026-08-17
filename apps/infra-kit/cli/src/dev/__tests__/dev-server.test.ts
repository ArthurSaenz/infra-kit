import { DEV_CONTEXT_WIRE_VERSION } from '@slip-stream-kit/config/internal'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import type { ProbeOutcome } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'
import { DevLogSink } from 'src/dev/log-sink'
import type { ReadySummary } from 'src/dev/render'
import { stripAnsi } from 'src/dev/render'
import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'
import { DEFAULT_DEV_PROXY_PORT } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'

import {
  FAKE_PORTLESS_BIN,
  canBind,
  createTempTracker,
  daemonNeverStarts,
  getFreePort,
  handlerSource,
  makeFakeProxy,
  makeMonorepo,
  restoreCwd,
  restoreEnv,
  snapshotCwd,
  snapshotEnv,
  spyStdoutWrite,
  workingProxy,
} from './fixtures'
import type { FakeProxy, FakeProxyOptions } from './fixtures'

/**
 * Seeds `getInfraKitConfig` for the NAMED-preset static-locality tests only: every other test in this
 * file relies on it rejecting (this suite runs from a temp fixture, never the real repo root) and
 * falling back to `{}`, which is why every other preset here is threaded in-memory (`presetDef`). Reset
 * to `null` before each test so that fallback stays the default; `importOriginal` keeps every other
 * export (notably `DEFAULT_DEV_PROXY_PORT`, imported for real above) untouched.
 */
const presetConfigSeed = vi.hoisted(() => {
  return { config: null as InfraKitConfig | null }
})

vi.mock('src/lib/infra-kit-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/infra-kit-config')>()

  return {
    ...actual,
    getInfraKitConfig: vi.fn(() => {
      return presetConfigSeed.config ? Promise.resolve(presetConfigSeed.config) : actual.getInfraKitConfig()
    }),
  }
})

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
  presetConfigSeed.config = null
})

afterEach(() => {
  restoreCwd(cwdSnapshot)
  restoreEnv(envSnapshot)
  temp.cleanup()
})

/** A no-op turbo child (watch build / run dev): spawns nothing, resolves on kill. Shared across tests. */
const noopTurboChild = (): { kill: () => Promise<void> } => {
  return {
    kill: (): Promise<void> => {
      return Promise.resolve()
    },
  }
}

describe('devServerRunner — an app that fails to start', () => {
  /**
   * The regression: `startAllApps` logged the failure but never pushed the app to `appServers`, and
   * `printReady` renders the table FROM `appServers`. So a dead backend had no row at all — not even
   * `● down` — while the header still printed a green `ready in Xs`. A half-dead session was
   * indistinguishable from a healthy one.
   */
  it('gives the dead app a ● failed row and drops the green "ready" claim, while the survivor keeps serving', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'alpha', packageName: 'alpha-api', withHandler: true },
        { name: 'beta', packageName: 'beta-api', withHandler: true },
      ]),
    )
    const alphaPort = await getFreePort()
    const betaPort = await getFreePort()

    process.env.ALPHA_PORT = String(alphaPort)
    process.env.BETA_PORT = String(betaPort)

    // alpha builds clean; beta's handler blows up at import, exactly like the real
    // `config is missing field: 'connectionURL'` validation error that started this.
    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'alpha', 'api', 'dist', 'handler.js'), handlerSource(1))
      fs.writeFileSync(
        path.join(root, 'apps', 'beta', 'api', 'dist', 'handler.js'),
        'throw new Error("config is missing field: \'connectionURL\'")\n',
      )
    }

    const stdout: string[] = []

    spyStdoutWrite(stdout)
    process.chdir(root)

    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    // A PARTIAL failure must stay resident — the survivor is still useful and watch can recover beta.
    await runner.start()

    const painted = stripAnsi(stdout.join(''))

    // The dead app is on screen, named, with its reason — not silently missing.
    expect(painted).toContain('beta/api')
    expect(painted).toContain('● failed')
    expect(painted).toContain("config is missing field: 'connectionURL'")

    // And the header no longer claims a clean ready.
    expect(painted).toContain('1 failed')
    expect(painted).not.toMatch(/ready in \d/)

    // The survivor really is serving.
    const health = (await (await fetch(`http://127.0.0.1:${alphaPort}/__health`)).json()) as { app: string }

    expect(health).toMatchObject({ app: 'alpha' })

    await runner.shutdown()
  })

  it('exits non-zero rather than idling behind a banner when EVERY app failed and there is no UI', async () => {
    const root = temp.register(makeMonorepo([{ name: 'alpha', packageName: 'alpha-api', withHandler: true }]))

    process.env.ALPHA_PORT = String(await getFreePort())

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'alpha', 'api', 'dist', 'handler.js'), 'throw new Error("boom")\n')
    }

    spyStdoutWrite([])
    process.chdir(root)

    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    // Nothing is left to serve, watch, or proxy. Resident-but-empty would exit 0 when interrupted,
    // so a script or CI step would read this catastrophe as a success.
    await expect(runner.start()).rejects.toThrow(/no app started/)

    await runner.shutdown()
  })
})

/**
 * A preset whose target key is not an `<app>/api`|`<app>/ui` package identity (e.g. a bare
 * `backoffice`) used to reach `resolvePreset`'s `parseTargetKey`, which throws a raw error — an
 * uncaught stack trace with no naming of the run or remediation. The `dev` path now validates the
 * chosen preset's keys BEFORE resolution, so the run refuses with a human-readable, named message.
 */
describe('devServerRunner — a preset with an invalid target key', () => {
  it('refuses with a named, human-readable error instead of an uncaught parseTargetKey throw', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client', packageName: 'client-api', withHandler: true }]))

    spyStdoutWrite([])
    process.chdir(root)

    // `backoffice` is a bare app name, not a package — resolvePreset would throw raw on it. The
    // in-memory presetDef is the same seam the wizard uses; `preset` names the run in the message.
    const runner = new DevServerRunner(
      { preset: 'broken', presetDef: { apps: { backoffice: {} } } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    const error = await runner.start().then(
      () => {
        return null
      },
      (e: unknown) => {
        return e as Error
      },
    )

    // The guard's controlled refusal, naming the bad key and the expected `<app>/api|ui` form —
    // not the raw `devServersPresets: invalid target` throw that escaped parseTargetKey before.
    expect(error?.message).toContain('infra-kit dev: cannot run this preset')
    expect(error?.message).toContain('backoffice')
    expect(error?.message).toContain('<app>/api')

    await runner.shutdown()
  })
})

/**
 * `validatePresetProxy` (the STATIC locality rule) used to run only under `infra-kit audit` and the
 * bare-invocation wizard — never on `infra-kit dev <preset>`, so a preset whose `local` pin has no
 * backing backend sailed straight through to the RUNTIME pairing check, which can only catch it after
 * the backend has already failed to start (or not at all, if the backend was never even attempted).
 * This suite pins it to a genuinely NAMED preset (`getInfraKitConfig` seeded via `presetConfigSeed`,
 * not the in-memory `presetDef` seam every other preset test here uses) — the one path the static
 * check is actually scoped to.
 */
describe('devServerRunner — a named preset with a static proxy-locality violation', () => {
  /** `client/ui` proxies `/api` to `client-api`; whether the preset also launches `client/api` varies per test. */
  const withClientFixture = (): string => {
    return temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'client-api',
          withHandler: true,
          ui: {
            packageName: 'client-ui',
            proxy: {
              cloud: 'https://dev.example.com',
              routes: { '/api': { packageName: 'client-api', from: ['local', 'cloud'], default: 'cloud' } },
            },
          },
        },
      ]),
    )
  }

  it('refuses BEFORE any server spawns when the pinned route has no local backend in the preset', async () => {
    const root = withClientFixture()

    presetConfigSeed.config = {
      envManagement: { provider: 'doppler', config: { name: 'test' } },
      devServersPresets: { uiOnly: { apps: { 'client/ui': { proxy: { '/api': 'local' } } } } },
    }

    spyStdoutWrite([])
    process.chdir(root)

    const uiSpawns: string[][] = []
    const runner = new DevServerRunner(
      { preset: 'uiOnly' },
      undefined,
      undefined,
      ({ packageNames }) => {
        uiSpawns.push(packageNames)

        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    const error = await runner.start().then(
      () => {
        return null
      },
      (e: unknown) => {
        return e as Error
      },
    )

    // Named, actionable, and naming the preset, the route, and the backend that would satisfy it —
    // BEFORE anything runs, unlike the runtime check this complements.
    expect(error?.message).toContain('infra-kit dev: cannot run this preset')
    expect(error?.message).toContain('uiOnly')
    expect(error?.message).toContain('/api')
    expect(error?.message).toContain('client-api')

    // No server (backend or frontend) was ever spawned — the refusal happens inside `resolveRunPlan`,
    // before `bringUpProxy`/`buildAll`/`startAllApps` are reached.
    expect(uiSpawns).toEqual([])

    await runner.shutdown()
  })

  it('passes the static check (and boots) when the preset also launches the pinned route’s backend', async () => {
    const root = withClientFixture()
    const apiPort = await getFreePort()

    process.env.CLIENT_PORT = String(apiPort)
    presetConfigSeed.config = {
      envManagement: { provider: 'doppler', config: { name: 'test' } },
      devServersPresets: {
        clientLocal: { apps: { 'client/ui': { proxy: { '/api': 'local' } }, 'client/api': {} } },
      },
    }

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'), handlerSource(1))
    }

    spyStdoutWrite([])
    process.chdir(root)

    const runner = new DevServerRunner(
      { preset: 'clientLocal' },
      fakeRunBuild,
      noopTurboChild,
      () => {
        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    // The static check must not refuse a preset that DOES launch the backend its pin needs — proving
    // this is a real locality check, not a blanket refusal of every `local` pin under a named preset.
    await expect(runner.start()).resolves.toBeUndefined()

    const health = (await (await fetch(`http://127.0.0.1:${apiPort}/__health`)).json()) as { app: string }

    expect(health).toMatchObject({ app: 'client' })

    await runner.shutdown()
  })
})

/**
 * The silent-cloud bug, end to end.
 *
 * A `*Local` preset launches `<app>/api` + `<app>/ui` and the frontend's `/api` route names that
 * backend. When the backend dies on boot it writes no dev-context fragment, so the vite helper's
 * `pickSource` finds an empty local set and falls through to the route's `default: 'cloud'`. The
 * frontend then comes up healthy, proxying every `/api` request at the shared cloud backend — and
 * nothing on screen says so. The `● failed` row is about the BACKEND; it cannot report that the
 * frontend beside it is now misrouted.
 */
describe('devServerRunner — a local-pinned route whose backend failed', () => {
  /**
   * hulyo's `clientLocal`, verbatim, handed in as an in-memory `presetDef` (the same seam the wizard
   * uses) rather than written to an `infra-kit.json` — the layered config resolves a named preset
   * against the real repo root, not the temp fixture, so a named lookup here would never find it.
   * `preset` still rides along, because it is what labels the run in the refusal message.
   */
  const CLIENT_LOCAL = {
    preset: 'clientLocal',
    presetDef: { apps: { 'client/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } },
  }

  /** `client/api` + `client/ui`, the UI's `/api` pinned to the api's package, and the api throwing on boot. */
  const brokenPairing = async (): Promise<{ root: string; fakeRunBuild: () => Promise<void> }> => {
    const root = temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'backend-api',
          withHandler: true,
          ui: {
            packageName: 'website-ui',
            proxy: {
              cloud: 'https://<env>.hulyo.co.il',
              routes: {
                // `default: 'cloud'` is REQUIRED by the schema for a multi-source route — and it is
                // exactly the fallback that makes the failure silent.
                '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
                // Cloud-only by design — it must never be reported as degraded.
                '/media': { packageName: 'backend-api', from: ['cloud'] },
              },
            },
          },
        },
      ]),
    )

    process.env.CLIENT_PORT = String(await getFreePort())
    process.env[INFRA_KIT_ENV_VAR] = 'dev'

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(
        path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'),
        'throw new Error("config is missing field: \'connectionURL\'")\n',
      )
    }

    return { root, fakeRunBuild }
  }

  it('refuses to start, naming the route, the cloud origin, and the backend error', async () => {
    const { root, fakeRunBuild } = await brokenPairing()

    spyStdoutWrite([])
    process.chdir(root)

    // A spy in the uiDevFactory slot: a refusal that still spawned vite would leave a frontend running
    // against cloud — the exact outcome being refused.
    const uiSpawns: string[][] = []
    const runner = new DevServerRunner(
      CLIENT_LOCAL,
      fakeRunBuild,
      undefined,
      ({ packageNames }) => {
        uiSpawns.push(packageNames)

        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    const error = await runner.start().then(
      () => {
        return null
      },
      (e: unknown) => {
        return e as Error
      },
    )

    expect(error?.message).toContain('clientLocal')
    expect(error?.message).toContain('client/ui /api')
    expect(error?.message).toContain('https://dev.hulyo.co.il')
    expect(error?.message).toContain("config is missing field: 'connectionURL'")

    // The cloud-only route was always going to cloud — flagging it would cry wolf on every run.
    expect(error?.message).not.toContain('/media')

    // And no frontend was ever spawned.
    expect(uiSpawns).toEqual([])

    await runner.shutdown()
  })

  it('stays resident under --watch instead, painting a degraded row that names the cloud origin', async () => {
    const { root, fakeRunBuild } = await brokenPairing()
    const stdout: string[] = []

    spyStdoutWrite(stdout)
    process.chdir(root)

    const runner = new DevServerRunner(
      { ...CLIENT_LOCAL, watch: true },
      fakeRunBuild,
      () => {
        return { kill: async () => {} }
      },
      () => {
        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    // `--watch` earns the exception because it can actually fix this: the boot-failed api is a restart
    // target, so the next save can bring it up and take the degraded row down with it.
    await runner.start()

    const painted = stripAnsi(stdout.join(''))

    expect(painted).toContain('● cloud (local backend down)')
    expect(painted).toContain('client/ui /api')
    expect(painted).toContain('https://dev.hulyo.co.il')

    await runner.shutdown()
  })

  /**
   * The second bug, and the one that made the `--watch` carve-out above worth having at all.
   *
   * `resolveRestartTargets` used to look a target up in `appServers` and drop it when the index came back
   * `-1`. A boot-failed app is never IN `appServers` — `startAllApps` only pushes the ones that booted —
   * so it could never be a restart target: watch would rebuild its dist on every save and restart nothing.
   * The backend stayed dead for the whole session no matter how many times you fixed the file that broke
   * it, and its frontend spent that whole session proxying to cloud.
   */
  it('brings a boot-failed backend back on the next save, and the degraded row clears with it', async () => {
    const { root, fakeRunBuild } = await brokenPairing()

    spyStdoutWrite([])
    process.chdir(root)

    // A renderer that captures every repaint: `refresh` is the ONLY seam that can show the degraded row
    // going away, since the header is committed once and never revised.
    const painted: ReadySummary[] = []
    const capturing: DevUi = {
      narrate: () => {},
      log: () => {},
      logFn: () => {},
      bootStep: () => {},
      ready: (summary) => {
        painted.push(summary)
      },
      refresh: (summary) => {
        painted.push(summary)
      },
      dispose: () => {},
    }
    const latestDegraded = (): ReadySummary['degraded'] => {
      return painted.at(-1)?.degraded
    }

    const runner = new DevServerRunner(
      { ...CLIENT_LOCAL, watch: true },
      fakeRunBuild,
      () => {
        return { kill: async () => {} }
      },
      () => {
        return { kill: async () => {} }
      },
      undefined,
      capturing,
      undefined,
      workingProxy(),
    )

    await runner.start()

    // The boot paint carries the warning.
    expect(latestDegraded()).toEqual([
      { route: '/api', tag: 'client/ui', fallback: 'cloud', target: 'https://dev.hulyo.co.il' },
    ])

    // The runner's OWN record of the app being up. Deliberately not `process.env.CLIENT_PORT`: that is
    // only a preferred-port HINT, and a busy machine can hand the hint to someone else and leave the app
    // on an ephemeral port — a probe pinned to the hint then fails for a backend that is serving fine.
    // The fragment carries the port actually bound, and writing it is the very act that flips the vite
    // helper's route back to `local`, so it is also the thing under test.
    const fragment = path.join(root, '.infra-kit', 'dev-context', 'client.json')
    const boundPort = (): number | null => {
      try {
        return (JSON.parse(fs.readFileSync(fragment, 'utf-8')) as { port: number }).port
      } catch {
        return null
      }
    }

    // It really is dead to begin with: a backend that never started writes no fragment.
    expect(boundPort()).toBeNull()

    const waitUntil = async (done: () => boolean, onTick?: () => void): Promise<void> => {
      const deadline = Date.now() + 20_000

      while (Date.now() < deadline && !done()) {
        onTick?.()
        await new Promise((resolve) => {
          return setTimeout(resolve, 250)
        })
      }
    }

    // The fix lands in dist — exactly what `turbo watch build` does on a save. Real chokidar picks it up
    // (400ms debounce + a 200ms write-finish settle), so this exercises the real restart path, not a stub.
    //
    // Re-saved on every tick rather than written once, because the watcher is armed ASYNCHRONOUSLY and
    // runs with `ignoreInitial: true`: a write that lands before its initial scan completes is taken for
    // part of that scan and dropped. Writing once made this test pass alone and fail under a loaded
    // machine, where the watcher takes longer to become ready — a false red on a real fix. Saving again
    // is also exactly what a developer does, so nothing is being papered over.
    const save = (): void => {
      fs.writeFileSync(path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'), handlerSource(1))
    }

    await waitUntil(() => {
      return boundPort() != null
    }, save)

    // The backend that could never come back, came back — and is really serving on the port it recorded.
    const port = boundPort()

    expect(port, 'watch never restarted the boot-failed backend').not.toBeNull()
    expect((await fetch(`http://127.0.0.1:${port}/__health`)).ok).toBe(true)

    // And the warning goes with it. The liveness tick drives the repaint, so wait for one that reflects
    // the recovered app: a row that outlived its cause is a warning nobody reads.
    await waitUntil(() => {
      return (latestDegraded()?.length ?? 0) === 0
    })

    expect(latestDegraded(), 'the degraded row survived its own backend recovering').toEqual([])

    await runner.shutdown()
  }, 60_000)

  it('does not refuse when the frontend route can only ever be cloud', async () => {
    const root = temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'backend-api',
          withHandler: true,
          ui: {
            packageName: 'website-ui',
            // Every route is cloud-only: a dead backend demotes nothing, so there is nothing to refuse.
            proxy: { routes: { '/media': { packageName: 'backend-api', from: ['cloud'] } } },
          },
        },
      ]),
    )

    process.env.CLIENT_PORT = String(await getFreePort())
    process.env[INFRA_KIT_ENV_VAR] = 'dev'

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'), 'throw new Error("boom")\n')
    }

    spyStdoutWrite([])
    process.chdir(root)

    const runner = new DevServerRunner(
      { preset: 'clientUICloud', presetDef: { apps: { 'client/ui': {}, 'client/api': {} } } },
      fakeRunBuild,
      undefined,
      () => {
        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await expect(runner.start()).resolves.toBeUndefined()

    await runner.shutdown()
  })

  /**
   * The `--app` / `--self` hole, which a crash-keyed rule cannot see.
   *
   * `resolveRunPlan` applies the include filter AFTER preset resolution, and it filters apis and UIs
   * independently. So `--app client` on a preset that pairs `client/ui` with `backoffice/api` drops the
   * backend entirely: it is never attempted, so it never lands in `failedApps`, so there is no crash to
   * key off — and `client/ui` comes up proxying `/api` at the shared cloud backend in total silence. The
   * rule keys on INTENT (`wanted`, captured pre-narrowing) precisely so this is caught.
   */
  it('refuses when a narrowing flag dropped the backend a launched frontend needs — no crash to key off', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'backoffice', packageName: 'backoffice-api', withHandler: true },
        {
          name: 'client',
          packageName: 'backend-api',
          withHandler: true,
          ui: {
            packageName: 'website-ui',
            proxy: {
              cloud: 'https://<env>.hulyo.co.il',
              // Cross-app: client's frontend is served by BACKOFFICE's backend.
              routes: {
                '/api': { packageName: 'backoffice-api', from: ['local', 'cloud'], default: 'cloud' },
              },
            },
          },
        },
      ]),
    )

    process.env.CLIENT_PORT = String(await getFreePort())
    process.env.BACKOFFICE_PORT = String(await getFreePort())
    process.env[INFRA_KIT_ENV_VAR] = 'dev'

    const fakeRunBuild = async (): Promise<void> => {}

    spyStdoutWrite([])
    process.chdir(root)

    const uiSpawns: string[][] = []
    const runner = new DevServerRunner(
      {
        preset: 'crossApp',
        presetDef: { apps: { 'client/ui': {}, 'backoffice/api': {} } },
        // `--app client` keeps client/ui and silently drops backoffice/api.
        include: ['client'],
      },
      fakeRunBuild,
      undefined,
      ({ packageNames }) => {
        uiSpawns.push(packageNames)

        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    const error = await runner.start().then(
      () => {
        return null
      },
      (e: unknown) => {
        return e as Error
      },
    )

    expect(error?.message, 'a backend dropped by --app must not silently become a cloud proxy').toContain(
      'backoffice-api',
    )
    expect(error?.message).toContain('never launched')
    expect(error?.message).toContain('https://dev.hulyo.co.il')
    // …and it must NOT send them off to wait on a --watch retry that can never fire: `runRestart` only
    // ever sees the post-narrowing app list, so this backend is not a restart target and never becomes one.
    expect(error?.message).not.toContain('--watch')
    expect(uiSpawns).toEqual([])

    await runner.shutdown()
  })

  /**
   * The false-positive direction, which the intent rule must not trip on.
   *
   * A UI-only preset is how you deliberately develop a frontend against cloud. Its routes still declare
   * `from: ['local','cloud']` — they are LOCAL-CAPABLE — but the preset names no api target and pins
   * nothing, so nothing about this run intended a local backend. Refusing it would break the single most
   * common frontend workflow there is.
   */
  it('starts a deliberate UI-only run against cloud — local-capable is not the same as intended-local', async () => {
    const root = temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'backend-api',
          withHandler: true,
          ui: {
            packageName: 'website-ui',
            proxy: {
              cloud: 'https://<env>.hulyo.co.il',
              routes: { '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' } },
            },
          },
        },
      ]),
    )

    process.env[INFRA_KIT_ENV_VAR] = 'dev'

    const fakeRunBuild = async (): Promise<void> => {}

    spyStdoutWrite([])
    process.chdir(root)

    const runner = new DevServerRunner(
      // No api target, no `local` pin: the backend is simply not part of this run.
      { preset: 'clientUICloud', presetDef: { apps: { 'client/ui': {} } } },
      fakeRunBuild,
      undefined,
      () => {
        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await expect(runner.start()).resolves.toBeUndefined()

    await runner.shutdown()
  })
})

describe('devServerRunner — the ready header lists each frontend’s resolved proxies', () => {
  it('attaches /api as local (its running backend’s origin) and a cloud-only /media as cloud to the UI row', async () => {
    const root = temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'backend-api',
          withHandler: true,
          ui: {
            packageName: 'website-ui',
            viteConfig: true,
            proxy: {
              cloud: 'https://<env>.hulyo.co.il',
              routes: {
                '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
                '/media': { packageName: 'backend-api', from: ['cloud'] },
              },
            },
          },
        },
      ]),
    )

    gitInitOnBranch(root, 'feat-x')
    process.env.CLIENT_PORT = String(await getFreePort())
    process.env[INFRA_KIT_ENV_VAR] = 'dev'
    process.chdir(root)

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'), handlerSource(1))
    }
    const { renderer, summary } = makeCapturingRenderer()
    const runner = new DevServerRunner(
      { presetDef: { apps: { 'client/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } } },
      fakeRunBuild,
      noopTurboChild,
      noopTurboChild,
      undefined,
      renderer,
      (): Promise<ProbeOutcome> => {
        return Promise.resolve('ok')
      },
      workingProxy(),
    )

    await runner.start()

    try {
      const s = summary()
      const ui =
        s.endpoints.find((e) => {
          return e.tag === 'client/ui'
        }) ??
        s.uiRefs.find((u) => {
          return u.tag === 'client/ui'
        })

      // Which one: /api resolves local (its backend is up), /media is cloud-only — sorted by route path.
      expect(
        ui?.proxies?.map((p) => {
          return { route: p.route, source: p.source }
        }),
      ).toEqual([
        { route: '/api', source: 'local' },
        { route: '/media', source: 'cloud' },
      ])
      // Where: the local route points at the running backend's own origin, the cloud route at the env origin.
      expect(
        ui?.proxies?.find((p) => {
          return p.route === '/api'
        })?.target,
      ).toContain('backend-api')
      expect(
        ui?.proxies?.find((p) => {
          return p.route === '/media'
        })?.target,
      ).toBe('https://dev.hulyo.co.il')
    } finally {
      await runner.shutdown()
    }
  }, 15000)
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

    // The runner resolves the monorepo root from cwd, so run from the fixture root. A working proxy is
    // injected (8th arg) so the boot never depends on a portless daemon running on the host.
    process.chdir(root)
    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

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
    // A working proxy is injected so the conflict guard (which runs after `ensureProxy`) is reached
    // hermetically, without a portless daemon on the host.
    const runner = new DevServerRunner(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

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
    // A working proxy is injected so `ensureProxy` (which precedes the build) is hermetic; the build then
    // fails on the missing turbo, proving we got past both the proxy step and the conflict gate.
    const runner = new DevServerRunner(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await expect(runner.start()).rejects.not.toThrow(/Port conflict/)
  })

  it('does not throw the conflict error when apps are explicitly pinned to distinct ports', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // Distinct per-app ports via env keep the pre-check happy; the build step then
    // fails (no turbo in the fixture) — proving we got past the port guard.
    process.env.CLIENT_PORT = '3010'
    process.env.BACKOFFICE_PORT = '3011'
    process.chdir(root)
    // Working proxy injected so `ensureProxy` is hermetic (see the sibling relaxed-gate test).
    const runner = new DevServerRunner(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await expect(runner.start()).rejects.not.toThrow(/Port conflict/)
  })
})

/**
 * A bare `PORT` is the one port tier that is not app-scoped. Applied to every discovered app it
 * manufactures a duplicate out of thin air, and the conflict gate — which exists to catch a developer
 * pinning two apps to one port on purpose — then refuses to start a run the developer configured
 * correctly. One stray `PORT` in a shell or a Doppler env was enough to make multi-app dev unusable.
 */
/**
 * The minimum a real boot needs from a build: a compiled handler in each app's `dist`. Stands in for
 * the turbo shell-out the fixtures deliberately do not provide.
 */
/** The runner announces every restart with this prefix; counting them is how a watch burst is judged. */
const isRestartLine = (line: string): boolean => {
  return line.includes('🔄 Restarting')
}

const writeHandlers = (root: string, appNames: string[]): (() => Promise<void>) => {
  return async (): Promise<void> => {
    for (const name of appNames) {
      fs.writeFileSync(path.join(root, 'apps', name, 'api', 'dist', 'handler.js'), handlerSource(1))
    }
  }
}

describe('start — a bare PORT must not manufacture a conflict across apps', () => {
  it('does NOT throw when ≥2 apps see the same bare PORT (it is env-wide, not a per-app pin)', async () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    // Only the ENV-WIDE tier is set. Before this fix both apps resolved `preferredPort = 3300`,
    // `findPortConflicts` saw a duplicate, and `start()` rejected with `Port conflict detected: 3300`.
    // The build then fails on the missing turbo, proving the gate itself was cleared.
    process.env.PORT = '3300'
    delete process.env.CLIENT_PORT
    delete process.env.BACKOFFICE_PORT
    process.chdir(root)
    const runner = new DevServerRunner(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await expect(runner.start()).rejects.not.toThrow(/Port conflict/)
  })

  it('still honours a bare PORT when the run launches exactly ONE app', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'client', packageName: 'client-api', withHandler: true },
        { name: 'backoffice', packageName: 'backoffice-api', withHandler: true },
      ]),
    )
    const fakeRunBuild = writeHandlers(root, ['client', 'backoffice'])

    // Two apps are DISCOVERED but only one is launched, which is the case the count must be taken on:
    // taking it where the ports are resolved would see 2 here and wrongly drop the bare tier.
    const port = await getFreePort()

    process.env.PORT = String(port)
    delete process.env.CLIENT_PORT
    delete process.env.BACKOFFICE_PORT
    process.chdir(root)
    const runner = new DevServerRunner(
      { include: ['client'] },
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      const health = (await (await fetch(`http://127.0.0.1:${port}/__health`)).json()) as {
        app: string
        port: number
      }

      expect(health).toMatchObject({ app: 'client', port })
    } finally {
      await runner.shutdown()
    }
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
    // Working proxy injected (8th arg) so the real boot below is hermetic — no host portless daemon.
    const runner = new DevServerRunner(
      { include: ['client'] },
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

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
  verbose = false,
  routes = false,
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
  // Working proxy injected (8th arg) so every header/narration test that boots through this helper is
  // hermetic and never depends on a portless daemon running on the host.
  const runner = new DevServerRunner(
    { verbose, routes },
    fakeRunBuild,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workingProxy(),
  )

  try {
    await runner.start()
  } finally {
    spy.mockRestore()
  }

  return { out: writes.join(''), runner }
}

describe('devServerRunner — startup ready header', () => {
  it('leads with a tagged endpoint row: <app>/api tag, a prefix-carrying URL, and a health dot', async () => {
    const longName = 'super-long-application-name'
    const { out, runner } = await bootAndCaptureStdout(temp, longName)

    try {
      // The endpoint row is the hero: `<app>/api  http://localhost:<port>/api/v1  ● ok`.
      expect(out).toContain(`${longName}/api`)
      expect(out).toContain('/api/v1')
      expect(out).toContain('● ok')
      // The redundant scheme legend is gone; the log link + separator rule close the calm header.
      expect(out).not.toContain('scheme')
      // The header points at the log DIRECTORY, not a file: there is one log per service now, so a
      // single path would have to pick a favourite. The `<pid>` leaf is what keeps concurrent cmux
      // panes — which all inherit one INFRA_KIT_SESSION — out of each other's files.
      expect(out).toMatch(/logs → .*[/\\]dev[/\\]\d+/)
      expect(out).toContain('─'.repeat(60))
      // No box-drawn table lines survive the redesign.
      expect(
        out.split('\n').filter((line) => {
          return /^[┌│├└]/.test(line)
        }),
      ).toHaveLength(0)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — startup route dump (--routes)', () => {
  it('lists each app registered METHOD /path routes only when --routes is set', async () => {
    // Opt-in: the route dump prints to the terminal only with --routes (no longer verbose-gated).
    const { out, runner } = await bootAndCaptureStdout(temp, 'epsilon', false, true)

    try {
      expect(out).toContain('Registered routes')
      expect(out).toContain('epsilon')
      // The monorepo fixture declares a single GET /api/v1/ping route.
      expect(out).toContain('GET /api/v1/ping')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('omits the route dump by default (no --routes)', async () => {
    const { out, runner } = await bootAndCaptureStdout(temp, 'epsilon')

    try {
      expect(out).not.toContain('Registered routes')
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — quiet by default (--verbose)', () => {
  it('suppresses boot narration from stdout by default, but keeps the server panel', async () => {
    const { out, runner } = await bootAndCaptureStdout(temp, 'zeta')

    try {
      // Narration steps are gated out of the terminal…
      expect(out).not.toContain('Starting Development Server Runner')
      expect(out).not.toContain('Build complete')
      expect(out).not.toContain('Registered routes')
      // …while the endpoint header (the hero) still shows.
      expect(out).toContain('/api/v1')
      expect(out).toContain('zeta/api')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('--verbose surfaces the full boot narration', async () => {
    const { out, runner } = await bootAndCaptureStdout(temp, 'zeta', true)

    try {
      expect(out).toContain('Starting Development Server Runner')
      expect(out).toContain('Build complete')
      // The route dump is no longer verbose-gated (it moved to --routes); assert other narration.
      expect(out).toContain('All servers started')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('gates debug-level chatter (the Doppler banner) unless --verbose', async () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev'

    const quiet = await bootAndCaptureStdout(temp, 'theta')

    await quiet.runner.shutdown()

    const loud = await bootAndCaptureStdout(temp, 'theta', true)

    await loud.runner.shutdown()

    // `debug`-level lines (e.g. the Doppler banner, per-save dist-change ticks) must not leak into
    // the quiet terminal — only --verbose surfaces them. Both always reach the log file.
    expect(quiet.out).not.toContain('Doppler env detected')
    expect(loud.out).toContain('Doppler env detected')
  }, 15000)

  it('closes shutdown on a visible "dev stopped" line even in quiet mode', async () => {
    const { runner } = await bootAndCaptureStdout(temp, 'kappa')

    // Capture ONLY the shutdown output (the boot spy is already restored) so we assert on what
    // Ctrl-C leaves on screen: infra-kit's own closing line, not the child's raw teardown noise.
    const writes: string[] = []
    const spy = spyStdoutWrite(writes)

    await runner.shutdown()
    spy.mockRestore()

    // Not verbose-gated: the runner booted with verbose:false, yet the confirmation still reaches stdout.
    expect(writes.join('')).toContain('dev stopped')
  }, 15000)
})

/*
 * `git` from PATH in a test fixture — trusted, fixed literal args. Same posture as the dev-server's own
 * `git rev-parse` (readAppRelease) which carries this disable inline.
 */
/* eslint-disable sonarjs/no-os-command-from-path */
/** Make `root` a git repo checked out on `branch` with one commit (so `rev-parse --abbrev-ref HEAD` resolves). */
const gitInitOnBranch = (root: string, branch: string): void => {
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.email=t@test.dev', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init'],
    { cwd: root },
  )
}
/* eslint-enable sonarjs/no-os-command-from-path */

/**
 * Construct an api-only monorepo runner with an injected portless driver WITHOUT starting it; returns
 * the runner, the monorepo root (for dev-context fragment assertions) and the driver's records. The
 * caller decides whether `start()` should resolve or reject, so both the happy path ({@link bootWithProxy})
 * and the proxy-failure reject tests share this one setup instead of copy-pasting the fixture wiring.
 */
const setupProxyRunner = async (
  temp: ReturnType<typeof createTempTracker>,
  appName: string,
  branch: string,
  available: boolean,
  packageName = `${appName}-api`,
  daemonOk?: (port: number) => boolean,
  proxyOptions?: FakeProxyOptions,
): Promise<{ runner: DevServerRunner; root: string } & FakeProxy> => {
  const root = temp.register(makeMonorepo([{ name: appName, packageName, withHandler: true }]))

  gitInitOnBranch(root, branch)
  const port = await getFreePort()

  process.env[`${appName.toUpperCase()}_PORT`] = String(port)
  const apiDir = path.join(root, 'apps', appName, 'api')
  const fakeRunBuild = async (): Promise<void> => {
    fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
  }

  process.chdir(root)
  const fake = makeFakeProxy(available, daemonOk, undefined, proxyOptions)
  const { driver } = fake
  // ctor positions: options, runBuild, turboWatchFactory, uiDevFactory, dryRunner, renderer, healthProbe, proxy
  const runner = new DevServerRunner({}, fakeRunBuild, undefined, undefined, undefined, undefined, undefined, driver)

  return { runner, root, ...fake }
}

/** {@link setupProxyRunner} + a successful `start()` — the happy-path boot used by most Layer-B tests. */
const bootWithProxy = async (
  temp: ReturnType<typeof createTempTracker>,
  appName: string,
  branch: string,
  available: boolean,
  packageName = `${appName}-api`,
  daemonOk?: (port: number) => boolean,
): Promise<{ runner: DevServerRunner; root: string } & FakeProxy> => {
  const setup = await setupProxyRunner(temp, appName, branch, available, packageName, daemonOk)

  await setup.runner.start()

  return setup
}

describe('devServerRunner — Layer B portless aliases', () => {
  it('registers <release>.<package> for a backend on start and removes it on shutdown', async () => {
    const { runner, registered, removed } = await bootWithProxy(temp, 'client', 'feat-x', true)

    try {
      expect(registered).toContainEqual(['feat-x.client-api', expect.any(Number)])
    } finally {
      await runner.shutdown()
    }
    expect(removed).toContain('feat-x.client-api')
  }, 15000)

  it('rejects the boot when portless is unavailable (there is no localhost fallback)', async () => {
    // A dev URL is a portless-served hostname and nothing else, so an unavailable proxy is a fatal start
    // error, not a degraded mode — `start()` must reject naming the fix rather than boot into dead routes.
    const { runner } = await setupProxyRunner(temp, 'client', 'feat-x', false)

    await expect(runner.start()).rejects.toThrow(/portless is not installed/)
  }, 15000)

  it('slugifies a scoped package name into a legal DNS label before registering the alias', async () => {
    // Regression: `@hulyo/client-ui` went into the alias raw, so portless rejected the hostname
    // (`Invalid hostname "feat-x.@hulyo"`). The driver swallows that into a best-effort `false`, so
    // BOTH the API row and the UI row silently fell back to `http://localhost:<port>` — the hero URLs
    // just never appeared, with no error surfaced to the user.
    const { runner, registered, removed } = await bootWithProxy(temp, 'client', 'feat-x', true, '@hulyo/client-ui')

    try {
      expect(registered).toContainEqual(['feat-x.hulyo-client-ui', expect.any(Number)])
      // No registered alias may carry a character portless rejects.
      for (const [name] of registered) expect(name).toMatch(/^[a-z0-9.-]+$/)
    } finally {
      await runner.shutdown()
    }
    // Cleanup must deregister the exact slugified name it registered (no leaked alias).
    expect(removed).toContain('feat-x.hulyo-client-ui')
  }, 15000)

  it('only ever checks :443 — the port is not negotiable', async () => {
    // A port-free `https://` URL can only be served from the implicit HTTPS port, so there is exactly one
    // port to check. No `--proxy-port`, no `devProxy.port`, no unprivileged fallback: every one of those
    // would put the port straight back into the URL, which is the thing this design removes.
    const { runner, ensuredPorts } = await bootWithProxy(temp, 'client', 'feat-x', true)

    try {
      expect(ensuredPorts).toEqual([DEFAULT_DEV_PROXY_PORT])
      expect(DEFAULT_DEV_PROXY_PORT).toBe(443)
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('rejects the boot when the OS service was never installed, naming BOTH fixes as commands that actually RUN', async () => {
    // There is no fallback to degrade into, so this refusal is the entire user experience of an
    // un-provisioned machine. It has to name the two commands that fix it — and distinguish them: the
    // install needs root, `trust` explicitly does not. `daemonNeverStarts` + the fake's default
    // `serviceInstalled: 'no'` is the SERVICE_NOT_INSTALLED classification.
    //
    // Both must be printed as `<node> <abs>/portless/dist/cli.js …`, never as a bare `portless …`: portless
    // lives in node_modules and is not on PATH, and sudo swaps PATH for secure_path — so the bare form dies
    // with `sudo: portless: command not found`, which is exactly what a user hit. Asserting the bare string
    // is what let that ship, so the bare form is asserted ABSENT here.
    const { runner, ensuredPorts } = await setupProxyRunner(
      temp,
      'client',
      'feat-x',
      true,
      undefined,
      daemonNeverStarts,
    )

    const error = await runner.start().then(
      () => {
        return new Error('start() resolved, but an un-provisioned machine must refuse to boot')
      },
      (err: unknown) => {
        return err as Error
      },
    )

    // Elevated as `sudo <absolute node> …`: sudo resolves an interpreter it is handed, never a name it would
    // have to look up on the PATH it just replaced with secure_path. The bin is the one the INJECTED driver
    // reports, and it contains a space — so this also proves the rendering is quoted, which a shell-safe
    // fixture path could not.
    expect(error.message).toContain(`sudo ${process.execPath} '${FAKE_PORTLESS_BIN}' service install`)
    expect(error.message).toContain(`${process.execPath} '${FAKE_PORTLESS_BIN}' trust`)
    expect(error.message).not.toContain('sudo portless service install')
    expect(error.message).not.toMatch(/^ *portless trust$/m)
    // Probed :443 and stopped. A probe of an unprivileged port would mean a fallback still exists.
    expect(ensuredPorts).toEqual([DEFAULT_DEV_PROXY_PORT])
  }, 15000)

  it('rejects with a DIFFERENT message when the service IS installed but the daemon is not responding', async () => {
    // Same TCP-refused symptom as the un-provisioned case above, but the OS-service check now says `'yes'`
    // — a daemon that was installed once and has since crashed or been stopped. The fix is a restart, not a
    // fresh root install, so the message must not repeat the "never installed" text and must not tell the
    // user to `trust` a CA they already trusted.
    const { runner, ensuredPorts } = await setupProxyRunner(
      temp,
      'client',
      'feat-x',
      true,
      undefined,
      daemonNeverStarts,
      { serviceInstalled: 'yes' },
    )

    const error = await runner.start().then(
      () => {
        return new Error('start() resolved, but a dead daemon must refuse to boot')
      },
      (err: unknown) => {
        return err as Error
      },
    )

    expect(error.message).toContain('OS service is installed')
    expect(error.message).toContain(`${process.execPath} '${FAKE_PORTLESS_BIN}' service status`)
    expect(error.message).toContain(`sudo ${process.execPath} '${FAKE_PORTLESS_BIN}' service install`)
    // This is a restart story, not a fresh-install story — the "not installed yet" text and the runnable
    // `trust` command belong to the sibling test above and must not leak into this one.
    expect(error.message).not.toContain('is not installed yet')
    expect(error.message).not.toContain(`${process.execPath} '${FAKE_PORTLESS_BIN}' trust`)
    expect(ensuredPorts).toEqual([DEFAULT_DEV_PROXY_PORT])
  }, 15000)

  it('rejects with a THIRD message when something else (not portless) is squatting on the port', async () => {
    // TCP accepts the connection, but the wire probe never returns the `X-Portless` header — a different
    // process already holds :443. Neither `service install` nor `trust` would free the port, so this message
    // must point at finding/stopping the squatter instead of repeating either portless-provisioning fix.
    const { runner, ensuredPorts } = await setupProxyRunner(
      temp,
      'client',
      'feat-x',
      true,
      undefined,
      daemonNeverStarts,
      { notPortless: true },
    )

    const error = await runner.start().then(
      () => {
        return new Error('start() resolved, but a squatted port must refuse to boot')
      },
      (err: unknown) => {
        return err as Error
      },
    )

    expect(error.message).toContain('not portless')
    expect(error.message).toContain(`:${DEFAULT_DEV_PROXY_PORT}`)
    // Neither remediation applies here — no fix is a runnable portless command at all.
    expect(error.message).not.toContain(`${FAKE_PORTLESS_BIN}' service install`)
    expect(error.message).not.toContain(`${FAKE_PORTLESS_BIN}' trust`)
    expect(ensuredPorts).toEqual([DEFAULT_DEV_PROXY_PORT])
  }, 15000)

  it('publishes `origin` in the fragment and NEVER a proxyPort an old helper could misgraft', async () => {
    // The fragment is the contract between the self-updating CLI and each consumer's PINNED
    // `infra-kit/vite`. An old helper's `withProxyPort` grafts any port != 80 onto its target, so writing
    // `proxyPort: 443` would have yielded `http://<alias>:443` — plain HTTP into a TLS listener, silently.
    // The runner publishes the finished origin instead, and the helper obeys it verbatim.
    const { runner, root } = await bootWithProxy(temp, 'client', 'feat-x', true)

    try {
      const raw = fs.readFileSync(path.join(root, '.infra-kit', 'dev-context', 'client.json'), 'utf-8')
      const fragment = JSON.parse(raw) as { alias?: string; origin?: string; proxyPort?: number }

      expect(fragment.alias).toBe('feat-x.client-api.localhost')
      expect(fragment.origin).toBe('https://feat-x.client-api.localhost')
      expect(fragment.proxyPort).toBeUndefined()
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('writes the fragment AFTER the alias is registered, carrying release, alias, origin and bound port', async () => {
    // The fragment is the ONLY channel telling `infra-kit/vite` how to reach this app. It must be written
    // AFTER registerAppAlias, or it could only ever claim `alias: undefined` and the frontend would target
    // an app it believes is unreachable. `port` is the app's own bound port (provenance); `origin` is what
    // the helper actually proxies to.
    const { runner, root } = await bootWithProxy(temp, 'client', 'feat-x', true)

    try {
      const raw = fs.readFileSync(path.join(root, '.infra-kit', 'dev-context', 'client.json'), 'utf-8')
      const fragment = JSON.parse(raw) as {
        v?: number
        release?: string
        alias?: string
        origin?: string
        port: number
      }

      expect(fragment.release).toBe('feat-x')
      expect(fragment.alias).toBe('feat-x.client-api.localhost')
      expect(fragment.origin).toBe('https://feat-x.client-api.localhost')
      expect(fragment.port).toBeGreaterThan(0)
      // The wire version is what lets the helper tell "an old CLI wrote this, legacy mode is correct" apart
      // from "a current CLI wrote a broken fragment, legacy mode proxies plain HTTP into a TLS listener".
      // Drop it and the helper silently falls back to guessing — so assert the writer really stamps it.
      expect(
        fragment.v,
        'a fragment with no `v` reads as a pre-v2 writer, sending the helper down the legacy template path',
      ).toBe(DEV_CONTEXT_WIRE_VERSION)
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
    let spawnedUiClosure: string[] | null = null
    const fakeTurboWatch = (opts: { depInclusive: string[]; depClosure: string[] }): { kill: () => Promise<void> } => {
      spawnedPackages = opts.depInclusive
      spawnedUiClosure = opts.depClosure

      return {
        kill: (): Promise<void> => {
          killed = true

          return Promise.resolve()
        },
      }
    }

    // Hermetic `--dry` closure source (Option B): records which app packages it was asked to
    // resolve, so watch mode never shells out to real turbo in the fixture.
    const dryCalls: string[] = []
    const fakeDryRunner = (packageName: string): Promise<string[]> => {
      dryCalls.push(packageName)

      return Promise.resolve([packageName])
    }

    process.chdir(root)
    // Inject a working proxy (8th ctor arg) so the boot is hermetic and does not depend on a portless
    // daemon running on the host; this test is about the dist-watch restart, not proxy resolution.
    const runner = new DevServerRunner(
      { watch: true },
      fakeRunBuild,
      fakeTurboWatch,
      undefined,
      fakeDryRunner,
      undefined,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      const v1 = (await (await fetch(`http://127.0.0.1:${omegaPort}/api/v1/ping`)).json()) as { version: number }

      expect(v1.version).toBe(1)

      // The turbo engine was started, scoped to the app package (dep-inclusive). No UI apps in this
      // fixture → the dep-closure (UI) filter set is empty, so backend-only watch is byte-identical to before.
      expect(spawnedPackages).toEqual(['omega-api'])
      expect(spawnedUiClosure).toEqual([])

      // Watch mode builds the dependency-closure map from the launched app package(s) via the
      // injected `--dry` source, proving the closure wiring is invoked at start.
      expect(dryCalls).toEqual(['omega-api'])

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

  it('re-probes health after a restart and reports the probe verdict in the summary', async () => {
    // A restart that binds its port but fails its /__health probe must be reported ● down (leading ⚠️),
    // not a bare "✅ Restarted". Inject a probe that always reports down and assert the summary honours it.
    const root = temp.register(makeMonorepo([{ name: 'omega', packageName: 'omega-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const distHandler = path.join(realRoot, 'apps', 'omega', 'api', 'dist', 'handler.js')
    const omegaPort = await getFreePort()

    process.env.OMEGA_PORT = String(omegaPort)
    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(distHandler, handlerSource(1))
    }
    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    process.chdir(root)
    const runner = new DevServerRunner(
      { watch: true },
      fakeRunBuild,
      noopTurboChild,
      undefined,
      (packageName: string): Promise<string[]> => {
        return Promise.resolve([packageName])
      },
      renderer,
      // Probe always reports down — the restart physically succeeds, so this isolates the REPORT.
      (): Promise<ProbeOutcome> => {
        return Promise.resolve('refused')
      },
      workingProxy(),
    )

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      fs.writeFileSync(distHandler, handlerSource(2))

      const deadline = Date.now() + 8000
      let summaryLine: string | undefined

      while (Date.now() < deadline && summaryLine === undefined) {
        summaryLine = logs.find((l) => {
          return l.includes('Restarted omega')
        })
        if (summaryLine !== undefined) break
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(summaryLine).toBeDefined()
      expect(summaryLine).toContain('● down')
      expect(summaryLine).toContain('⚠️')
      expect(summaryLine).not.toContain('✅')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('scopes a shared-package rebuild to only the dependent backend, leaving an unrelated one alone', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'appx', packageName: 'appx-api', withHandler: true },
        { name: 'appy', packageName: 'appy-api', withHandler: true },
      ]),
    )
    const realRoot = fs.realpathSync(root)

    // A shared package that ONLY appx depends on (per the injected closure below).
    const sharedDist = path.join(realRoot, 'packages', 'shared', 'dist')

    fs.mkdirSync(sharedDist, { recursive: true })
    fs.writeFileSync(path.join(realRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }))
    fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 1\n')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    // Boot build re-writes each app's dist handler (as the real turbo build would); no rebuild on change.
    const bootBuild = async (): Promise<void> => {
      for (const app of ['appx', 'appy']) {
        fs.writeFileSync(path.join(realRoot, 'apps', app, 'api', 'dist', 'handler.js'), handlerSource(1))
      }
    }
    // appx depends on `shared`; appy does not — so a `shared` rebuild must restart appx only.
    const dryRunner = (packageName: string): Promise<string[]> => {
      return Promise.resolve(packageName === 'appx-api' ? ['appx-api', 'shared'] : ['appy-api'])
    }

    process.chdir(root)
    // Working proxy injected (8th arg) so the two-app boot is hermetic — no host portless daemon.
    const runner = new DevServerRunner(
      { watch: true },
      bootBuild,
      noopTurboChild,
      undefined,
      dryRunner,
      undefined,
      undefined,
      workingProxy(),
    )

    // Each restart rewrites the app's dev-context fragment with a fresh `writtenAt`, so the fragment
    // timestamp is the restart signal (the build-less restart leaves the handler version unchanged).
    const writtenAt = (app: string): number => {
      const raw = fs.readFileSync(path.join(root, '.infra-kit', 'dev-context', `${app}.json`), 'utf-8')

      return (JSON.parse(raw) as { writtenAt: number }).writtenAt
    }

    await runner.start()

    try {
      const beforeX = writtenAt('appx')
      const beforeY = writtenAt('appy')

      // Let chokidar finish its initial scan, then rebuild the shared package's dist.
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 2\n')

      const deadline = Date.now() + 8000
      let restartedX = false

      while (Date.now() < deadline && !restartedX) {
        if (writtenAt('appx') > beforeX) {
          restartedX = true
          break
        }
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      // The dependent backend re-bound…
      expect(restartedX).toBe(true)
      // …and the unrelated backend, which does not depend on `shared`, was left untouched.
      expect(writtenAt('appy')).toBe(beforeY)
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('collapses a shared-lib edit into ONE restart of the dependent app, not two', async () => {
    /**
     * The regression: `turbo watch build`'s dep-inclusive rebuild cascades a shared-lib edit into TWO
     * chokidar `change` events for the same dependent app — the package's own dist (this branch used to
     * key its debounce by package DIR) and, moments later, the app's own dist (keyed by APP NAME). Two
     * different `watchDebounceTimers` entries meant both timers survived the burst and each called
     * `restart()`, double-restarting the one app that actually changed. Reproduced here by writing BOTH
     * files within the same debounce window, exactly as the real cascade does.
     */
    const root = temp.register(makeMonorepo([{ name: 'appx', packageName: 'appx-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const appxDistHandler = path.join(realRoot, 'apps', 'appx', 'api', 'dist', 'handler.js')
    const sharedDist = path.join(realRoot, 'packages', 'shared', 'dist')

    fs.mkdirSync(sharedDist, { recursive: true })
    fs.writeFileSync(path.join(realRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }))
    fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 1\n')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    const bootBuild = async (): Promise<void> => {
      fs.writeFileSync(appxDistHandler, handlerSource(1))
    }
    // appx depends on `shared`, per the injected closure — the same shape as the scoping test above.
    const dryRunner = (): Promise<string[]> => {
      return Promise.resolve(['appx-api', 'shared'])
    }

    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    process.chdir(root)
    const runner = new DevServerRunner(
      { watch: true },
      bootBuild,
      noopTurboChild,
      undefined,
      dryRunner,
      renderer,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      // Let chokidar finish its initial scan before the burst.
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })

      // The cascade a real shared-lib save produces: the package's own dist AND the dependent app's own
      // dist change within the same debounce window — two distinct chokidar events, one save.
      fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 2\n')
      fs.writeFileSync(appxDistHandler, handlerSource(2))

      const restartLines = (): string[] => {
        return logs.filter((l) => {
          return l.includes('🔄 Restarting')
        })
      }

      const deadline = Date.now() + 8000

      while (Date.now() < deadline && restartLines().length === 0) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(restartLines().length, 'the burst never triggered a restart at all').toBeGreaterThan(0)

      // Give a wrongly-surviving second timer its full debounce window to also fire.
      await new Promise((r) => {
        return setTimeout(r, 700)
      })

      expect(restartLines(), 'the same app restarted twice from one edit burst').toHaveLength(1)
      expect(restartLines()[0]).toContain('appx')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('restarts once for a burst of NEW dist files, which `change` alone never saw at all', async () => {
    /**
     * The watcher subscribed to `change` only, so a module that had just come into existence — a helper
     * added to a shared package, a newly compiled entry — arrived as chokidar `add` and was dropped on
     * the floor. The process went on serving a graph the source no longer had. Five new files in one
     * debounce window prove both halves at once: that `add` is seen (before the fix: zero restarts) and
     * that seeing it cannot storm (five events, one restart).
     */
    const root = temp.register(makeMonorepo([{ name: 'appy', packageName: 'appy-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const appyDist = path.join(realRoot, 'apps', 'appy', 'api', 'dist')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    const bootBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(appyDist, 'handler.js'), handlerSource(1))
    }
    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    process.chdir(root)
    const runner = new DevServerRunner(
      { watch: true },
      bootBuild,
      noopTurboChild,
      undefined,
      undefined,
      renderer,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })

      // Five files that did not exist a moment ago — five `add` events, one save's worth of work.
      for (let i = 0; i < 5; i += 1) {
        fs.writeFileSync(path.join(appyDist, `probe-${i}.js`), `export const probe = ${i}\n`)
      }

      const restartLines = (): string[] => {
        return logs.filter(isRestartLine)
      }

      const deadline = Date.now() + 8000

      while (Date.now() < deadline && restartLines().length === 0) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(restartLines().length, 'an `add` event never reached the restart path').toBeGreaterThan(0)

      // Let any wrongly-surviving sibling timer spend its full debounce window too.
      await new Promise((r) => {
        return setTimeout(r, 700)
      })

      expect(restartLines(), 'five new files in one window produced more than one restart').toHaveLength(1)
      expect(restartLines()[0]).toContain('appy')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('routes an `unlink` in a package dist through the package path without throwing', async () => {
    const root = temp.register(makeMonorepo([{ name: 'appz', packageName: 'appz-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const appzDistHandler = path.join(realRoot, 'apps', 'appz', 'api', 'dist', 'handler.js')
    const sharedDist = path.join(realRoot, 'packages', 'shared', 'dist')
    const doomed = path.join(sharedDist, 'doomed.js')

    fs.mkdirSync(sharedDist, { recursive: true })
    fs.writeFileSync(path.join(realRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }))
    fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 1\n')
    fs.writeFileSync(doomed, 'export const gone = true\n')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    const bootBuild = async (): Promise<void> => {
      fs.writeFileSync(appzDistHandler, handlerSource(1))
    }
    const dryRunner = (): Promise<string[]> => {
      return Promise.resolve(['appz-api', 'shared'])
    }
    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    process.chdir(root)
    const runner = new DevServerRunner(
      { watch: true },
      bootBuild,
      noopTurboChild,
      undefined,
      dryRunner,
      renderer,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })

      // `classifyDistChange` is pure path arithmetic, so a path that has just stopped existing still
      // classifies as the package dist it used to live in — no stat, nothing to throw on.
      fs.rmSync(doomed)

      const restartLines = (): string[] => {
        return logs.filter(isRestartLine)
      }

      const deadline = Date.now() + 8000

      while (Date.now() < deadline && restartLines().length === 0) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(restartLines().length, 'deleting a package dist file never reached the restart path').toBeGreaterThan(0)
      expect(
        logs.filter((l) => {
          return l.includes('Restart error')
        }),
        'the unlink path threw',
      ).toHaveLength(0)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — liveness monitor', () => {
  it('flags a backend unhealthy after two consecutive failed probes, then logs recovery once', async () => {
    const root = temp.register(makeMonorepo([{ name: 'omega', packageName: 'omega-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const distHandler = path.join(realRoot, 'apps', 'omega', 'api', 'dist', 'handler.js')

    process.env.OMEGA_PORT = String(await getFreePort())
    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(distHandler, handlerSource(1))
    }
    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    // Scripted verdicts consumed in call order: boot probe (printReady) = healthy, then two failures
    // (unhealthy edge fires on the SECOND), then a success (recovery edge). Steady healthy afterwards, so
    // no further transitions — proving both edges fire exactly once.
    const verdicts: ProbeOutcome[] = ['ok', 'refused', 'refused', 'ok']
    let i = 0
    const scriptedProbe = (): Promise<ProbeOutcome> => {
      const v = verdicts[i] ?? 'ok'

      if (i < verdicts.length) i += 1

      return Promise.resolve(v)
    }

    process.chdir(root)
    const runner = new DevServerRunner(
      { livenessIntervalMs: 25 },
      fakeRunBuild,
      undefined,
      undefined,
      undefined,
      renderer,
      scriptedProbe,
      workingProxy(),
    )

    await runner.start()

    try {
      const deadline = Date.now() + 8000

      while (Date.now() < deadline) {
        const down = logs.some((l) => {
          return l.includes('omega/api unhealthy')
        })
        const up = logs.some((l) => {
          return l.includes('omega/api recovered')
        })

        if (down && up) break
        await new Promise((r) => {
          return setTimeout(r, 25)
        })
      }

      const downs = logs.filter((l) => {
        return l.includes('omega/api unhealthy')
      })
      const ups = logs.filter((l) => {
        return l.includes('omega/api recovered')
      })

      // Exactly one of each — edge-triggered, not level-triggered (a single failure never logs; a steady
      // state emits nothing).
      expect(downs).toHaveLength(1)
      expect(ups).toHaveLength(1)
    } finally {
      await runner.shutdown()
    }
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
    // No preset → default `*` runs everything the app exposes (api + ui). Working proxy injected (8th arg)
    // so the real boot is hermetic — no host portless daemon.
    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      noopTurboChild,
      fakeUiDev,
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

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

  it('--watch: the turbo engine watches API deps (dep-inclusive) AND the UI dep closure (`^...`)', async () => {
    const root = temp.register(
      makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui' } }]),
    )
    const apiDir = path.join(root, 'apps', 'shop', 'api')

    process.env.SHOP_PORT = String(await getFreePort())

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
    }

    let depInclusive: string[] | null = null
    let depClosure: string[] | null = null
    const fakeTurboWatch = (opts: { depInclusive: string[]; depClosure: string[] }): { kill: () => Promise<void> } => {
      depInclusive = opts.depInclusive
      depClosure = opts.depClosure

      return {
        kill: (): Promise<void> => {
          return Promise.resolve()
        },
      }
    }

    const fakeDryRunner = (pkg: string): Promise<string[]> => {
      return Promise.resolve([pkg])
    }

    process.chdir(root)
    // `noopTurboChild` doubles as the no-op ui-dev factory (this test only asserts the turbo-watch filters).
    // Working proxy injected (8th arg) so the boot is hermetic — no host portless daemon.
    const runner = new DevServerRunner(
      { watch: true },
      fakeRunBuild,
      fakeTurboWatch,
      noopTurboChild,
      fakeDryRunner,
      undefined,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      // API app → dep-inclusive (`...<pkg>`); UI app → dep-closure-only (`<pkg>^...`), so a FE-only lib edit
      // rebuilds via turbo and vite reloads, without production-building the UI itself.
      expect(depInclusive).toEqual(['shop-api'])
      expect(depClosure).toEqual(['shop-ui'])
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

/** A silent {@link DevUi} that captures the single {@link ReadySummary} the runner paints. */
const makeCapturingRenderer = (): {
  renderer: DevUi
  summary: () => ReadySummary
  bootSteps: string[]
  narrations: string[]
} => {
  let captured: ReadySummary | null = null
  const bootSteps: string[] = []
  const narrations: string[] = []
  const noop = (): void => {}
  const renderer: DevUi = {
    narrate: (message) => {
      narrations.push(message)
    },
    log: noop,
    logFn: noop,
    bootStep: (phase) => {
      bootSteps.push(phase)
    },
    ready: (s) => {
      captured = s
    },
    dispose: noop,
  }

  return {
    renderer,
    bootSteps,
    narrations,
    summary: () => {
      if (captured == null) throw new Error('ready() was never called')

      return captured
    },
  }
}

/**
 * Boot an api+ui monorepo with an injected portless driver and capture both what the ready header
 * painted and the env the ui-dev child was handed.
 */
const bootWithUi = async (
  branch: string,
  proxyAvailable: boolean,
  viteConfig = true,
): Promise<{
  runner: DevServerRunner
  summary: () => ReadySummary
  uiEnv: () => Record<string, string> | undefined
  registered: Array<[string, number]>
  bootSteps: string[]
  narrations: string[]
}> => {
  const root = temp.register(
    makeMonorepo([
      { name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui', viteConfig } },
    ]),
  )

  gitInitOnBranch(root, branch)
  const apiDir = path.join(root, 'apps', 'shop', 'api')

  process.env.SHOP_PORT = String(await getFreePort())
  const fakeRunBuild = async (): Promise<void> => {
    fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
  }

  let uiEnv: Record<string, string> | undefined
  const fakeUiDev = (opts: { env?: Record<string, string> }): { kill: () => Promise<void> } => {
    uiEnv = opts.env

    return {
      kill: (): Promise<void> => {
        return Promise.resolve()
      },
    }
  }

  process.chdir(root)
  const { renderer, summary, bootSteps, narrations } = makeCapturingRenderer()
  const { driver, registered } = makeFakeProxy(proxyAvailable)
  const runner = new DevServerRunner(
    {},
    fakeRunBuild,
    noopTurboChild,
    fakeUiDev,
    undefined,
    renderer,
    (): Promise<ProbeOutcome> => {
      return Promise.resolve('ok')
    },
    driver,
  )

  await runner.start()

  return {
    runner,
    summary,
    registered,
    bootSteps,
    narrations,
    uiEnv: () => {
      return uiEnv
    },
  }
}

describe('devServerRunner — the UI gets the same port-free HTTPS URL as a backend', () => {
  it('renders the aliased hero URL as the UI endpoint row', async () => {
    // The UI gets a real endpoint row (not a bare "vite prints its URL below" reference line): its port is
    // pre-assigned and aliased, so the port-free `https://<release>.<package>.localhost` hero URL is
    // knowable before vite ever binds.
    const { runner, summary } = await bootWithUi('feat-x', true)

    try {
      const ui = summary().endpoints.find((e) => {
        return e.tag === 'shop/ui'
      })

      expect(ui?.url).toBe('https://feat-x.shop-ui.localhost')
      // It is an endpoint row, not a reference line.
      expect(summary().uiRefs).toHaveLength(0)
      // Seeded, never probed yet: vite is spawned after the ready frame, so the row opens on `starting`.
      expect(ui?.health).toBe('starting')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('hands the vite child BOTH the assigned port and the alias it actually registered', async () => {
    const { runner, uiEnv } = await bootWithUi('feat-x', true)

    try {
      const map = JSON.parse(uiEnv()?.INFRA_KIT_UI_PORTS ?? '{}') as Record<string, { port: number; alias: string }>

      // `strictPort` on the vite side turns any drift from this assigned port into a loud failure, so the
      // port the runner advertised (and aliased) is exactly the one vite binds.
      expect(map['shop-ui']?.port).toBeGreaterThan(0)

      // The alias must round-trip. It is what the helper turns into `ws: { protocol: 'wss', host: <alias> }`
      // — the page is served over https://<alias>, so an HMR socket derived from vite's own bound port is
      // blocked as mixed content and hot reload dies silently. Publishing only the port (the old shape)
      // left the helper with no alias and it emitted no `ws` at all: HMR was wired to nothing.
      expect(map['shop-ui']?.alias).toBe('feat-x.shop-ui.localhost')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('keeps the honest reference line for a UI whose vite config does not wire infraKitDev()', async () => {
    // Such a UI ignores INFRA_KIT_UI_PORTS and binds its own port, so a pre-assigned URL would be a lie
    // (and an alias pointed at it would 502). It must claim no port at all.
    const { runner, summary, uiEnv } = await bootWithUi('feat-x', true, false)

    try {
      expect(summary().uiRefs).toEqual([{ tag: 'shop/ui' }])
      expect(
        summary().endpoints.some((e) => {
          return e.tag === 'shop/ui'
        }),
      ).toBe(false)
      // No map entry → no assigned port is handed down, so vite falls back to picking (and printing) its
      // own. The child may still receive NODE_EXTRA_CA_CERTS: that is unrelated to port assignment (it is
      // what lets any node client validate portless's private CA), so assert the port env specifically
      // rather than "no env at all".
      expect(uiEnv()?.INFRA_KIT_UI_PORTS).toBeUndefined()
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('registers no alias for an unwired UI even when the proxy IS up', async () => {
    // An alias pointed at a port the UI never binds resolves to a 502, which is worse than no alias.
    const { runner, summary, registered } = await bootWithUi('feat-x', true, false)

    try {
      expect(summary().uiRefs).toEqual([{ tag: 'shop/ui' }])
      // The backend still aliases; only the unwired UI is skipped.
      expect(registered).toContainEqual(['feat-x.shop-api', expect.any(Number)])
      expect(
        registered.some(([name]) => {
          return name.includes('shop-ui')
        }),
      ).toBe(false)
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('never prints a port or an http:// scheme on a UI row', async () => {
    // Pinned as a regression rather than re-asserting the exact string above: a `:<port>` suffix would mean
    // the proxy is not on 443 (which `ensureProxy` refuses to start), and an `http://` UI row would be a
    // plain-HTTP request into a TLS listener — the silent-failure class this migration exists to remove.
    const { runner, summary } = await bootWithUi('feat-x', true)

    try {
      const ui = summary().endpoints.find((e) => {
        return e.tag === 'shop/ui'
      })

      expect(ui?.url).toMatch(/^https:\/\//)
      expect(ui?.url).not.toMatch(/:\d+/)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

/**
 * Only the `infraKit()` vite PLUGIN watches `.infra-kit/dev-context` and restarts vite when the
 * resolved proxy changes; a UI wired with the raw `infraKitDev()` helper bakes its proxy at config
 * load and will not react to a backend recovering mid-session. Discovery treats both as `managedPort`
 * (see the accepted-residual comment in `dev-server.ts`), so this is a boot-time guard against future
 * wiring drift rather than a fix for a live bug — no consumer is wired the risky way today.
 */
describe('devServerRunner — boot warning for a managed UI missing the infraKit() vite plugin', () => {
  /** The substring naming line — distinctive enough to count occurrences by, cheap to change if the wording moves. */
  const WARNING_ANCHOR = 'client/ui is wired with the infra-kit vite helper directly'

  const bootUi = async (vitePlugin?: boolean): Promise<string[]> => {
    const root = temp.register(
      makeMonorepo([
        {
          name: 'client',
          packageName: 'client-api',
          withHandler: true,
          ui: { packageName: 'client-ui', vitePlugin },
        },
      ]),
    )

    process.env.CLIENT_PORT = String(await getFreePort())

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(root, 'apps', 'client', 'api', 'dist', 'handler.js'), handlerSource(1))
    }

    const stdout: string[] = []

    spyStdoutWrite(stdout)
    process.chdir(root)

    const runner = new DevServerRunner(
      {},
      fakeRunBuild,
      noopTurboChild,
      () => {
        return { kill: async () => {} }
      },
      undefined,
      undefined,
      undefined,
      workingProxy(),
    )

    await runner.start()
    await runner.shutdown()

    return stdout
  }

  it('warns exactly once for a managed UI wired with the helper but not the plugin', async () => {
    const stdout = await bootUi()
    const painted = stripAnsi(stdout.join(''))

    expect(painted.split(WARNING_ANCHOR).length - 1).toBe(1)
  })

  it('does not warn for a UI wired with the infraKit() plugin', async () => {
    const stdout = await bootUi(true)
    const painted = stripAnsi(stdout.join(''))

    expect(painted).not.toContain(WARNING_ANCHOR)
  })
})

describe('devServerRunner — boot narration stays terse', () => {
  it('covers the api build and the ui dep warm with ONE boot step naming both packages', async () => {
    const { runner, bootSteps } = await bootWithUi('feat-x', true)

    try {
      // Two boot steps would only make the spinner flip between near-identical lines: the builds run
      // back to back with nothing observable in between.
      const buildSteps = bootSteps.filter((s) => {
        return s.includes('building') || s.includes('warming')
      })

      expect(buildSteps).toHaveLength(1)
      expect(buildSteps[0]).toContain('shop-api')
      expect(buildSteps[0]).toContain('shop-ui')
    } finally {
      await runner.shutdown()
    }
  }, 15000)

  it('never narrates the absolute monorepo root (it painted as the dim subtitle under the spinner)', async () => {
    const { runner, narrations } = await bootWithUi('feat-x', true)

    try {
      expect(
        narrations.some((n) => {
          return n.includes('Monorepo root')
        }),
      ).toBe(false)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('devServerRunner — shutdown ordering (aliases before the child reap)', () => {
  it('deregisters every portless alias BEFORE reaping turbo/ui, so a force-quit cannot strand one', async () => {
    // The reap escalates SIGTERM→SIGKILL per child and can take seconds. Deregistering aliases after it
    // means a second Ctrl-C during that window leaves an alias pointing at a dead backend — the 502 on
    // the next start. `removed` alone cannot catch a regression here: it records WHICH aliases went, not
    // WHEN. One shared `events` sink across all three fakes is what makes the order observable.
    const events: string[] = []
    const root = temp.register(
      makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true, ui: { packageName: 'shop-ui' } }]),
    )

    gitInitOnBranch(root, 'feat-x')

    const apiDir = path.join(root, 'apps', 'shop', 'api')

    process.env.SHOP_PORT = String(await getFreePort())

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
    }
    const killRecorder = (label: string) => {
      return (): { kill: () => Promise<void> } => {
        return {
          kill: (): Promise<void> => {
            events.push(label)

            return Promise.resolve()
          },
        }
      }
    }
    const fakeDryRunner = (pkg: string): Promise<string[]> => {
      return Promise.resolve([pkg])
    }
    const { driver, removed } = makeFakeProxy(true, undefined, events)

    process.chdir(root)

    const runner = new DevServerRunner(
      { watch: true },
      fakeRunBuild,
      killRecorder('turboKill'),
      killRecorder('uiKill'),
      fakeDryRunner,
      undefined,
      undefined,
      driver,
    )

    await runner.start()
    await runner.shutdown()

    // Both children were reaped and at least one alias was deregistered — otherwise the ordering
    // assertion below would pass vacuously on an empty or partial event log.
    expect(events).toContain('turboKill')
    expect(events).toContain('uiKill')
    expect(removed.length).toBeGreaterThan(0)

    expect(events.indexOf('removeAlias')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('removeAlias')).toBeLessThan(events.indexOf('turboKill'))
    expect(events.indexOf('removeAlias')).toBeLessThan(events.indexOf('uiKill'))
  }, 15000)
})

/**
 * The private surface these teardown tests drive directly. Reaching in is deliberate: the only public path
 * to a restart is a chokidar `dist/` event, whose delivery timing is far too loose to race against a
 * teardown on purpose. `IApiAppConfig` is module-local to dev-server.ts, so apps stay opaque here — they are
 * only ever round-tripped out of `appServers` and straight back into `restart`.
 */
interface RunnerTeardownPrivates {
  appServers: Array<{ app: unknown }>
  scheduleDebounced: (key: string, work: () => Promise<void>) => void
  restart: (apps: unknown[]) => Promise<void>
  registeredAliases: Set<string>
  watcher: unknown
  closureMap: unknown
  closureBuild: Promise<void>
}

const noopBuild = async (): Promise<void> => {}

describe('devServerRunner — the watcher never waits on the dependency-closure map', () => {
  it('arms the watcher before the closure map resolves, scoping restarts only once it lands', async () => {
    // Building the map shells out to `turbo --dry` once per app (~1s on a 7-backend repo). Awaiting it
    // before arming chokidar left a full second AFTER "ready" in which a save was watched by nobody and
    // silently dropped. Scoping is an optimisation; it must never be bought with a blind window — the
    // watcher arms on the fail-safe `null` map (restart-all) and the map is swapped in when turbo answers.
    const root = temp.register(makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true }]))

    gitInitOnBranch(root, 'feat-x')
    process.env.SHOP_PORT = String(await getFreePort())
    process.chdir(root)

    // A deliberately slow turbo: if start() awaited the map, it would pay this 500ms.
    const slowDryRunner = (pkg: string): Promise<string[]> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          return resolve([pkg])
        }, 500)
      })
    }

    const runner = new DevServerRunner(
      { watch: true },
      noopBuild,
      noopTurboChild,
      noopTurboChild,
      slowDryRunner,
      undefined,
      undefined,
      workingProxy(),
    )

    await runner.start()

    const priv = runner as unknown as RunnerTeardownPrivates

    // The moment start() returns: watching already, map not yet in hand.
    expect(priv.watcher).not.toBeNull()
    expect(priv.closureMap).toBeNull()

    await priv.closureBuild

    // Once turbo answers, restarts become scoped.
    expect(priv.closureMap).not.toBeNull()

    await runner.shutdown()
  }, 15000)
})

describe('devServerRunner — teardown re-entry (a restart must never resurrect an alias)', () => {
  it('does not re-register an alias when a debounced restart fires during the child reap', async () => {
    // `shutdown()` deregisters aliases and then spends SECONDS reaping children. An armed debounce timer
    // firing inside that window re-enters startOneApp → registerAppAlias, adding an alias back into a set
    // nothing drains again: it survives the process and 502s on the next start. The reap is faked slow
    // (600ms > the 400ms debounce) so the window is real and the race is deterministic, not timing-luck.
    const root = temp.register(makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true }]))

    gitInitOnBranch(root, 'feat-x')

    const apiDir = path.join(root, 'apps', 'shop', 'api')

    process.env.SHOP_PORT = String(await getFreePort())

    const fakeRunBuild = async (): Promise<void> => {
      fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
    }
    const slowKill = (): { kill: () => Promise<void> } => {
      return {
        kill: async (): Promise<void> => {
          await new Promise((r) => {
            return setTimeout(r, 600)
          })
        },
      }
    }
    const fakeDryRunner = (pkg: string): Promise<string[]> => {
      return Promise.resolve([pkg])
    }
    const { driver, registered, removed } = makeFakeProxy(true)

    process.chdir(root)

    const runner = new DevServerRunner(
      { watch: true },
      fakeRunBuild,
      slowKill,
      slowKill,
      fakeDryRunner,
      undefined,
      undefined,
      driver,
    )

    await runner.start()

    const priv = runner as unknown as RunnerTeardownPrivates
    const apps = priv.appServers.map((e) => {
      return e.app
    })

    // Arm a restart exactly as a `dist/` change would, then tear down before it fires.
    priv.scheduleDebounced('shop', () => {
      return priv.restart(apps)
    })

    await runner.shutdown()

    // Give any (incorrectly) surviving timer more than its full debounce to do damage.
    await new Promise((r) => {
      return setTimeout(r, 700)
    })

    // The invariant, stated two ways: nothing is left registered, and every registration was matched
    // by a removal. A resurrected alias breaks both (the set is non-empty; registers outnumber removes).
    expect(priv.registeredAliases.size).toBe(0)
    expect(registered).toHaveLength(removed.length)
  }, 15000)

  it('turns a restart requested after shutdown into a no-op', async () => {
    // The in-flight/queued path needs no timing window at all: `shutdown()` does not await a restart that
    // is already running, so a job that queues behind it would re-alias after the removal.
    const root = temp.register(makeMonorepo([{ name: 'shop', packageName: 'shop-api', withHandler: true }]))

    gitInitOnBranch(root, 'feat-x')
    process.env.SHOP_PORT = String(await getFreePort())
    process.chdir(root)

    const { driver, registered, removed } = makeFakeProxy(true)
    const runner = new DevServerRunner({}, noopBuild, undefined, undefined, undefined, undefined, undefined, driver)

    await runner.start()

    const priv = runner as unknown as RunnerTeardownPrivates
    const apps = priv.appServers.map((e) => {
      return e.app
    })

    await runner.shutdown()
    await priv.restart(apps)

    expect(priv.registeredAliases.size).toBe(0)
    expect(registered).toHaveLength(removed.length)
  }, 15000)
})

describe('devServerRunner — reportFault must never touch a disposed renderer', () => {
  it('renders a fault before shutdown, but only files (never renders) one reported after shutdown began', async () => {
    // `doShutdown` latches `shuttingDown` and disposes the renderer BEFORE its first `await` — a fault
    // reported anywhere from that point on (a rejection out of `watcher.close()`, `turboWatch.kill()`,
    // `uiDev.kill()`, all unguarded) must never call back into the now-disposed panel. Filing it — the
    // OTHER half of `reportFault` — must still happen, so a post-mortem can read it.
    const root = temp.register(makeMonorepo([]))

    process.chdir(root)

    const logCalls: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logCalls.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    const sinkWrites: Array<{ service: string; detail: string }> = []
    const fakeSink = {
      dir: '/fake/log/dir',
      write: (service: string, detail: string) => {
        sinkWrites.push({ service, detail })
      },
      close: noop,
    } as unknown as DevLogSink

    const runner = new DevServerRunner(
      {},
      noopBuild,
      undefined,
      undefined,
      undefined,
      renderer,
      undefined,
      workingProxy(),
      fakeSink,
    )

    // Before shutdown: a fault takes BOTH channels — filed and rendered — exactly as it always has.
    runner.reportFault('early fault, before shutdown')

    expect(sinkWrites).toHaveLength(1)
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]).toContain('early fault, before shutdown')

    // `shutdown()` runs `doShutdown` synchronously up to its first `await`, so by the time this call
    // RETURNS, `shuttingDown` is already latched and the renderer already disposed — a fault reported
    // from here on is "late" without needing to race a real timer.
    const teardown = runner.shutdown()

    expect(() => {
      runner.reportFault('late fault, after shutdown began')
    }).not.toThrow()

    // The late fault was filed for a post-mortem…
    expect(sinkWrites).toHaveLength(2)
    expect(sinkWrites[1]?.detail).toContain('late fault, after shutdown began')
    // …but never reached the renderer. `doShutdown` itself still logs its own "shutting down" / "dev
    // stopped" lines through this same renderer — this asserts the FAULT text specifically never joined
    // them, not that the renderer went silent.
    expect(
      logCalls.some((l) => {
        return l.includes('late fault')
      }),
    ).toBe(false)

    // And shutdown still completes cleanly — the guard must never hang teardown.
    await teardown
  })
})

describe('devServerRunner — watch must not claim a reload it did not perform', () => {
  /**
   * These exercise the NO-HOOK contract, pinned explicitly rather than left to chance.
   *
   * Under vitest every `import()` is rewritten to vite-node's loader, so Node's ESM resolver — the only
   * thing `module.registerHooks` can hook — is never consulted and the generation hook would bust
   * nothing. Left implicit, these tests would pass because the hook is inert in the harness, i.e. they
   * would look like coverage of the reporting logic while actually proving the harness's limitation.
   * Setting the opt-out makes the mode under test a stated fact. The hook itself is proven against a
   * real `node` in `module-generation.test.ts`; no test covers both together in-process, and the manual
   * repro in the plan is what closes that gap.
   */
  beforeEach(() => {
    process.env.INFRA_KIT_DEV_NO_GENERATION = '1'
  })

  const temp = createTempTracker()
  let envSnapshot: NodeJS.ProcessEnv
  let cwdSnapshot: string

  beforeEach(() => {
    envSnapshot = snapshotEnv()
    cwdSnapshot = snapshotCwd()
  })

  afterEach(() => {
    restoreEnv(envSnapshot)
    restoreCwd(cwdSnapshot)
    temp.cleanup()
  })

  /**
   * Build a one-app monorepo with a shared package `appx` depends on, plus a log-capturing renderer.
   * Mirrors the cascade fixture above; returns everything a stale-reporting assertion needs.
   */
  const setup = (): {
    appxDistHandler: string
    logs: string[]
    makeRunner: () => DevServerRunner
    root: string
    sharedIndex: string
  } => {
    const root = temp.register(makeMonorepo([{ name: 'appx', packageName: 'appx-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const appxDistHandler = path.join(realRoot, 'apps', 'appx', 'api', 'dist', 'handler.js')
    const sharedDist = path.join(realRoot, 'packages', 'shared', 'dist')

    fs.mkdirSync(sharedDist, { recursive: true })
    fs.writeFileSync(path.join(realRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }))
    fs.writeFileSync(path.join(sharedDist, 'index.js'), 'export const v = 1\n')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'

    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }

    const makeRunner = (): DevServerRunner => {
      process.chdir(root)

      return new DevServerRunner(
        { watch: true },
        async (): Promise<void> => {
          fs.writeFileSync(appxDistHandler, handlerSource(1))
        },
        noopTurboChild,
        undefined,
        (): Promise<string[]> => {
          return Promise.resolve(['appx-api', 'shared'])
        },
        renderer,
        undefined,
        workingProxy(),
      )
    }

    return { appxDistHandler, logs, makeRunner, root: realRoot, sharedIndex: path.join(sharedDist, 'index.js') }
  }

  /** Poll until a restart summary line (✅ or the stale ⚠️) appears, or the deadline passes. */
  const awaitSummary = async (logs: string[]): Promise<string | undefined> => {
    const find = (): string | undefined => {
      return logs.find((l) => {
        return l.includes('Restarted appx')
      })
    }
    const deadline = Date.now() + 8000

    while (Date.now() < deadline && !find()) {
      await new Promise((r) => {
        return setTimeout(r, 100)
      })
    }

    return find()
  }

  it('reports a shared-package edit as STALE instead of printing a green restart', async () => {
    /**
     * The bug this exists to prevent: a shared-lib edit rebuilds the package, the runner restarts the
     * backend, and prints `✅ Restarted appx` — but the backend is in-process and a restart only
     * re-`import()`s handler ENTRY modules, so Node's registry still holds the OLD shared package. The
     * green line sent people hunting for "where that stale copy is loaded from" instead of restarting.
     */
    const { logs, makeRunner, sharedIndex } = setup()
    const runner = makeRunner()

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      fs.writeFileSync(sharedIndex, 'export const v = 2\n')

      const summary = await awaitSummary(logs)

      expect(summary, 'the package edit never produced a restart summary at all').toBeDefined()
      // The restart DID happen and is reported honestly…
      expect(summary).toContain('still serving the OLD')
      expect(summary).toContain('index.js')
      expect(summary).toContain('Re-run `infra-kit dev`')
      // …and critically, the unearned green is gone.
      expect(summary).not.toContain('✅')
    } finally {
      await runner.shutdown()
    }
  }, 20000)

  it('still prints the green restart for a handler entry edit, which DOES reload', async () => {
    // The honest green must survive: an entry file is the one thing a restart genuinely re-imports.
    // Without this, "fixing" the false green by warning on everything would be its own kind of lie.
    const { appxDistHandler, logs, makeRunner } = setup()
    const runner = makeRunner()

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      fs.writeFileSync(appxDistHandler, handlerSource(2))

      const summary = await awaitSummary(logs)

      expect(summary, 'the entry edit never produced a restart summary at all').toBeDefined()
      expect(summary).toContain('✅')
      expect(summary).not.toContain('still serving the OLD')
    } finally {
      await runner.shutdown()
    }
  }, 20000)

  it('keeps the stale verdict when the package edit cascades into an entry rebuild', async () => {
    /**
     * The subtle case, and the reason the stale set is accumulated on the runner rather than carried in
     * the debounced closure. One shared-lib save produces TWO events on the same debounce key: the
     * package's own dist FIRST, then the dependent app's rebuilt dist. `scheduleDebounced` replaces the
     * closure for a key it sees again, so a closure-carried flag would be overwritten by the second
     * (entry, reloadable) event — and the burst would print green even though the shared lib is stale.
     */
    const { appxDistHandler, logs, makeRunner, sharedIndex } = setup()
    const runner = makeRunner()

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })
      // Exactly the real cascade: package dist first, app dist moments later, inside one debounce window.
      fs.writeFileSync(sharedIndex, 'export const v = 2\n')
      fs.writeFileSync(appxDistHandler, handlerSource(2))

      const summary = await awaitSummary(logs)

      expect(summary, 'the cascade never produced a restart summary at all').toBeDefined()
      expect(summary).toContain('still serving the OLD')
      expect(summary).not.toContain('✅')
    } finally {
      await runner.shutdown()
    }
  }, 20000)
})

describe('devServerRunner — the reload budget stops the session rather than hanging it', () => {
  it('asks the entry to exit, once, with a non-zero code, and claims no restart it did not do', async () => {
    /**
     * Teardown alone is not a stop. `doShutdown` releases every resource and unmounts Ink but contains no
     * `process.exit`, and this path reaches neither the signal handler nor the fatal one — so without an
     * explicit exit request the user is left staring at a live terminal with every server already dead.
     * A criterion that only checked "the engines were killed" cannot tell that apart from a stop, which is
     * why this one watches `onExitRequest` instead.
     *
     * `INFRA_KIT_DEV_STOP_BYTES=1` puts every real sample over budget, and the two-sample hysteresis then
     * makes the FIRST save a normal restart and the SECOND the stop — the driver and the guard agreeing.
     */
    const root = temp.register(makeMonorepo([{ name: 'budget', packageName: 'budget-api', withHandler: true }]))
    const realRoot = fs.realpathSync(root)
    const distHandler = path.join(realRoot, 'apps', 'budget', 'api', 'dist', 'handler.js')

    process.env.DEV_SERVER_CHOKIDAR_POLL = '1'
    process.env.INFRA_KIT_DEV_STOP_BYTES = '1'
    process.env.BUDGET_PORT = String(await getFreePort())

    const bootBuild = async (): Promise<void> => {
      fs.writeFileSync(distHandler, handlerSource(1))
    }
    const logs: string[] = []
    const noop = (): void => {}
    const renderer: DevUi = {
      narrate: noop,
      log: (message) => {
        logs.push(message)
      },
      logFn: noop,
      bootStep: noop,
      ready: noop,
      dispose: noop,
    }
    const exitCodes: number[] = []

    process.chdir(root)
    const runner = new DevServerRunner(
      {
        watch: true,
        onExitRequest: (code) => {
          exitCodes.push(code)
        },
      },
      bootBuild,
      noopTurboChild,
      undefined,
      undefined,
      renderer,
      undefined,
      workingProxy(),
    )

    await runner.start()

    try {
      await new Promise((r) => {
        return setTimeout(r, 1200)
      })

      // Save one: over budget but only one sample deep, so this is a warn and a real restart.
      fs.writeFileSync(distHandler, handlerSource(2))

      const firstDeadline = Date.now() + 8000

      while (Date.now() < firstDeadline && !logs.some(isRestartLine)) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(logs.filter(isRestartLine), 'the first save should still restart normally').toHaveLength(1)

      // Save two: the streak reaches two and the session stops instead of reloading.
      fs.writeFileSync(distHandler, handlerSource(3))

      const stopDeadline = Date.now() + 10000

      while (Date.now() < stopDeadline && exitCodes.length === 0) {
        await new Promise((r) => {
          return setTimeout(r, 100)
        })
      }

      expect(exitCodes, 'the budget stop tore down but never asked to exit — a hang, not a stop').toHaveLength(1)
      expect(exitCodes[0]).not.toBe(0)

      // Nothing green was claimed over a reload that never happened: the abort precedes `bump()`.
      expect(logs.filter(isRestartLine)).toHaveLength(1)
      expect(
        logs.filter((line) => {
          return /Restarted/.test(line)
        }),
        'a Restarted line was printed on the stop path',
      ).toHaveLength(1)

      const stopLine = logs.find((line) => {
        return line.includes('exceeds')
      })

      expect(stopLine, 'no stop line naming the observed size').toBeDefined()
      expect(stopLine).toMatch(/\d MB/)
      expect(stopLine).toContain('INFRA_KIT_DEV_STOP_BYTES')
      expect(stopLine).toContain('infra-kit dev')
    } finally {
      await runner.shutdown()
    }
  }, 30000)
})

describe('devServerRunner — the module-scoped log sink is unhooked only by its OWNER', () => {
  /**
   * `appendRunnerLog` writes through a module-scoped `logSink` that every constructor re-points at
   * itself. Teardown now clears it, which is right — but only while it is still ours. Two runners share
   * a process routinely (this suite builds dozens), and an unconditional null would let the FIRST
   * runner's teardown silently send the SECOND's narration nowhere: the same defect the clear exists to
   * fix, pointed the other way.
   */
  it('keeps a second runner logging after the first one tears down', async () => {
    const dirA = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-sink-a-')))
    const dirB = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-sink-b-')))
    const build = (sink: DevLogSink): DevServerRunner => {
      return new DevServerRunner(
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        workingProxy(),
        sink,
      )
    }

    const first = build(new DevLogSink(dirA))
    // Constructed second, so the module-scoped sink now points HERE.
    const second = build(new DevLogSink(dirB))

    await first.shutdown()
    await second.shutdown()

    // Both teardowns narrate, and both land in B's file — the first runner's line because the global
    // already pointed at B (pre-existing, and not what this test is about), the second runner's because
    // the identity guard refused to unhook a sink that was never the first runner's to clear. Drop the
    // guard and only ONE line survives: the first teardown nulls the global before the second speaks.
    const runnerLog = fs.readFileSync(path.join(dirB, 'runner.log'), 'utf-8')
    const shutdownLines = runnerLog.split('\n').filter((line) => {
      return line.includes('Shutting down')
    })

    expect(shutdownLines, 'the first teardown unhooked the second runner’s logging').toHaveLength(2)
  })
})
