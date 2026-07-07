import { describe, expect, it } from 'vitest'

import { parseTargetKey, resolvePreset, validatePresetProxy } from 'src/dev/presets'
import type { DiscoveredParts, PresetProxyContext } from 'src/dev/presets'

/**
 * Pure preset resolution: every spec passes an explicit `DiscoveredParts` view so
 * glob/bare-key expansion, target de-duplication, derived local set, proxy
 * overrides, and unmatched detection are exercised without any filesystem.
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

describe('parseTargetKey', () => {
  it('treats a bare app as both parts, non-explicit', () => {
    expect(parseTargetKey('client')).toEqual({ appGlob: 'client', parts: ['api', 'ui'], explicit: false })
  })

  it('selects a single explicit part', () => {
    expect(parseTargetKey('client/api')).toEqual({ appGlob: 'client', parts: ['api'], explicit: true })
    expect(parseTargetKey('*/ui')).toEqual({ appGlob: '*', parts: ['ui'], explicit: true })
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

  it('a bare app key launches only the halves that exist', () => {
    // seo has ui but no api → the api half is silently skipped, not unmatched.
    const result = resolvePreset({ apps: { seo: {} } }, discovered)

    expect(ids(result.targets)).toEqual(['seo/ui'])
    expect(result.unmatched).toEqual([])
  })

  it('an explicit part is selected alone', () => {
    const result = resolvePreset({ apps: { 'client/ui': {} } }, discovered)

    expect(ids(result.targets)).toEqual(['client/ui'])
  })

  it('a */api glob launches every backend', () => {
    const result = resolvePreset({ apps: { '*/api': {} } }, discovered)

    expect(ids(result.targets)).toEqual(['backoffice/api', 'client/api', 'multivendor/api'])
  })

  it('de-duplicates targets across overlapping keys, OR-merging watchDeps', () => {
    const result = resolvePreset({ apps: { client: {}, 'client/api': { watchDeps: true } } }, discovered)

    const apiTarget = result.targets.find((t) => {
      return t.app === 'client' && t.part === 'api'
    })

    expect(ids(result.targets)).toEqual(['client/api', 'client/ui'])
    expect(apiTarget?.watchDeps).toBe(true)
  })
})

describe('resolvePreset — watchDeps', () => {
  it('applies watchDeps to api targets only, never ui', () => {
    const result = resolvePreset({ apps: { client: { watchDeps: true } } }, discovered)

    expect(
      result.targets.find((t) => {
        return t.part === 'api'
      })?.watchDeps,
    ).toBe(true)
    expect(
      result.targets.find((t) => {
        return t.part === 'ui'
      })?.watchDeps,
    ).toBe(false)
  })
})

describe('resolvePreset — derived local set', () => {
  it('derives localApps from launched api targets', () => {
    const result = resolvePreset({ apps: { 'client/api': { watchDeps: true }, 'backoffice/ui': {} } }, discovered)

    expect(result.localApps).toEqual(['client'])
  })

  it('a ui-only preset has an empty local set', () => {
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

describe('resolvePreset — cmux', () => {
  it('passes the cmux flag through, defaulting to false', () => {
    expect(resolvePreset({ apps: { '*/api': {} }, cmux: true }, discovered).cmux).toBe(true)
    expect(resolvePreset({ apps: { '*/api': {} } }, discovered).cmux).toBe(false)
  })
})

/**
 * Proxy-locality validation: a `route → 'local'` override is only valid when the
 * backend pkg it resolves to (per the frontend config) is launched by the preset.
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
    const presets = { 'client-remote': { apps: { 'client/ui': { proxy: { '/api': 'local' as const } } } } }
    const issues = validatePresetProxy(presets, proxyCtx)

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      preset: 'client-remote',
      app: 'client',
      route: '/api',
      pkg: 'backend-api',
      kind: 'backend-not-launched',
    })
    // Remediation hint points at the app whose api package serves the route.
    expect(issues[0]?.message).toContain('client/api')
  })

  it('accepts a local override when the preset launches that backend', () => {
    const presets = {
      'client-full': { apps: { 'client/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } },
    }

    expect(validatePresetProxy(presets, proxyCtx)).toEqual([])
  })

  it('accepts a local override for a shared backend launched via another app', () => {
    // seo has no api; its /api → backend-api, which apps/client/api provides. Launching client/api satisfies it.
    const presets = {
      'seo-local': { apps: { 'seo/ui': { proxy: { '/api': 'local' as const } }, 'client/api': {} } },
    }

    expect(validatePresetProxy(presets, proxyCtx)).toEqual([])
  })

  it('ignores cloud overrides — always satisfiable', () => {
    const presets = { 'client-cloud': { apps: { 'client/ui': { proxy: { '/api': 'cloud' as const } } } } }

    expect(validatePresetProxy(presets, proxyCtx)).toEqual([])
  })

  it('does not flag derived-local (no override) presets', () => {
    const presets = { 'client-full': { apps: { 'client/ui': {}, 'client/api': {} } } }

    expect(validatePresetProxy(presets, proxyCtx)).toEqual([])
  })

  it('flags an override naming a route absent from the frontend config', () => {
    const presets = { 'bad-route': { apps: { 'client/ui': { proxy: { '/nope': 'local' as const } } } } }
    const issues = validatePresetProxy(presets, proxyCtx)

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
    const presets = { orphan: { apps: { 'client/ui': { proxy: { '/api': 'local' as const } } } } }
    const issues = validatePresetProxy(presets, ctx)

    expect(issues[0]).toMatchObject({ kind: 'backend-not-launched', pkg: 'orphan-api' })
    expect(issues[0]?.message).toContain('launch the api whose package is "orphan-api"')
  })
})
