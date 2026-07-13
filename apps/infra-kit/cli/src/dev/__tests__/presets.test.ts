import { describe, expect, it } from 'vitest'

import {
  deriveTargetLabel,
  parseTargetKey,
  resolvePreset,
  validatePresetKeys,
  validatePresetProxy,
} from 'src/dev/presets'
import type { DiscoveredParts, PresetProxyContext, ResolvedTarget } from 'src/dev/presets'

/**
 * Pure preset resolution: every spec passes an explicit `DiscoveredParts` view so
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

  it('prefers the named preset over the launched set', () => {
    expect(deriveTargetLabel({ preset: 'full', running: ['client/api'], discovered: allKeys })).toBe('full')
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

describe('validatePresetKeys', () => {
  it('reports every bad key, naming the preset it lives under', () => {
    const issues = validatePresetKeys({
      multivendorLocal: { apps: { multivendor: { proxy: { '/api': 'local' } } } },
      clientLocal: { apps: { 'client/ui': {}, 'client/api': {} } },
      backofficeBad: { apps: { 'backoffice/server': {} } },
    })

    expect(
      issues.map((i) => {
        return `${i.preset}:${i.key}`
      }),
    ).toEqual(['multivendorLocal:multivendor', 'backofficeBad:backoffice/server'])
    expect(issues[0]?.message).toContain('preset "multivendorLocal"')
  })

  it('accepts globs, and an apps-less preset', () => {
    expect(validatePresetKeys({ all: {}, backends: { apps: { '*/api': {} } } })).toEqual([])
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

  it('de-duplicates overlapping keys and lets the more-specific key set watchDeps', () => {
    // A `*/api` glob plus a concrete `client/api` opt-out: one `client/api` target survives
    // (deduped), and the explicit `false` on the more-specific key applies. A regressed merge
    // that ignored specificity (or defaulted api to `true`) would fail here.
    const result = resolvePreset({ apps: { '*/api': {}, 'client/api': { watchDeps: false } } }, discovered)

    const apiTarget = result.targets.find((t) => {
      return t.app === 'client' && t.part === 'api'
    })

    expect(ids(result.targets)).toEqual(['backoffice/api', 'client/api', 'multivendor/api'])
    expect(apiTarget?.watchDeps).toBe(false)
  })
})

describe('resolvePreset — watchDeps (uniform FE+BE participation, default true, sticky opt-out)', () => {
  const target = (targets: ResolvedTarget[], app: string, part: string): ResolvedTarget | undefined => {
    return targets.find((t) => {
      return t.app === app && t.part === part
    })
  }

  it('defaults every target (api AND ui) to participate when watchDeps is absent', () => {
    const result = resolvePreset({ apps: { 'client/api': {}, 'client/ui': {} } }, discovered)

    expect(target(result.targets, 'client', 'api')?.watchDeps).toBe(true)
    expect(target(result.targets, 'client', 'ui')?.watchDeps).toBe(true)
  })

  it('resolves watchDeps=true for every target when NOTHING configures it (default-false-inversion regression guard)', () => {
    // The reviewer's CRITICAL: coercing `undefined → false` before merge would silently make
    // every target sticky-false, so no backend would restart on a lib rebuild. Guard that here.
    const result = resolvePreset({}, discovered)

    for (const t of result.targets) {
      expect(t.watchDeps).toBe(true)
    }
  })

  it('honors an explicit watchDeps on a ui target (no longer force-false)', () => {
    const off = resolvePreset({ apps: { 'client/ui': { watchDeps: false } } }, discovered)
    const on = resolvePreset({ apps: { 'client/ui': {} } }, discovered)

    expect(target(off.targets, 'client', 'ui')?.watchDeps).toBe(false)
    expect(target(on.targets, 'client', 'ui')?.watchDeps).toBe(true)
  })

  it('lets a concrete key defeat a glob in both directions, order-independent (glob:true vs client/api:false)', () => {
    const forward = resolvePreset(
      { apps: { '*/api': { watchDeps: true }, 'client/api': { watchDeps: false } } },
      discovered,
    )
    const reverse = resolvePreset(
      { apps: { 'client/api': { watchDeps: false }, '*/api': { watchDeps: true } } },
      discovered,
    )

    expect(target(forward.targets, 'client', 'api')?.watchDeps).toBe(false)
    expect(target(reverse.targets, 'client', 'api')?.watchDeps).toBe(false)
    // A sibling the specific key did not touch still follows the glob.
    expect(target(forward.targets, 'backoffice', 'api')?.watchDeps).toBe(true)
  })

  it('lets a concrete opt-IN defeat a glob opt-out (glob:false vs client/api:true) — specificity wins, not false', () => {
    // Regression guard for the old sticky-false rule, where ANY explicit `false` latched and a
    // more-specific opt-in could never re-enable participation. Now the concrete key wins.
    const forward = resolvePreset(
      { apps: { '*/api': { watchDeps: false }, 'client/api': { watchDeps: true } } },
      discovered,
    )
    const reverse = resolvePreset(
      { apps: { 'client/api': { watchDeps: true }, '*/api': { watchDeps: false } } },
      discovered,
    )

    expect(target(forward.targets, 'client', 'api')?.watchDeps).toBe(true)
    expect(target(reverse.targets, 'client', 'api')?.watchDeps).toBe(true)
    // A sibling the specific key did not touch still follows the glob's opt-out.
    expect(target(forward.targets, 'backoffice', 'api')?.watchDeps).toBe(false)
  })

  it('keeps the two part-globs independent: `*/api` opt-out never reaches a `ui` target', () => {
    // Each key names one part, so `*/api` and `*/ui` partition the target space — neither
    // can be clobbered by the other, whatever the key order.
    const result = resolvePreset({ apps: { '*/api': { watchDeps: false }, '*/ui': { watchDeps: true } } }, discovered)

    expect(target(result.targets, 'client', 'api')?.watchDeps).toBe(false)
    expect(target(result.targets, 'client', 'ui')?.watchDeps).toBe(true)
    expect(target(result.targets, 'seo', 'ui')?.watchDeps).toBe(true)
  })

  it('scopes a concrete opt-out to its own part, leaving the app`s other half on the glob default', () => {
    // `client/ui:false` must not drag `client/api` down with it — the old bare-`client` key
    // was the only way to touch both halves, and it no longer exists.
    const result = resolvePreset({ apps: { '*/api': {}, 'client/ui': { watchDeps: false } } }, discovered)

    expect(target(result.targets, 'client', 'ui')?.watchDeps).toBe(false)
    expect(target(result.targets, 'client', 'api')?.watchDeps).toBe(true)
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
