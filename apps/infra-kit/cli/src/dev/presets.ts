/**
 * Pure resolution of an in-memory dev run plan into the flat set of packages to launch.
 *
 * The plan is built by `infra-kit dev <app>` ({@link file://./app-plan.ts}), `--target`, and the
 * interactive wizard — never read from config. It names launch targets (`client/api`, `client/ui`, with
 * `*` allowed in the app position) and per-route proxy-source pins. Side-effect free: the discovered
 * app parts are passed in (never read from disk here), so resolution is fully unit-testable.
 *
 * Every target key names exactly one workspace package — the app folder plus the part
 * (`apps/<app>/api` or `apps/<app>/ui`). A bare `<app>` is not a package and is rejected.
 */

/** Where a proxy route resolves: a locally launched backend, or the deployed cloud target. */
export type ProxySource = 'local' | 'cloud'

/** One run plan: target key → that target's per-route proxy pins. Omit `apps` to run every package. */
export interface DevPreset {
  apps?: Record<string, { proxy?: Record<string, ProxySource> }>
}

/** The two launchable halves of an `apps/<app>` folder. */
export type AppPart = 'api' | 'ui'

/** One concrete thing to launch: a single part of a single app. */
export interface ResolvedTarget {
  /** App folder name (e.g. `client`). */
  app: string
  /** Which half of the app to launch. */
  part: AppPart
}

/** Which apps have an `api` / `ui` part on disk — the resolver's view of discovery. */
export interface DiscoveredParts {
  /** App names that have `apps/<app>/api`. */
  api: string[]
  /** App names that have `apps/<app>/ui`. */
  ui: string[]
}

/** A fully-resolved plan: the flat set of packages derived from its declarative shape. */
export interface ResolvedPreset {
  /** Every (app, part) to launch, de-duplicated. */
  targets: ResolvedTarget[]
  /**
   * app → (route path → source) pins, as DECLARED by the plan.
   *
   * Not an input to proxy resolution, and never has been: the vite helper derives a route's source from
   * the dev-context fragments the runner writes, so a route is local iff its backend is actually up. This
   * map is the declared INTENT, and it has two readers:
   *  - `validatePresetProxy` — the STATIC check, run by the bare-invocation wizard;
   *  - `local-pairing.ts` — the RUNTIME check, which folds a `local` pin into the set of packages the run
   *    intended to serve locally, and refuses when one of them is not actually up.
   */
  proxy: Record<string, Record<string, ProxySource>>
  /** Apps whose `api` part is launched — their backends are local (derived). */
  localApps: string[]
  /** Concretely-named `<app>/<part>` targets that matched no discovered app/part (for a warning). */
  unmatched: string[]
}

/** The target keys resolution falls back to when a plan omits `apps`: every discovered package. */
const ALL_TARGETS_KEYS: NonNullable<DevPreset['apps']> = { '*/api': {}, '*/ui': {} }

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
    return `invalid target "${key}" (expected "<app>/api" or "<app>/ui")`
  }

  if (part !== 'api' && part !== 'ui') {
    return `invalid target part "${part}" in "${key}" (expected "api" or "ui")`
  }

  return null
}

/**
 * Parse a target key into an app glob + its part. Throws when the key is not an
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

/** App names that have `part` on disk, per the discovery result. */
const appsWithPart = (discovered: DiscoveredParts, part: AppPart): string[] => {
  return part === 'api' ? discovered.api : discovered.ui
}

/** Every discovered app name (union of api + ui halves), sorted for deterministic output. */
const allApps = (discovered: DiscoveredParts): string[] => {
  return [...new Set([...discovered.api, ...discovered.ui])].sort()
}

/** Stable `app/part` identity key for de-duplicating targets across plan keys. */
const targetId = (app: string, part: AppPart): string => {
  return `${app}/${part}`
}

interface ResolveState {
  targets: Map<string, ResolvedTarget>
  proxy: Record<string, Record<string, ProxySource>>
  unmatched: string[]
}

/**
 * Fold one (app, part) into the accumulator: record a target when the part exists, and flag a
 * named-but-missing package as unmatched (glob-expanded misses are silent).
 */
const addTarget = (
  state: ResolveState,
  discovered: DiscoveredParts,
  spec: { app: string; part: AppPart; isGlob: boolean },
): void => {
  const { app, part, isGlob } = spec

  if (!appsWithPart(discovered, part).includes(app)) {
    // A glob expands over discovery, so its misses are expected; a concretely-named
    // `<app>/<part>` that can't be found is a mistake worth surfacing.
    if (!isGlob) {
      state.unmatched.push(targetId(app, part))
    }

    return
  }

  state.targets.set(targetId(app, part), { app, part })
}

/**
 * Resolve a plan against the discovered app parts. Expands `*` app globs,
 * de-duplicates targets, derives the local-backend set from the launched `api`
 * targets, and collects per-app proxy pins. A missing named target lands in
 * `unmatched` rather than throwing — but a key that is not an `<app>/<part>`
 * package identity throws, since it can't be resolved at all.
 *
 * @example
 * resolvePreset({ apps: { 'client/ui': {}, 'client/api': {} } }, { api: ['client'], ui: ['client'] })
 * // => { targets: [{ app: 'client', part: 'ui' }, { app: 'client', part: 'api' }],
 * //      proxy: {}, localApps: ['client'], unmatched: [] }
 */
export const resolvePreset = (preset: DevPreset, discovered: DiscoveredParts): ResolvedPreset => {
  const entries = Object.entries(preset.apps ?? ALL_TARGETS_KEYS)
  const state: ResolveState = { targets: new Map(), proxy: {}, unmatched: [] }

  for (const [key, cfg] of entries) {
    const { appGlob, part } = parseTargetKey(key)
    const isGlob = appGlob === '*'
    const apps = isGlob ? allApps(discovered) : [appGlob]

    for (const app of apps) {
      addTarget(state, discovered, { app, part, isGlob })

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

  return { targets, proxy: state.proxy, localApps, unmatched: state.unmatched }
}

/** What the run launched, as passed to {@link deriveTargetLabel}. */
export interface TargetLabelInput {
  /** The `<app>/<part>` package keys actually being launched, after plan resolution and `--app`. */
  running: string[]
  /** Every `<app>/<part>` package key discovered in the monorepo. */
  discovered: string[]
}

/**
 * The header's target label: the set of `<app>/<part>` packages actually launching, collapsing to `*` when that set is everything
 * discovered. Never a bare app name: `client` is not a target anywhere in this system (see
 * {@link parseTargetKey}) and would hide which half of the app is running — the whole point of
 * the wizard's part-level selection.
 *
 * @example
 * deriveTargetLabel({ running: ['client/ui', 'client/api'], discovered: ['client/api', 'client/ui', 'seo/ui'] })
 * // => 'client/api + client/ui'
 * deriveTargetLabel({ running: ['client/api'], discovered: ['client/api'] }) // => '*'
 */
export const deriveTargetLabel = (input: TargetLabelInput): string => {
  if (input.running.length === 0) {
    return 'nothing'
  }

  const running = new Set(input.running)

  const isEverything = input.discovered.every((key) => {
    return running.has(key)
  })

  return isEverything ? '*' : [...running].sort().join(' + ')
}

/** A proxy-locality violation in a run plan. */
export interface PresetProxyIssue {
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
 * filesystem-free (and unit-testable). The impure side (the wizard) builds these from
 * discovery + each frontend's loaded `infra-kit.config.ts`.
 */
export interface PresetProxyContext {
  /** Discovered app parts, for resolving the plan's launch set. */
  discovered: DiscoveredParts
  /** App folder name → its `apps/<app>/api` package name. */
  apiPkgByApp: Record<string, string>
  /** (frontend app folder, route path) → backend pkg from that frontend's config; undefined when the route is absent. */
  routePkg: (app: string, route: string) => string | undefined
}

interface CheckLocalRouteArgs {
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
 * frontend config, and the backend pkg it maps to must be in the plan's launched
 * set. Returns the issue, or null when the override is satisfiable.
 */
const checkLocalRoute = ({ app, route, launchedPkgs, ctx }: CheckLocalRouteArgs): PresetProxyIssue | null => {
  const pkg = ctx.routePkg(app, route)

  if (pkg === undefined) {
    return {
      app,
      route,
      kind: 'unknown-route',
      message: `proxy override "${route}" on "${app}" names a route not declared in ${app}'s infra-kit.config.ts dev.proxy.routes`,
    }
  }

  if (launchedPkgs.has(pkg)) {
    return null
  }

  const owner = ownerApp(ctx.apiPkgByApp, pkg)
  const hint = owner ? `add "${owner}/api" to the selection` : `launch the api whose package is "${pkg}"`

  return {
    app,
    route,
    pkg,
    kind: 'backend-not-launched',
    message: `proxy override "${route}" → "local" requires backend "${pkg}" to run locally, but nothing launches it — ${hint}, or set "${route}" to "cloud"`,
  }
}

/**
 * Audit a plan's per-route proxy pins: a route pinned to `local` is only valid when the backend
 * package it resolves to (per the frontend's `infra-kit.config.ts`) is actually launched by that same
 * plan. Catches the `{ "client/ui": { "proxy": { "/api": "local" } } }` case where no local backend
 * is running to serve `/api`. `cloud` pins are always satisfiable and skipped.
 *
 * @example
 * validatePresetProxy(
 *   { apps: { 'client/ui': { proxy: { '/api': 'local' } } } },
 *   { discovered: { api: ['client'], ui: ['client'] }, apiPkgByApp: { client: 'backend-api' },
 *     routePkg: () => 'backend-api' },
 * )
 * // => [{ app: 'client', route: '/api', pkg: 'backend-api', kind: 'backend-not-launched', message: '…' }]
 */
export const validatePresetProxy = (plan: DevPreset, ctx: PresetProxyContext): PresetProxyIssue[] => {
  const resolved = resolvePreset(plan, ctx.discovered)

  const launchedPkgs = new Set(
    resolved.localApps
      .map((app) => {
        return ctx.apiPkgByApp[app]
      })
      .filter((pkg): pkg is string => {
        return pkg !== undefined
      }),
  )

  return Object.entries(resolved.proxy).flatMap(([app, routes]) => {
    return Object.entries(routes).flatMap(([route, source]) => {
      const issue = source === 'local' ? checkLocalRoute({ app, route, launchedPkgs, ctx }) : null

      return issue ? [issue] : []
    })
  })
}
