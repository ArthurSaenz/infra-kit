import { describe, expect, it } from 'vitest'

import { findDegradedRoutes, formatPairingRefusal, resolveProxyRoutes } from 'src/dev/local-pairing'
import type { LaunchedUi, PairingInputs } from 'src/dev/local-pairing'

/** hulyo's real shape: `/api` can be local, `/dynamic` + `/media` are cloud-only by design. */
const clientUi = (): LaunchedUi => {
  return {
    app: 'client',
    routes: {
      '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
      '/dynamic': { packageName: 'backend-api', from: ['cloud'] },
      '/media': { packageName: 'backend-api', from: ['cloud'] },
    },
    cloudTemplate: 'https://<env>.hulyo.co.il',
  }
}

const CRASH = "config is missing field: 'connectionURL'"

/** The preset launched `client/api`, it crashed, and `client/ui` is up. */
const crashed = (overrides: Partial<PairingInputs> = {}): PairingInputs => {
  return {
    uis: [clientUi()],
    wanted: new Set(['backend-api']),
    running: new Set(),
    reasons: new Map([['backend-api', { app: 'client', reason: CRASH }]]),
    env: 'dev',
    ...overrides,
  }
}

describe('findDegradedRoutes', () => {
  it('flags a local-capable route whose backend this run meant to serve and did not', () => {
    expect(findDegradedRoutes(crashed())).toEqual([
      {
        uiApp: 'client',
        route: '/api',
        packageName: 'backend-api',
        fallback: 'cloud',
        apiApp: 'client',
        reason: CRASH,
        cloudTarget: 'https://dev.hulyo.co.il',
      },
    ])
  })

  it('never flags a cloud-only route — it was always going to cloud, by design', () => {
    const routes = findDegradedRoutes(crashed()).map((d) => {
      return d.route
    })

    // `/dynamic` and `/media` name the SAME dead package as `/api`; only `/api` lists `local`.
    expect(routes).toEqual(['/api'])
  })

  it('flags nothing when the backend is up', () => {
    expect(findDegradedRoutes(crashed({ running: new Set(['backend-api']), reasons: new Map() }))).toEqual([])
  })

  it('flags nothing when the frontend was never meant to be local (developing against cloud on purpose)', () => {
    // Not in `wanted`, not pinned: a UI-only run against cloud is a supported workflow, not a fault.
    expect(findDegradedRoutes(crashed({ wanted: new Set(), reasons: new Map() }))).toEqual([])
  })

  /**
   * The `--app` / `--self` hole. Narrowing drops the backend from the launch set AFTER preset resolution,
   * so it is never attempted and never lands in `reasons` — a crash-keyed rule sees nothing at all while
   * the frontend quietly proxies to cloud. `wanted` is captured PRE-narrowing precisely to catch this.
   */
  it('flags a backend the preset promised but a narrowing flag dropped — it never crashed, it never ran', () => {
    const [degraded] = findDegradedRoutes(crashed({ reasons: new Map() }))

    expect(degraded?.packageName).toBe('backend-api')
    expect(degraded?.apiApp).toBeUndefined()
    expect(degraded?.reason).toContain('never launched')
  })

  /** A preset can pin a route `local` while launching no backend for it at all. */
  it('flags a route the preset pinned local even when no api target names its package', () => {
    const ui = clientUi()

    ui.routes['/api']!.pinnedLocal = true

    const [degraded] = findDegradedRoutes(crashed({ uis: [ui], wanted: new Set(), reasons: new Map() }))

    expect(degraded?.route).toBe('/api')
    expect(degraded?.reason).toContain('never launched')
  })

  /**
   * The resolver's real fallback is `route.default ?? route.from[0]`, so a single-source `from: ['local']`
   * route with no `default` falls back to **local** — at an alias nothing registered. That 502s loudly; it
   * does NOT go to cloud, and a message saying "cloud" would name a destination the traffic never reaches.
   */
  it('reports a local fallback as local, not cloud, for a single-source route with no default', () => {
    const ui: LaunchedUi = {
      app: 'client',
      routes: { '/api': { packageName: 'backend-api', from: ['local'] } },
      cloudTemplate: 'https://<env>.hulyo.co.il',
    }
    const [degraded] = findDegradedRoutes(crashed({ uis: [ui] }))

    expect(degraded?.fallback).toBe('local')
    // No cloud origin is named, because the traffic is not going to one.
    expect(degraded?.cloudTarget).toBeUndefined()
  })

  it('honours an explicit default: local on a multi-source route', () => {
    const ui: LaunchedUi = {
      app: 'client',
      routes: { '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'local' } },
      cloudTemplate: 'https://<env>.hulyo.co.il',
    }

    expect(findDegradedRoutes(crashed({ uis: [ui] }))[0]?.fallback).toBe('local')
  })

  it('names no cloud origin at all rather than a bogus one when no env is sourced', () => {
    // Caught on a real run: with `INFRA_KIT_ENV` unset, `https://<env>.hulyo.co.il` interpolated to
    // `https://.hulyo.co.il` — a host that resolves nowhere, printed by the very message whose job is to
    // tell the user where their traffic was about to go.
    expect(findDegradedRoutes(crashed({ env: undefined }))[0]?.cloudTarget).toBeUndefined()
  })
})

describe('formatPairingRefusal', () => {
  it('names the route, the cloud origin it would have used, and the backend error', () => {
    const message = formatPairingRefusal(findDegradedRoutes(crashed()), 'clientLocal')

    expect(message).toContain('clientLocal')
    expect(message).toContain('client/ui /api')
    // The whole point of the refusal: name the origin the user would otherwise have silently talked to.
    expect(message).toContain('https://dev.hulyo.co.il')
    expect(message).toContain(CRASH)
    // A CRASHED backend is genuinely retryable — it is a restart target, so this advice can be followed.
    expect(message).toContain('--watch')
  })

  /**
   * `runRestart` only ever sees the post-`--app`/`--self` app list, so a backend a narrowing flag dropped
   * is not a restart target and never becomes one. Advertising `--watch` there would send the user off to
   * wait on a restart that cannot happen — advice that is worse than none.
   */
  it('never advertises --watch for a backend the run never launched — no save can retry it', () => {
    const message = formatPairingRefusal(findDegradedRoutes(crashed({ reasons: new Map() })), 'crossApp')

    expect(message).toContain('never launched')
    expect(message).toContain('--app/--self')
    expect(message).not.toContain('--watch')
  })

  it('describes a local fallback as a dead alias, never as a cloud proxy', () => {
    const ui: LaunchedUi = { app: 'client', routes: { '/api': { packageName: 'backend-api', from: ['local'] } } }
    const message = formatPairingRefusal(findDegradedRoutes(crashed({ uis: [ui] })), 'clientLocal')

    expect(message).toContain('nothing is serving')
    expect(message).not.toContain('to the cloud backend')
  })

  it('falls back to naming no origin when the cloud template is unknown', () => {
    const ui: LaunchedUi = {
      app: 'client',
      routes: { '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' } },
    }
    const message = formatPairingRefusal(findDegradedRoutes(crashed({ uis: [ui] })), 'clientLocal')

    expect(message).toContain('to the cloud backend')
  })
})

describe('resolveProxyRoutes', () => {
  const localOrigin = (pkg: string): string | undefined => {
    return pkg === 'backend-api' ? 'https://feat-x.backend-api.localhost/api/v1' : undefined
  }

  it('reports EVERY route sorted by path — a local one with its origin, cloud-only ones with the cloud target', () => {
    expect(
      resolveProxyRoutes({
        uis: [clientUi()],
        running: new Set(['backend-api']),
        localOrigin,
        env: 'dev',
      }),
    ).toEqual([
      {
        uiApp: 'client',
        route: '/api',
        packageName: 'backend-api',
        source: 'local',
        target: 'https://feat-x.backend-api.localhost/api/v1',
      },
      {
        uiApp: 'client',
        route: '/dynamic',
        packageName: 'backend-api',
        source: 'cloud',
        target: 'https://dev.hulyo.co.il',
      },
      {
        uiApp: 'client',
        route: '/media',
        packageName: 'backend-api',
        source: 'cloud',
        target: 'https://dev.hulyo.co.il',
      },
    ])
  })

  it('resolves a local-capable route to cloud when its backend is not in the running set (the vite pickSource fallback)', () => {
    const [api] = resolveProxyRoutes({
      uis: [clientUi()],
      running: new Set(),
      localOrigin,
      env: 'dev',
    })

    expect(api).toMatchObject({ route: '/api', source: 'cloud', target: 'https://dev.hulyo.co.il' })
  })

  it('resolves a single-source local route to local with no default, and omits the target when nothing is serving it', () => {
    const ui: LaunchedUi = { app: 'client', routes: { '/api': { packageName: 'backend-api', from: ['local'] } } }

    expect(
      resolveProxyRoutes({
        uis: [ui],
        running: new Set(),
        localOrigin: () => {
          return undefined
        },
      }),
    ).toEqual([{ uiApp: 'client', route: '/api', packageName: 'backend-api', source: 'local', target: undefined }])
  })

  it('keeps two routes that share ONE running backend both local, each pointing at that backend origin', () => {
    const ui: LaunchedUi = {
      app: 'client',
      routes: {
        '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
        '/auth': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
      },
      cloudTemplate: 'https://<env>.hulyo.co.il',
    }

    const rows = resolveProxyRoutes({ uis: [ui], running: new Set(['backend-api']), localOrigin, env: 'dev' })

    expect(
      rows.every((r) => {
        return r.source === 'local'
      }),
    ).toBe(true)
    expect(
      rows.map((r) => {
        return r.target
      }),
    ).toEqual(['https://feat-x.backend-api.localhost/api/v1', 'https://feat-x.backend-api.localhost/api/v1'])
  })

  it('omits a cloud target when the template needs an <env> and none is sourced', () => {
    const [media] = resolveProxyRoutes({
      uis: [
        {
          app: 'client',
          routes: { '/media': { packageName: 'backend-api', from: ['cloud'] } },
          cloudTemplate: 'https://<env>.hulyo.co.il',
        },
      ],
      running: new Set(),
      localOrigin,
    })

    expect(media).toMatchObject({ route: '/media', source: 'cloud', target: undefined })
  })
})
