/**
 * @fileoverview
 *
 * Detect a BROKEN LOCAL PAIRING: a frontend route this run meant to serve from a local backend, whose
 * backend is not actually up.
 *
 * A backend that is not running writes no `.infra-kit/dev-context/<app>.json` fragment, so the vite
 * helper's `pickSource` finds nothing in its local set and falls through to the route's FALLBACK. For the
 * common route (`from: ['local','cloud'], default: 'cloud'`) that fallback is the shared CLOUD backend —
 * and the frontend comes up looking perfectly healthy while every request on that route leaves your
 * machine. Nothing in the resolved proxy map records that the route was ever meant to be local. You can be
 * POSTing at the cloud dev database believing you are pointed at localhost.
 *
 * The rule is INTENT vs REALITY, deliberately not "did a backend crash":
 *   degraded  ⟺  the route can be local  ∧  this run intended that package to be local  ∧  it is not up
 *
 * Keying off crashes alone (the obvious formulation) misses two reachable paths that produce the exact
 * same silent cloud proxy:
 *   - `--app` / `--self` narrows the launch set AFTER preset resolution, so a preset's backend can be
 *     dropped and never even attempted — no crash, nothing to key off;
 *   - a preset can pin a route `local` while launching no backend for it at all. (`validatePresetProxy`
 *     catches THAT statically, but it runs only under `infra-kit audit` and the bare-invocation wizard —
 *     never on the `infra-kit dev <preset>` path, which is the one people actually type.)
 * "Intended local, isn't up" covers all three with one predicate, crash included.
 *
 * Side-effect free: every input is passed in (nothing is read from disk here), so the rule is fully
 * unit-testable.
 */

/** The two places a frontend route can be served from — mirrors `InfraKitDevProxySource`. */
export type PairingSource = 'local' | 'cloud'

/**
 * One route from a frontend's `dev.proxy.routes`, as the pairing check reads it. Deliberately shaped like
 * the real config route so the caller hands its loaded config straight in with no translation.
 */
export interface PairingRoute {
  /** The backend package this route proxies to. */
  packageName: string
  /** The sources this route can be served from. Only a route that lists `local` can be degraded. */
  from: readonly PairingSource[]
  /**
   * The declared fallback. MUST be carried, and the reason is subtle: the helper resolves an unserved
   * route to `route.default ?? route.from[0]` (see `pickSource`). So a `from: ['local']` route with no
   * `default` — which the schema allows, since `default` is only required for a multi-source route —
   * falls back to **`local`**, at an alias nothing registered. That is a loud 502, NOT a silent cloud
   * proxy, and a message that says "would proxy to cloud" would be naming a destination the traffic
   * never reaches. Still degraded, still worth refusing; just a different failure to describe honestly.
   */
  default?: PairingSource
  /** The preset pinned this route `local` via a `devServersPresets` proxy override — an explicit intent. */
  pinnedLocal?: boolean
}

/** A frontend this run launched, plus the `dev.proxy` block it declared. */
export interface LaunchedUi {
  /** App folder name (e.g. `client`). */
  app: string
  /** Route path → its declared backend, capable sources, and fallback. */
  routes: Record<string, PairingRoute>
  /**
   * The frontend's `dev.proxy.templates.cloud`, so a cloud-falling route can name the origin it is about
   * to use. Omitted → the finding carries no `cloudTarget`.
   */
  cloudTemplate?: string
}

/** Everything the rule needs to decide intent vs reality. */
export interface PairingInputs {
  /** The frontends this run actually launched. */
  uis: readonly LaunchedUi[]
  /**
   * Backend packages this run INTENDED to serve locally: every `<app>/api` the preset names, taken BEFORE
   * `--app`/`--self` narrowing — narrowing changes what runs, never what the preset promised.
   */
  wanted: ReadonlySet<string>
  /** Backend packages that are actually up (i.e. have written a dev-context fragment). */
  running: ReadonlySet<string>
  /** package → its start-failure reason. Absent for a package that was never attempted at all. */
  reasons: ReadonlyMap<string, { app: string; reason: string }>
  /** `INFRA_KIT_ENV`, for the `<env>` placeholder in a cloud template. */
  env?: string
}

/** A route this run meant to serve locally, whose backend is not up. */
export interface DegradedRoute {
  /** Frontend app folder the route belongs to. */
  uiApp: string
  /** Route path (e.g. `/api`). */
  route: string
  /** The backend package the route wanted. */
  packageName: string
  /** Where the route ACTUALLY resolves now — what the helper's `pickSource` will return. */
  fallback: PairingSource
  /** App folder of the backend, when this run attempted it (absent when it was never launched). */
  apiApp?: string
  /** Why it is not up: the start-failure reason, or a statement that the run never launched it. */
  reason: string
  /** The cloud origin the route now resolves to. Set ONLY when `fallback` is `cloud` AND it is knowable. */
  cloudTarget?: string
}

/** Reason text for a package the run never even attempted to start. */
const NOT_LAUNCHED = 'this run never launched it'

/**
 * Fill the `<env>`/`<packageName>` placeholders in a cloud template (`<release>` is local-only), or
 * `undefined` when the template needs an `<env>` and none is sourced.
 *
 * Refusing to interpolate an empty `<env>` matters: `https://<env>.hulyo.co.il` with nothing to put in it
 * renders `https://.hulyo.co.il`, a host that resolves nowhere. Naming a made-up origin in a message whose
 * entire job is to tell the user WHERE their traffic was about to go is worse than naming none — the
 * caller then says "the cloud backend" and stays true.
 */
const interpolateCloud = (template: string, packageName: string, env: string | undefined): string | undefined => {
  if (!env && template.includes('<env>')) return undefined

  return template.replaceAll('<packageName>', packageName).replaceAll('<env>', env ?? '')
}

/** Where an unserved route actually lands, per the helper's `pickSource`: `default`, else the sole source. */
const resolveFallback = (route: PairingRoute): PairingSource => {
  return route.default ?? route.from[0] ?? 'cloud'
}

/** The cloud origin a route lands on, or undefined when there is no template (or no `<env>` for one). */
const cloudTargetOf = (
  cloudTemplate: string | undefined,
  packageName: string,
  env: string | undefined,
): string | undefined => {
  return cloudTemplate == null ? undefined : interpolateCloud(cloudTemplate, packageName, env)
}

/**
 * Every route across the launched frontends that this run meant to serve locally and cannot.
 *
 * Three non-cases matter and are load-bearing:
 *  - a CLOUD-ONLY route (`from: ['cloud']`) is never degraded — it was always going to cloud, by design
 *    (hulyo's `/dynamic` and `/media` are exactly this), and flagging it would cry wolf on every run;
 *  - a route whose backend is UP is not degraded, obviously — that is the happy path;
 *  - a route naming a package this run never intended to serve locally (not in `wanted`, not pinned) is
 *    not degraded: a frontend developing against cloud on purpose is a supported, common workflow.
 *
 * @example
 * findDegradedRoutes({
 *   uis: [{ app: 'client', cloudTemplate: 'https://<env>.hulyo.co.il',
 *           routes: { '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' } } }],
 *   wanted: new Set(['backend-api']), running: new Set(), env: 'dev',
 *   reasons: new Map([['backend-api', { app: 'client', reason: "config is missing field: 'connectionURL'" }]]),
 * })
 * // => [{ uiApp: 'client', route: '/api', packageName: 'backend-api', fallback: 'cloud', apiApp: 'client',
 * //       reason: "config is missing field: 'connectionURL'", cloudTarget: 'https://dev.hulyo.co.il' }]
 */
export const findDegradedRoutes = (input: PairingInputs): DegradedRoute[] => {
  return input.uis.flatMap((ui) => {
    return Object.entries(ui.routes).flatMap(([route, spec]) => {
      const finding = judgeRoute(ui, route, spec, input)

      return finding ? [finding] : []
    })
  })
}

/** The whole rule, for one route: intended local ∧ not up ⇒ degraded. Null when the route is fine. */
const judgeRoute = (
  ui: LaunchedUi,
  route: string,
  spec: PairingRoute,
  { wanted, running, reasons, env }: PairingInputs,
): DegradedRoute | null => {
  const { packageName } = spec
  const intendedLocal = wanted.has(packageName) || spec.pinnedLocal === true

  if (!spec.from.includes('local') || !intendedLocal || running.has(packageName)) return null

  const fallback = resolveFallback(spec)
  const failure = reasons.get(packageName)
  const cloudTarget =
    fallback === 'cloud' && ui.cloudTemplate != null ? interpolateCloud(ui.cloudTemplate, packageName, env) : undefined

  return {
    uiApp: ui.app,
    route,
    packageName,
    fallback,
    apiApp: failure?.app,
    reason: failure?.reason ?? NOT_LAUNCHED,
    cloudTarget,
  }
}

/** One route's resolved proxy destination, for the per-app listing the ready header paints under each UI. */
export interface ResolvedProxyRoute {
  /** Frontend app folder the route belongs to (e.g. `client`). */
  uiApp: string
  /** Route path (e.g. `/api`). */
  route: string
  /** The backend package this route proxies to. */
  packageName: string
  /** Where the route actually resolves — what the vite helper's `pickSource` will return for this run. */
  source: PairingSource
  /**
   * The origin the route resolves to: the running backend's local origin (`local`) or the interpolated
   * cloud origin (`cloud`). Omitted when it is not knowable — a `local` route whose backend is not up (a
   * dead alias, already surfaced as a degraded row) or a `cloud` route with no `<env>` sourced.
   */
  target?: string
}

/** Everything {@link resolveProxyRoutes} needs; every input is passed in, so the mapping stays testable. */
export interface ProxyResolutionInputs {
  /** The frontends this run launched, with their declared `dev.proxy` routes. */
  uis: readonly LaunchedUi[]
  /**
   * Backend packages up FROM THIS RUN. Mirrors — but is not identical to — the vite helper's on-disk
   * `localSet`: this is only what this process launched, so a backend started by another terminal or
   * worktree is invisible here (the same approximation {@link findDegradedRoutes} already makes). Kept in
   * lockstep with the degraded check on purpose, so the two never disagree with each other.
   */
  running: ReadonlySet<string>
  /** A running backend package → its local origin URL, for a `local` route's `target`. */
  localOrigin: (packageName: string) => string | undefined
  /** `INFRA_KIT_ENV`, for the `<env>` placeholder in a cloud template. */
  env?: string
}

/**
 * Resolve EVERY route across the launched frontends to where it actually lands this run — the data the
 * ready header paints as a nested list under each UI app.
 *
 * Deliberately mirrors the vite helper's `pickSource` (a route is `local` iff it lists `local` AND its
 * package is in the running set, else it falls back to `route.default ?? route.from[0]`), so the listing
 * can never disagree with the proxy the frontend actually serves. Unlike {@link findDegradedRoutes} this
 * reports the happy path too: a healthy `local` route and an intentional `cloud` route both get a row.
 *
 * Routes are emitted sorted by path within each UI, so the listing is stable regardless of config order.
 */
export const resolveProxyRoutes = (input: ProxyResolutionInputs): ResolvedProxyRoute[] => {
  const { uis, running, localOrigin, env } = input

  return uis.flatMap((ui) => {
    return Object.entries(ui.routes)
      .sort(([a], [b]) => {
        return a.localeCompare(b)
      })
      .map(([route, spec]): ResolvedProxyRoute => {
        const source: PairingSource =
          spec.from.includes('local') && running.has(spec.packageName) ? 'local' : resolveFallback(spec)
        const target =
          source === 'local' ? localOrigin(spec.packageName) : cloudTargetOf(ui.cloudTemplate, spec.packageName, env)

        return { uiApp: ui.app, route, packageName: spec.packageName, source, target }
      })
  })
}

/** Where this route's traffic is really about to go — the half of the message that must never lie. */
const describeDestination = (d: DegradedRoute): string => {
  if (d.fallback === 'local') {
    // `pickSource` returns `local` for an unserved single-source route, so the proxy dials the alias the
    // backend would have registered — and nothing did. Every request 502s. Loud, but still not what was
    // asked for, and saying "cloud" here would name a destination the traffic never reaches.
    return `would proxy ${d.route} at the local alias for "${d.packageName}", which nothing is serving — every request will fail`
  }

  const to = d.cloudTarget ?? 'the cloud backend'

  return `would proxy ${d.route} to ${to} instead of your local backend`
}

/** Was this backend actually attempted (and it crashed), or did the run never launch it at all? */
const wasAttempted = (d: DegradedRoute): boolean => {
  return d.apiApp != null
}

/**
 * What to actually DO about one finding. The two cases have genuinely different remedies, and conflating
 * them produces advice that cannot work:
 *
 * A CRASHED backend is retryable — `resolveRestartTargets` treats a boot-failed app as a restart target,
 * so `--watch` really can bring it back on the next save (and the vite plugin re-resolves the proxy off
 * the fragment it then writes, flipping the route back to `local` on its own).
 *
 * A backend the run NEVER LAUNCHED is not retryable by any amount of saving: `runRestart` only ever sees
 * the post-`--app`/`--self` app list, so a backend a narrowing flag dropped — or one a preset pinned
 * `local` without ever naming an api target for — is not in it and never will be. Telling that user to
 * "run with --watch" would be sending them to wait on a restart that cannot happen.
 */
const remedy = (d: DegradedRoute): string => {
  if (wasAttempted(d)) return `fix ${d.apiApp}/api and re-run (or use --watch to retry it on the next save)`

  return (
    `this run never launched "${d.packageName}" — drop the --app/--self narrowing, add its api to the ` +
    `preset, or set "${d.route}" to "cloud" if you meant to develop against cloud`
  )
}

/**
 * The refusal message for a run that cannot honour its local pairings. Spelled out rather than summarised:
 * the whole failure mode is that the fallback is invisible, so the refusal names the route, where the
 * traffic would really have gone, why the backend isn't there, and what will actually fix it.
 *
 * `target` is the run's preset/target label, purely so the message can blame the thing the user typed.
 */
export const formatPairingRefusal = (degraded: readonly DegradedRoute[], target: string): string => {
  const lines = degraded.map((d) => {
    const owner = wasAttempted(d) ? `${d.apiApp}/api` : `"${d.packageName}"`

    return (
      `  ${d.uiApp}/ui ${d.route} → ${d.packageName}: ${d.uiApp}/ui ${describeDestination(d)}.\n` +
      `    ${owner}: ${d.reason}\n` +
      `    → ${remedy(d)}`
    )
  })

  return (
    `infra-kit dev: "${target}" is supposed to serve a backend locally, but it is not running — refusing ` +
    `to bring the frontend up silently pointed somewhere else.\n\n${lines.join('\n\n')}`
  )
}
