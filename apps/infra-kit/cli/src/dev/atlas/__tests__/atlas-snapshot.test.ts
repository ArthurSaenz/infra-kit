import { describeProxyRoutes, readCloudOrigin, readLocalContext } from '@slip-stream-kit/config/internal'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deriveReason, deriveServed, hostOnly, parseServedRoutes, vscodeHref } from 'src/dev/atlas/atlas-snapshot'
import type { AtlasRunFacts } from 'src/dev/atlas/atlas-snapshot'
import { AtlasRuntime } from 'src/dev/atlas/atlas-state'
import { logFileName } from 'src/dev/log-sink'
import type { HealthState } from 'src/dev/render'

import { CLOUD_ENV, PLANNED, ROUTES, makeAtlasRepo, makeFacts, originOf } from './atlas-fixture'
import type { AtlasRepo } from './atlas-fixture'

let repo: AtlasRepo
let savedCloud: string | undefined

beforeEach(async () => {
  savedCloud = process.env[CLOUD_ENV]
  process.env[CLOUD_ENV] = 'https://dev.example.com'
  repo = await makeAtlasRepo()
  repo.writeFragment('mine-api')
  repo.writeFragment('live-api')
})

afterEach(() => {
  if (savedCloud === undefined) delete process.env[CLOUD_ENV]
  else process.env[CLOUD_ENV] = savedCloud
  repo.cleanup()
})

const runtimeFor = (health?: Map<string, HealthState>): AtlasRuntime => {
  const runtime = new AtlasRuntime({
    planned: PLANNED,
    facts: () => {
      return makeFacts(repo.logDir, health)
    },
  })

  runtime.setUis([repo.ui])

  return runtime
}

const snapshotOf = (runtime: AtlasRuntime, siteId: string | null = null, served = null) => {
  return runtime.snapshot({ siteId, served })
}

const siteRoutes = (runtime: AtlasRuntime) => {
  return snapshotOf(runtime).sites[0]!.routes
}

describe('atlas snapshot — the routes', () => {
  it('equals describeProxyRoutes over the same fragments, field by field', () => {
    const expected = describeProxyRoutes({
      proxy: repo.ui.proxy!,
      localContext: readLocalContext(repo.ui.path),
      env: undefined,
      cloud: readCloudOrigin(CLOUD_ENV),
      getRelease: () => {
        return 'main'
      },
    })

    const routes = siteRoutes(runtimeFor())

    expect(
      routes.map(({ path: p, packageName, source }) => {
        return { path: p, packageName, source }
      }),
    ).toEqual(
      expected.map(({ path: p, packageName, source }) => {
        return { path: p, packageName, source }
      }),
    )
    expect(routes).toHaveLength(Object.keys(ROUTES).length)
  })

  it('derives every reason in the table', () => {
    const reasons = Object.fromEntries(
      siteRoutes(runtimeFor()).map((route) => {
        return [route.path, route.reason]
      }),
    )

    expect(reasons).toEqual({
      '/api/mine': 'local',
      '/api/live': 'local',
      '/api/boot': 'starting',
      '/api/failed': 'launched-failed',
      '/api/cloud': 'cloud-only',
      '/api/off': 'not-running',
      '/api/lonely': 'local-unserved',
    })
  })

  it('reads cloud-unset when the deployed URL is not loaded', () => {
    delete process.env[CLOUD_ENV]

    const off = siteRoutes(runtimeFor()).find((route) => {
      return route.path === '/api/off'
    })

    expect(off).toMatchObject({ source: 'cloud', target: null, reason: 'cloud-unset' })
  })

  it('points local routes at listed backends and cloud routes at the cloud host', () => {
    const snapshot = snapshotOf(runtimeFor())

    const byPath = new Map(
      snapshot.sites[0]!.routes.map((route) => {
        return [route.path, route]
      }),
    )

    expect(byPath.get('/api/live')?.target).toEqual({ kind: 'backend', id: 'live-api' })
    expect(byPath.get('/api/cloud')?.target).toEqual({ kind: 'cloud', id: 'dev.example.com' })
    // Nothing serves it, so there is no backend node to point at.
    expect(byPath.get('/api/lonely')?.target).toBeNull()
    expect(snapshot.clouds).toEqual([{ id: 'dev.example.com', host: 'dev.example.com' }])
  })

  it('reads the env after the UI dev.env, as its vite does', async () => {
    const withEnv = { ...repo.ui, devEnv: { set: { [CLOUD_ENV]: 'https://staging.example.com' } } }
    const runtime = runtimeFor()

    runtime.setUis([withEnv])
    runtime.captureSpawnEnv({ ...process.env })
    // A later change to this process's env must not skew what the UI was started with.
    process.env[CLOUD_ENV] = 'https://elsewhere.example.com'

    expect(snapshotOf(runtime).clouds).toEqual([{ id: 'staging.example.com', host: 'staging.example.com' }])
  })
})

describe('atlas snapshot — health, owner, logs', () => {
  it('reports health exactly as the injected healthOf does', () => {
    const health = new Map<string, HealthState>([
      ['shop/ui', 'starting'],
      ['mine/api', 'ok'],
      ['failed/api', 'down'],
    ])

    const snapshot = snapshotOf(runtimeFor(health))

    const byId = new Map(
      snapshot.backends.map((b) => {
        return [b.id, b.health]
      }),
    )

    expect(snapshot.sites[0]!.health).toBe('starting')
    expect(byId.get('mine-api')).toBe('ok')
    expect(byId.get('failed-api')).toBe('down')
    expect(byId.get('boot-api')).toBe('unknown')
  })

  it('marks backends this run launched as this-run and the rest as other-runner', () => {
    const owners = Object.fromEntries(
      snapshotOf(runtimeFor()).backends.map((b) => {
        return [b.id, { owner: b.owner, app: b.app, host: b.host, hasLog: b.log !== null }]
      }),
    )

    expect(owners).toEqual({
      'boot-api': { owner: 'this-run', app: 'boot', host: null, hasLog: true },
      'failed-api': { owner: 'this-run', app: 'failed', host: null, hasLog: true },
      'live-api': { owner: 'other-runner', app: null, host: new URL(originOf('live-api')).hostname, hasLog: false },
      'mine-api': { owner: 'this-run', app: 'mine', host: 'main.mine-api.repo.localhost', hasLog: true },
    })
  })

  it('links every log through vscode://file, and says which exist', () => {
    fs.writeFileSync(path.join(repo.logDir, 'runner.log'), 'x\n')

    const snapshot = snapshotOf(runtimeFor())

    const failed = snapshot.backends.find((b) => {
      return b.id === 'failed-api'
    })

    expect(snapshot.run).toEqual({ pid: process.pid, logDir: repo.logDir, logDirHref: vscodeHref(repo.logDir) })
    expect(snapshot.sites[0]!.log).toEqual({
      service: 'shop/ui',
      path: path.join(repo.logDir, logFileName('shop/ui')),
      href: `vscode://file${encodeURI(path.join(repo.logDir, logFileName('shop/ui')))}`,
      exists: false,
    })
    expect(failed?.log?.path).toBe(path.join(repo.logDir, logFileName('failed/api')))
    expect(
      snapshot.logs.map(({ service, exists }) => {
        return { service, exists }
      }),
    ).toEqual([
      { service: 'runner', exists: true },
      { service: 'turbo', exists: false },
      { service: 'watch', exists: false },
    ])
  })
})

describe('atlas snapshot — served', () => {
  const header = (routes: Record<string, { host: string | null; user: boolean }>) => {
    return parseServedRoutes(encodeURIComponent(JSON.stringify(routes)))
  }

  it('reads match, differs and user-proxy for the viewer site', () => {
    const runtime = runtimeFor()

    const served = runtime.snapshot({
      siteId: 'shop-ui',
      served: header({
        '/api/live': { host: new URL(originOf('live-api')).hostname, user: false },
        '/api/cloud': { host: 'stale.example.com', user: false },
        '/api/mine': { host: 'anything.example.com', user: true },
      }),
    })

    const byPath = Object.fromEntries(
      served.sites[0]!.routes.map((route) => {
        return [route.path, route.served]
      }),
    )

    expect(served.viewer.siteId).toBe('shop-ui')
    expect(byPath['/api/live']).toBe('match')
    expect(byPath['/api/cloud']).toBe('differs')
    expect(byPath['/api/mine']).toBe('user-proxy')
    // Not in the header: that vite did not say.
    expect(byPath['/api/off']).toBe('unknown')
  })

  it('reads unknown without a header, and on every site but the viewer', () => {
    const runtime = runtimeFor()
    const routesHeader = header({ '/api/live': { host: new URL(originOf('live-api')).hostname, user: false } })

    const noHeader = runtime.snapshot({ siteId: 'shop-ui', served: null })
    const otherSite = runtime.snapshot({ siteId: 'another-ui', served: routesHeader })

    for (const snapshot of [noHeader, otherSite]) {
      expect(
        snapshot.sites[0]!.routes.every((route) => {
          return route.served === 'unknown'
        }),
      ).toBe(true)
    }
    // A site this run does not have is not echoed back.
    expect(otherSite.viewer.siteId).toBeNull()
  })

  it('keeps `__proto__` and `constructor` keys as plain entries, never touching a prototype', () => {
    // Raw JSON: `JSON.stringify` of an object literal would drop a `__proto__` key before it got here.
    const raw = encodeURIComponent(
      '{"__proto__":{"host":"dev.example.com","user":false},"constructor":{"host":null,"user":true}}',
    )

    const parsed = parseServedRoutes(raw)

    expect(parsed).toBeInstanceOf(Map)
    expect(Object.getPrototypeOf(parsed)).toBe(Map.prototype)
    expect(parsed?.get('__proto__')).toEqual({ host: 'dev.example.com', user: false })
    expect(parsed?.get('constructor')).toEqual({ host: null, user: true })
    expect(({} as Record<string, unknown>).host).toBeUndefined()

    const served = deriveServed(
      [
        { path: '__proto__', target: 'https://dev.example.com' },
        { path: 'constructor', target: null },
        { path: 'toString', target: null },
      ],
      parsed,
    )

    expect(served).toEqual(['match', 'user-proxy', 'unknown'])
  })

  it('rejects a malformed header as a whole', () => {
    expect(parseServedRoutes('%E0%A4%A')).toBeNull()
    expect(parseServedRoutes(encodeURIComponent('[1]'))).toBeNull()
    expect(parseServedRoutes(encodeURIComponent('{"/api":{"host":1,"user":false}}'))).toBeNull()
  })
})

describe('atlas snapshot — pure helpers', () => {
  it('hostOnly drops userinfo, port, path and query, and nulls the unparseable', () => {
    expect(hostOnly('https://u:p@dev.example.com:8443/x?token=abc')).toBe('dev.example.com')
    expect(hostOnly('not a url')).toBeNull()
    expect(hostOnly(null)).toBeNull()
  })

  it('vscodeHref encodes the path', () => {
    expect(vscodeHref('/home/a b/c.log')).toBe('vscode://file/home/a%20b/c.log')
  })

  it('deriveReason takes the first matching rule', () => {
    const spec = { packageName: 'p', from: ['local', 'cloud'] as Array<'local' | 'cloud'>, default: 'cloud' as const }
    const d = { path: '/api', packageName: 'p', source: 'local' as const, target: 'https://p.localhost' }

    const facts = (over: Partial<AtlasRunFacts>): AtlasRunFacts => {
      return { running: new Set(), failed: new Set(), booting: new Set(), ...over }
    }

    // Failed wins over booting and over a live fragment.
    expect(deriveReason(d, spec, facts({ failed: new Set(['p']), booting: new Set(['p']) }), new Set(['p']))).toBe(
      'launched-failed',
    )
    // Booting and already running is not starting.
    expect(deriveReason(d, spec, facts({ booting: new Set(['p']), running: new Set(['p']) }), new Set(['p']))).toBe(
      'local',
    )
    expect(deriveReason(d, { ...spec, from: ['cloud'] }, facts({ failed: new Set(['p']) }), new Set())).toBe(
      'cloud-only',
    )
  })

  it('deriveServed compares hostnames only', () => {
    expect(
      deriveServed(
        [{ path: '/api', target: 'https://dev.example.com/v1?x=1' }],
        new Map([['/api', { host: 'dev.example.com', user: false }]]),
      ),
    ).toEqual(['match'])
  })
})
