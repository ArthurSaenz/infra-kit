/**
 * Pure resolution of a named dev preset into a concrete run plan.
 *
 * A preset (declared under `devServersPresets` in the per-project infra-kit.json) names
 * launch targets (`client/api`, `client/ui`, with `*` allowed in the app position), optional
 * per-target `watchDeps` (api + ui), per-route proxy-source overrides, and a `cmux` layout
 * flag. This module turns that declarative shape into a flat {@link ResolvedPreset}
 * the runner consumes. Side-effect free: the discovered app parts are passed in
 * (never read from disk here), so resolution is fully unit-testable.
 *
 * Every target key names exactly one workspace package — the app folder plus the part
 * (`apps/<app>/api` or `apps/<app>/ui`). A bare `<app>` is not a package and is rejected.
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
  /**
   * Participate in dependency-closure watching (uniform for api + ui): react to a change in
   * this target's own workspace-dependency closure. Default `true` (opt-in participation).
   * Resolution is specificity-ordered: an explicit value on a more-specific key (a concrete
   * app, or an explicit `/part`) wins over a `*` glob; at equal specificity an explicit
   * `false` wins over `true` (order-independent opt-out). See {@link resolveWatch}.
   */
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
  /** Concretely-named `<app>/<part>` targets that matched no discovered app/part (for a warning). */
  unmatched: string[]
}

/** The target keys resolution falls back to when a preset omits `apps`: every discovered package. */
const ALL_TARGETS_KEYS: NonNullable<DevPreset['apps']> = { '*/api': {}, '*/ui': {} }

/** A preset target key that does not name an `<app>/<part>` package. */
export interface PresetKeyIssue {
  /** Preset name the bad key is under. */
  preset: string
  /** The offending key, verbatim. */
  key: string
  /** Human-readable, actionable explanation (already prefixed with the preset name). */
  message: string
}

interface ParsedKey {
  /** App name or `*` (all discovered apps). */
  appGlob: string
  /** The single part the key selects. */
  part: AppPart
}

/**
 * Explain why `key` is not a valid target, or null when it parses. Keys name one workspace
 * package, so the `/api`|`/ui` part is mandatory — a bare `client` names a folder, not a package.
 */
export const explainTargetKey = (key: string): string | null => {
  const segments = key.split('/')
  const [appGlob, part] = segments

  if (segments.length !== 2 || !appGlob) {
    return `devServersPresets: invalid target "${key}" (expected "<app>/api" or "<app>/ui")`
  }

  if (part !== 'api' && part !== 'ui') {
    return `devServersPresets: invalid target part "${part}" in "${key}" (expected "api" or "ui")`
  }

  return null
}

/**
 * Parse a preset target key into an app glob + its part. Throws when the key is not an
 * `<app>/<part>` package identity (see {@link explainTargetKey}).
 *
 * A `*` app glob is legal (`*` plus a part), and expands to every discovered app.
 *
 * @example
 * parseTargetKey('client/api')  // => { appGlob: 'client', part: 'api' }
 */
export const parseTargetKey = (key: string): ParsedKey => {
  const error = explainTargetKey(key)

  if (error) {
    throw new Error(error)
  }

  const [appGlob, part] = key.split('/') as [string, AppPart]

  return { appGlob, part }
}

/** Every `preset → invalid target key` in the map, with the reason (empty when all keys parse). */
export const validatePresetKeys = (presets: DevPresets): PresetKeyIssue[] => {
  const issues: PresetKeyIssue[] = []

  for (const [preset, def] of Object.entries(presets)) {
    for (const key of Object.keys(def.apps ?? {})) {
      const error = explainTargetKey(key)

      if (error) {
        issues.push({ preset, key, message: `preset "${preset}": ${error}` })
      }
    }
  }

  return issues
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

/** A resolved target plus the provenance the merge needs to order later keys by specificity. */
interface ResolvedTargetInternal extends ResolvedTarget {
  /** Specificity rank of the key that set `watchDeps` (see {@link keyRank}) — a higher rank wins. */
  rank: number
  /** Whether `watchDeps` came from an explicit preset value (vs the participate-default). */
  explicitValue: boolean
}

interface ResolveState {
  targets: Map<string, ResolvedTargetInternal>
  proxy: Record<string, Record<string, ProxySource>>
  unmatched: string[]
}

/**
 * Specificity rank of a preset key, higher = more specific. Every key names a part, so the
 * only axis left is the app: a concrete `client/api` (1) beats a `*` glob key (0).
 */
const keyRank = (isGlob: boolean): number => {
  return isGlob ? 0 : 1
}

/**
 * Merge a preset key's `watchDeps` into any prior resolution for the same target. A key that
 * omits `watchDeps` never clobbers a prior explicit value (and, absent any explicit value,
 * seeds the participate-default `true`). A more-specific key ({@link keyRank}) wins in either
 * direction, so a `*` glob cannot override a concrete `client/api` and vice-versa. Two explicit
 * keys can never tie: each target is named by at most one key per rank (one glob, one concrete),
 * so the merge is order-independent.
 */
const resolveWatch = (
  prior: ResolvedTargetInternal | undefined,
  next: { watchDeps: boolean | undefined; rank: number },
): { watchDeps: boolean; rank: number; explicitValue: boolean } => {
  // This key configured nothing → keep the prior resolution, or seed the participate-default.
  if (next.watchDeps === undefined) {
    return prior ?? { watchDeps: true, rank: next.rank, explicitValue: false }
  }

  // No prior explicit value (fresh, or only a default) → this explicit value takes it.
  if (!prior || !prior.explicitValue) {
    return { watchDeps: next.watchDeps, rank: next.rank, explicitValue: true }
  }

  // Two explicit values: the more-specific key wins, in either direction.
  return next.rank > prior.rank ? { watchDeps: next.watchDeps, rank: next.rank, explicitValue: true } : prior
}

/**
 * Fold one (app, part) into the accumulator: record a target when the part exists,
 * merge `watchDeps` with any prior target of the same identity by specificity
 * ({@link resolveWatch}), and flag a named-but-missing package as unmatched
 * (glob-expanded misses are silent).
 */
const addTarget = (
  state: ResolveState,
  discovered: DiscoveredParts,
  spec: { app: string; part: AppPart; watchDeps: boolean | undefined; isGlob: boolean },
): void => {
  const { app, part, watchDeps, isGlob } = spec

  if (!appsWithPart(discovered, part).includes(app)) {
    // A glob expands over discovery, so its misses are expected; a concretely-named
    // `<app>/<part>` that can't be found is a mistake worth surfacing.
    if (!isGlob) {
      state.unmatched.push(targetId(app, part))
    }

    return
  }

  const id = targetId(app, part)
  const merged = resolveWatch(state.targets.get(id), { watchDeps, rank: keyRank(isGlob) })

  state.targets.set(id, { app, part, ...merged })
}

/**
 * Resolve a preset against the discovered app parts. Expands `*` app globs,
 * de-duplicates targets, derives the local-backend set from the launched `api`
 * targets, and collects per-app proxy overrides. Unknown app/route names are
 * tolerated (a missing named target lands in `unmatched`, not an exception) so a
 * stale preset degrades gracefully — but a key that is not an `<app>/<part>`
 * package identity throws, since it can't be resolved at all.
 *
 * @example
 * resolvePreset(
 *   { apps: { 'client/ui': {}, 'client/api': { watchDeps: false } } },
 *   { api: ['client'], ui: ['client'] },
 * )
 * // => {
 * //   targets: [{ app: 'client', part: 'ui', watchDeps: true },   // default participate
 * //             { app: 'client', part: 'api', watchDeps: false }], // explicit opt-out
 * //   cmux: false, proxy: {}, localApps: ['client'], unmatched: [],
 * // }
 */
export const resolvePreset = (preset: DevPreset, discovered: DiscoveredParts): ResolvedPreset => {
  const entries = Object.entries(preset.apps ?? ALL_TARGETS_KEYS)
  const state: ResolveState = { targets: new Map(), proxy: {}, unmatched: [] }

  for (const [key, cfg] of entries) {
    const { appGlob, part } = parseTargetKey(key)
    const isGlob = appGlob === '*'
    const apps = isGlob ? allApps(discovered) : [appGlob]

    for (const app of apps) {
      addTarget(state, discovered, { app, part, watchDeps: cfg.watchDeps, isGlob })

      if (cfg.proxy) {
        state.proxy[app] = { ...(state.proxy[app] ?? {}), ...cfg.proxy }
      }
    }
  }

  const targets: ResolvedTarget[] = [...state.targets.values()].map(({ app, part, watchDeps }) => {
    return { app, part, watchDeps }
  })
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

/** What the run launched, as passed to {@link deriveTargetLabel}. */
export interface TargetLabelInput {
  /** Named preset (`infra-kit dev <preset>`) — its name is the label when present. */
  preset?: string
  /** The `<app>/<part>` package keys actually being launched, after preset resolution and `--app`. */
  running: string[]
  /** Every `<app>/<part>` package key discovered in the monorepo. */
  discovered: string[]
}

/**
 * The header's target label. A named preset labels itself; otherwise the label is the set of
 * `<app>/<part>` packages actually launching, collapsing to `*` when that set is everything
 * discovered. Never a bare app name: `client` is not a target anywhere in this system (see
 * {@link parseTargetKey}) and would hide which half of the app is running — the whole point of
 * the wizard's part-level selection.
 *
 * @example
 * deriveTargetLabel({ running: ['client/ui', 'client/api'], discovered: ['client/api', 'client/ui', 'seo/ui'] })
 * // => 'client/api + client/ui'
 * deriveTargetLabel({ running: ['client/api'], discovered: ['client/api'] }) // => '*'
 * deriveTargetLabel({ preset: 'full', running: ['client/api'], discovered: ['client/api', 'seo/ui'] }) // => 'full'
 */
export const deriveTargetLabel = (input: TargetLabelInput): string => {
  if (input.preset != null) {
    return input.preset
  }
  if (input.running.length === 0) {
    return 'nothing'
  }

  const running = new Set(input.running)
  const isEverything = input.discovered.every((key) => {
    return running.has(key)
  })

  return isEverything ? '*' : [...running].sort().join(' + ')
}

/** A devServersPresets proxy-locality violation surfaced by the audit. */
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
