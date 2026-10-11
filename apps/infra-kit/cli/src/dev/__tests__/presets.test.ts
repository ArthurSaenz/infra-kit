import { describe, expect, it } from 'vitest'

import { deriveTargetLabel, parseTargetKey, resolvePreset, validatePresetProxy } from 'src/dev/presets'
import type { DiscoveredParts, PresetProxyContext } from 'src/dev/presets'

/**
 * Pure run-plan resolution: every spec passes an explicit `DiscoveredParts` view so
 * glob expansion, target de-duplication, derived local set, proxy overrides, and
 * unmatched detection are exercised without any filesystem.
 */

const discovered: DiscoveredParts = {
  api: ['client', 'backoffice', 'multivendor'],
  ui: ['client', 'backoffice', 'multivendor', 'seo'],
}

/** Sort targets into a stable `app/part` string list for order-independent assertions. */
const ids = (targets: Array<{ app: string; part: string }>): string[] => {
  return targets
    .map((t) => {
      return `${t.app}/${t.part}`
    })
    .sort()
}

describe('deriveTargetLabel', () => {
  const allKeys = ['client/api', 'client/ui', 'seo/ui']

  it('names the launched packages when the run is a subset', () => {
    expect(deriveTargetLabel({ running: ['client/ui', 'client/api'], discovered: allKeys })).toBe(
      'client/api + client/ui',
    )
  })

  it('labels a part-level selection by part, never by bare app name', () => {
    expect(deriveTargetLabel({ running: ['client/ui'], discovered: allKeys })).toBe('client/ui')
  })

  it('collapses to * only when every discovered package runs', () => {
    expect(deriveTargetLabel({ running: allKeys, discovered: allKeys })).toBe('*')
  })

  it('never claims * for an empty run', () => {
    expect(deriveTargetLabel({ running: [], discovered: [] })).toBe('nothing')
  })
})

describe('parseTargetKey', () => {
  it('parses an <app>/<part> package identity', () => {
    expect(parseTargetKey('client/api')).toEqual({ appGlob: 'client', part: 'api' })
    expect(parseTargetKey('*/ui')).toEqual({ appGlob: '*', part: 'ui' })
  })

  it('throws on a bare app — a folder, not a package', () => {
    expect(() => {
      return parseTargetKey('multivendor')
    }).toThrow(/invalid target "multivendor" \(expected "<app>\/api" or "<app>\/ui"\)/)
  })

  it('throws on a bare `*` glob (no part)', () => {
    expect(() => {
      return parseTargetKey('*')
    }).toThrow(/invalid target/)
  })

  it('throws on an unknown part', () => {
    expect(() => {
      return parseTargetKey('client/server')
    }).toThrow(/invalid target part/)
  })

  it('throws on a too-deep key', () => {
    expect(() => {
      return parseTargetKey('a/b/c')
    }).toThrow(/invalid target/)
  })
})

describe('resolvePreset — target expansion', () => {
  it('omitting apps launches every discovered part', () => {
    const result = resolvePreset({}, discovered)

    expect(ids(result.targets)).toEqual([
      'backoffice/api',
      'backoffice/ui',
      'client/api',
      'client/ui',
      'multivendor/api',
      'multivendor/ui',
      'seo/ui',
    ])
  })

  it('throws on a bare app key rather than silently launching both halves', () => {
    expect(() => {
      return resolvePreset({ apps: { seo: {} } }, discovered)
    }).toThrow(/invalid target "seo"/)
  })

  it('a named package selects that part alone', () => {
    const result = resolvePreset({ apps: { 'client/ui': {} } }, discovered)

    expect(ids(result.targets)).toEqual(['client/ui'])
  })

  it('a */api glob launches every backend', () => {
    const result = resolvePreset({ apps: { '*/api': {} } }, discovered)

    expect(ids(result.targets)).toEqual(['backoffice/api', 'client/api', 'multivendor/api'])
  })

  it('de-duplicates overlapping keys', () => {
    const result = resolvePreset({ apps: { '*/api': {}, 'client/api': {} } }, discovered)

    expect(ids(result.targets)).toEqual(['backoffice/api', 'client/api', 'multivendor/api'])
  })
})

describe('resolvePreset — derived local set', () => {
  it('derives localApps from launched api targets', () => {
    const result = resolvePreset({ apps: { 'client/api': {}, 'backoffice/ui': {} } }, discovered)

    expect(result.localApps).toEqual(['client'])
  })

  it('a ui-only plan has an empty local set', () => {
    const result = resolvePreset({ apps: { 'client/ui': {} } }, discovered)

    expect(result.localApps).toEqual([])
  })
})

describe('resolvePreset — proxy overrides', () => {
  it('captures per-app route overrides', () => {
    const result = resolvePreset({ apps: { 'client/ui': { proxy: { '/api': 'local' } } } }, discovered)

    expect(result.proxy).toEqual({ client: { '/api': 'local' } })
  })
})

describe('resolvePreset — unmatched', () => {
  it('flags an explicit non-glob target whose part is missing', () => {
    // seo has no api part.
    const result = resolvePreset({ apps: { 'seo/api': {} } }, discovered)

    expect(result.targets).toEqual([])
    expect(result.unmatched).toEqual(['seo/api'])
  })

  it('does not flag glob misses', () => {
    const result = resolvePreset({ apps: { '*/api': {} } }, discovered)

    expect(result.unmatched).toEqual([])
  })
})

/**
 * Proxy-locality validation: a `route → 'local'` override is only valid when the
 * backend pkg it resolves to (per the frontend config) is launched by the same plan.
 */

// client & seo frontends both proxy `/api` to the `backend-api` pkg (which apps/client/api provides).
const proxyCtx: PresetProxyContext = {
  discovered,
  apiPkgByApp: { client: 'backend-api', backoffice: 'backoffice-api', multivendor: 'multivendor-api' },
  routePkg: (app, route) => {
    const routes: Record<string, Record<string, string>> = {
      client: { '/api': 'backend-api', '/media': 'backend-api' },
      seo: { '/api': 'backend-api' },
      backoffice: { '/api/v1': 'backoffice-api' },
    }

    return routes[app]?.[route]
  },
}

describe('validatePresetProxy', () => {
  it('flags a local override whose backend is not launched (the client-remote case)', () => {
    const plan = { apps: { 'client/ui': { proxy: { '/api': 'local' as const } } } }
    const issues = validatePresetProxy(plan, proxyCtx)

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      app: 'client',
      route: '/api',
      pkg: 'backend-api',
      kind: 'backend-not-launched',
    })
    // Remediation hint points at the app whose api package serves the route.
    expect(issues[0]?.message).toContain('client/api')
  })

  it('accepts a local override when the plan launches that backend', () => {
    const plan = { apps: { 'client/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } }

    expect(validatePresetProxy(plan, proxyCtx)).toEqual([])
  })

  it('accepts a local override for a shared backend launched via another app', () => {
    // seo has no api; its /api → backend-api, which apps/client/api provides. Launching client/api satisfies it.
    const plan = { apps: { 'seo/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } }

    expect(validatePresetProxy(plan, proxyCtx)).toEqual([])
  })

  it('ignores cloud overrides — always satisfiable', () => {
    const plan = { apps: { 'client/ui': { proxy: { '/api': 'cloud' as const } } } }

    expect(validatePresetProxy(plan, proxyCtx)).toEqual([])
  })

  it('does not flag derived-local (no override) plans', () => {
    const plan = { apps: { 'client/ui': {}, 'client/api': {} } }

    expect(validatePresetProxy(plan, proxyCtx)).toEqual([])
  })

  it('flags an override naming a route absent from the frontend config', () => {
    const plan = { apps: { 'client/ui': { proxy: { '/nope': 'local' as const } } } }
    const issues = validatePresetProxy(plan, proxyCtx)

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'unknown-route', route: '/nope' })
  })

  it('falls back to a package-name hint when no app owns the backend', () => {
    // Route resolves to a real pkg that no apps/*/api provides → ownerApp is undefined.
    const ctx: PresetProxyContext = {
      discovered,
      apiPkgByApp: { client: 'backend-api' },
      routePkg: () => {
        return 'orphan-api'
      },
    }
    const plan = { apps: { 'client/ui': { proxy: { '/api': 'local' as const } } } }
    const issues = validatePresetProxy(plan, ctx)

    expect(issues[0]).toMatchObject({ kind: 'backend-not-launched', pkg: 'orphan-api' })
    expect(issues[0]?.message).toContain('launch the api whose package is "orphan-api"')
  })
})
