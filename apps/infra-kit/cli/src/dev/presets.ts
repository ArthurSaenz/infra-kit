/**
 * Pure resolution of a named dev preset into a concrete run plan.
 *
 * A preset (declared under `devPresets` in the per-project infra-kit.json) names
 * launch targets (`client`, `client/api`, `client/ui`, or a `*` glob), optional
 * per-backend `watchDeps`, per-route proxy-source overrides, and a `cmux` layout
 * flag. This module turns that declarative shape into a flat {@link ResolvedPreset}
 * the runner consumes. Side-effect free: the discovered app parts are passed in
 * (never read from disk here), so resolution is fully unit-testable.
 */
import type { DevPreset, DevPresets, ProxySource } from 'src/lib/infra-kit-config'

/** The two launchable halves of an `apps/<app>` folder. */
export type AppPart = 'api' | 'ui'

/** One concrete thing to launch: a single part of a single app. */
export interface ResolvedTarget {
  /** App folder name (e.g. `client`). */
  app: string
  /** Which half of the app to launch. */
  part: AppPart
  /** api-only: watch the backend's dist + shared-package subdeps and restart on change. Always false for `ui`. */
  watchDeps: boolean
}

/** Which apps have an `api` / `ui` part on disk — the resolver's view of discovery. */
export interface DiscoveredParts {
  /** App names that have `apps/<app>/api`. */
  api: string[]
  /** App names that have `apps/<app>/ui`. */
  ui: string[]
}

/** A fully-resolved preset: the flat run plan derived from its declarative shape. */
export interface ResolvedPreset {
  /** Every (app, part) to launch, de-duplicated. */
  targets: ResolvedTarget[]
  /** Run each target in its own cmux pane. */
  cmux: boolean
  /** app → (route path → source) overrides, threaded to the proxy resolver. */
  proxy: Record<string, Record<string, ProxySource>>
  /** Apps whose `api` part is launched — their backends are local (derived). */
  localApps: string[]
  /** Explicitly-named `<app>/<part>` targets that matched no discovered app/part (for a warning). */
  unmatched: string[]
}

/** The two parts, in stable order, used when a bare `<app>` key means "both halves". */
const ALL_PARTS: readonly AppPart[] = ['api', 'ui']

interface ParsedKey {
  /** App name or `*` (all discovered apps). */
  appGlob: string
  /** Parts the key selects (both when no `/part` suffix is given). */
  parts: readonly AppPart[]
  /** True when the key named a specific part (`client/api`) — drives the unmatched warning. */
  explicit: boolean
}

/**
 * Parse a preset target key into an app glob + selected parts.
 *
 * @example
 * parseTargetKey('client')      // => { appGlob: 'client', parts: ['api','ui'], explicit: false }
 * parseTargetKey('client/api')  // => { appGlob: 'client', parts: ['api'],      explicit: true }
 * parseTargetKey('*')           // => { appGlob: '*',      parts: ['api','ui'], explicit: false }
 */
export const parseTargetKey = (key: string): ParsedKey => {
  const segments = key.split('/')
  const [appGlob, part] = segments

  if (segments.length > 2 || !appGlob) {
    throw new Error(`devPresets: invalid target "${key}" (expected "<app>" or "<app>/api|ui")`)
  }

  if (part === undefined) {
    return { appGlob, parts: ALL_PARTS, explicit: false }
  }

  if (part === 'api' || part === 'ui') {
    return { appGlob, parts: [part], explicit: true }
  }

  throw new Error(`devPresets: invalid target part "${part}" in "${key}" (expected "api" or "ui")`)
}

/** App names that have `part` on disk, per the discovery result. */
const appsWithPart = (discovered: DiscoveredParts, part: AppPart): string[] => {
  return part === 'api' ? discovered.api : discovered.ui
}

/** Every discovered app name (union of api + ui halves), sorted for deterministic output. */
const allApps = (discovered: DiscoveredParts): string[] => {
  return [...new Set([...discovered.api, ...discovered.ui])].sort()
}

/** Stable `app/part` identity key for de-duplicating targets across preset keys. */
const targetId = (app: string, part: AppPart): string => {
  return `${app}/${part}`
}

interface ResolveState {
  targets: Map<string, ResolvedTarget>
  proxy: Record<string, Record<string, ProxySource>>
  unmatched: string[]
}

/**
 * Fold one (app, part) into the accumulator: record a target when the part exists,
 * OR-merge `watchDeps` with any prior target of the same identity, and flag an
 * explicitly-named-but-missing part as unmatched (glob-expanded misses are silent).
 */
const addTarget = (
  state: ResolveState,
  discovered: DiscoveredParts,
  spec: { app: string; part: AppPart; watchDeps: boolean; isGlob: boolean; explicit: boolean },
): void => {
  const { app, part, watchDeps, isGlob, explicit } = spec

  if (!appsWithPart(discovered, part).includes(app)) {
    // A bare `<app>` (both parts) silently skips the missing half; only an explicit,
    // non-glob `<app>/<part>` that can't be found is a mistake worth surfacing.
    if (explicit && !isGlob) {
      state.unmatched.push(targetId(app, part))
    }

    return
  }

  const id = targetId(app, part)
  const prior = state.targets.get(id)
  // watchDeps only applies to backends; a ui target is always false.
  const effectiveWatch = part === 'api' && (watchDeps || (prior?.watchDeps ?? false))

  state.targets.set(id, { app, part, watchDeps: effectiveWatch })
}

/**
 * Resolve a preset against the discovered app parts. Expands globs (`*`) and bare
 * `<app>` keys (both halves), de-duplicates targets, derives the local-backend set
 * from the launched `api` targets, and collects per-app proxy overrides. Unknown
 * app/route names are tolerated (an explicit missing target lands in `unmatched`,
 * not an exception) so a stale preset degrades gracefully.
 *
 * @example
 * resolvePreset(
 *   { apps: { 'client/ui': {}, 'client/api': { watchDeps: true } } },
 *   { api: ['client'], ui: ['client'] },
 * )
 * // => {
 * //   targets: [{ app: 'client', part: 'ui', watchDeps: false },
 * //             { app: 'client', part: 'api', watchDeps: true }],
 * //   cmux: false, proxy: {}, localApps: ['client'], unmatched: [],
 * // }
 */
export const resolvePreset = (preset: DevPreset, discovered: DiscoveredParts): ResolvedPreset => {
  const entries = Object.entries(preset.apps ?? { '*': {} })
  const state: ResolveState = { targets: new Map(), proxy: {}, unmatched: [] }

  for (const [key, cfg] of entries) {
    const { appGlob, parts, explicit } = parseTargetKey(key)
    const isGlob = appGlob === '*'
    const apps = isGlob ? allApps(discovered) : [appGlob]

    for (const app of apps) {
      for (const part of parts) {
        addTarget(state, discovered, { app, part, watchDeps: cfg.watchDeps ?? false, isGlob, explicit })
      }

      if (cfg.proxy) {
        state.proxy[app] = { ...(state.proxy[app] ?? {}), ...cfg.proxy }
      }
    }
  }

  const targets = [...state.targets.values()]
  const localApps = [
    ...new Set(
      targets
        .filter((t) => {
          return t.part === 'api'
        })
        .map((t) => {
          return t.app
        }),
    ),
  ]

  return { targets, cmux: preset.cmux ?? false, proxy: state.proxy, localApps, unmatched: state.unmatched }
}

/** A devPresets proxy-locality violation surfaced by the audit. */
export interface PresetProxyIssue {
  /** Preset name the violation is in. */
  preset: string
  /** Frontend app folder the override is under (e.g. `client`). */
  app: string
  /** Route path forced to a source (e.g. `/api`). */
  route: string
  /** Backend pkg the route maps to; undefined when the route is not declared in the frontend config. */
  pkg?: string
  /** `unknown-route` = route absent from the frontend config; `backend-not-launched` = local target not launched. */
  kind: 'unknown-route' | 'backend-not-launched'
  /** Human-readable, actionable explanation. */
  message: string
}

/**
 * Cross-file lookups the proxy validator needs, kept injectable so the rule stays
 * filesystem-free (and unit-testable). The impure side (audit) builds these from
 * discovery + each frontend's loaded `infra-kit.config.ts`.
 */
export interface PresetProxyContext {
  /** Discovered app parts, for resolving each preset's launch set. */
  discovered: DiscoveredParts
  /** App folder name → its `apps/<app>/api` package name. */
  apiPkgByApp: Record<string, string>
  /** (frontend app folder, route path) → backend pkg from that frontend's config; undefined when the route is absent. */
  routePkg: (app: string, route: string) => string | undefined
}

interface CheckLocalRouteArgs {
  preset: string
  app: string
  route: string
  launchedPkgs: ReadonlySet<string>
  ctx: PresetProxyContext
}

/** App folder whose `api` package is `pkg` (for the remediation hint), or undefined. */
const ownerApp = (apiPkgByApp: Record<string, string>, pkg: string): string | undefined => {
  return Object.keys(apiPkgByApp).find((app) => {
    return apiPkgByApp[app] === pkg
  })
}

/**
 * Validate one `route → 'local'` override: the route must be declared in the
 * frontend config, and the backend pkg it maps to must be in the preset's launched
 * set. Returns the issue, or null when the override is satisfiable.
 */
const checkLocalRoute = ({ preset, app, route, launchedPkgs, ctx }: CheckLocalRouteArgs): PresetProxyIssue | null => {
  const pkg = ctx.routePkg(app, route)

  if (pkg === undefined) {
    return {
      preset,
      app,
      route,
      kind: 'unknown-route',
      message: `preset "${preset}": proxy override "${route}" on "${app}" names a route not declared in ${app}'s infra-kit.config.ts dev.proxy.routes`,
    }
  }

  if (launchedPkgs.has(pkg)) {
    return null
  }

  const owner = ownerApp(ctx.apiPkgByApp, pkg)
  const hint = owner ? `add "${owner}/api" to the preset` : `launch the api whose package is "${pkg}"`

  return {
    preset,
    app,
    route,
    pkg,
    kind: 'backend-not-launched',
    message: `preset "${preset}": proxy override "${route}" → "local" requires backend "${pkg}" to run locally, but the preset does not launch it — ${hint}, or set "${route}" to "cloud"`,
  }
}

/**
 * Audit every preset's per-route proxy overrides: a route pinned to `local` is only
 * valid when the backend package it resolves to (per the frontend's
 * `infra-kit.config.ts`) is actually launched by that same preset. Catches the
 * `{ "client/ui": { "proxy": { "/api": "local" } } }` case where no local backend
 * is running to serve `/api`. `cloud` overrides are always satisfiable and skipped.
 *
 * @example
 * validatePresetProxy(
 *   { 'client-remote': { apps: { 'client/ui': { proxy: { '/api': 'local' } } } } },
 *   { discovered: { api: ['client'], ui: ['client'] }, apiPkgByApp: { client: 'backend-api' },
 *     routePkg: () => 'backend-api' },
 * )
 * // => [{ preset: 'client-remote', app: 'client', route: '/api', pkg: 'backend-api',
 * //       kind: 'backend-not-launched', message: '…' }]
 */
export const validatePresetProxy = (presets: DevPresets, ctx: PresetProxyContext): PresetProxyIssue[] => {
  const issues: PresetProxyIssue[] = []

  for (const [preset, def] of Object.entries(presets)) {
    const resolved = resolvePreset(def, ctx.discovered)
    const launchedPkgs = new Set(
      resolved.localApps
        .map((app) => {
          return ctx.apiPkgByApp[app]
        })
        .filter((pkg): pkg is string => {
          return pkg !== undefined
        }),
    )

    for (const [app, routes] of Object.entries(resolved.proxy)) {
      for (const [route, source] of Object.entries(routes)) {
        if (source !== 'local') {
          continue
        }

        const issue = checkLocalRoute({ preset, app, route, launchedPkgs, ctx })

        if (issue) {
          issues.push(issue)
        }
      }
    }
  }

  return issues
}
