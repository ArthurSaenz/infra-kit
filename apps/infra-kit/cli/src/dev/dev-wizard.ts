/**
 * Pure core of the interactive `infra-kit dev` wizard (the no-args, TTY path).
 *
 * The wizard is FRONTEND-CENTRIC: you pick which frontends to run, and for each frontend you choose,
 * every proxy route that has TWO real options (its `from` lists both `local` and `cloud`) is decided
 * EXPLICITLY — local (its backend is launched → the route resolves local) or cloud (the route proxies
 * to the `<env>` cloud target). Single-option routes are auto-picked. Because a backend runs local OR
 * cloud as a whole, routes that share one backend package RECONCILE: if any of them resolved local, the
 * backend runs local and all its local-capable routes follow. This module turns those answers into an
 * in-memory {@link DevPreset} the runner consumes verbatim (part-level targets the app-name-only `--app`
 * include cannot express) — and is side-effect-free so the mapping is fully unit-testable. The impure
 * I/O (discovery, inquirer prompts, audit, launch) lives in {@link file://./dev-wizard-run.ts}.
 */
import type { DevPreset, ProxySource } from 'src/lib/infra-kit-config'

/**
 * One proxy route's per-route capability, carried through grouping so the wizard can decide whether it
 * even needs to ask about the route (only a `local`+`cloud` route is a real choice).
 */
export interface RouteCap {
  /** Route path (e.g. `/api`). */
  path: string
  /** `from` includes `local` — the route can resolve to a locally-launched backend. */
  localCapable: boolean
  /** `from` includes `cloud` — the route can resolve to the cloud target. */
  cloudCapable: boolean
  /** The route's declared `default` source when it has one (present iff `from` lists >1 source) — seeds the prompt's default. */
  default?: ProxySource
}

/**
 * One backend a frontend's proxy routes can be pointed at, grouped by the backend package. A frontend
 * that maps `/api` and `/media` to the same package yields ONE {@link ProxyBackend} with both routes —
 * launching the package flips every one of its `local`-capable routes together (the reconcile in
 * {@link deriveManualPlan}).
 */
export interface ProxyBackend {
  /** Backend package name (a route's `packageName`). */
  packageName: string
  /** The routes that resolve to this package, each with its own local/cloud capability. */
  routes: RouteCap[]
  /** True when at least one of `routes` lists `local` in its `from` capabilities — i.e. it is launchable-local. */
  localCapable: boolean
  /** True when at least one of `routes` lists `cloud` — i.e. it can stay on the cloud target. */
  cloudCapable: boolean
  /** App folder whose `api` package is {@link packageName}, or undefined when no discovered app owns it (a `local` choice then has nothing to launch — the audit flags it). */
  ownerApp?: string
}

/** A discovered app as the wizard sees it: which parts exist + which backends its frontend proxies to. */
export interface WizardApp {
  /** App folder name (e.g. `client`). */
  name: string
  /** Has `apps/<app>/api` (a launchable backend). */
  hasApi: boolean
  /** Has `apps/<app>/ui` (a launchable frontend). */
  hasUi: boolean
  /**
   * This app's OWN `api` package name (from `apps/<app>/api`), or undefined when it has no api. Carried
   * so the audit can build a faithful `app → apiPackage` map for EVERY discovered api app — including
   * api-only apps a frontend proxies to cross-app — mirroring the root audit (`preset-proxy-check.ts`).
   */
  apiPackage?: string
  /** Backends this app's frontend proxies to (empty for api-only apps or a frontend with no `dev.proxy`). */
  backends: ProxyBackend[]
}

/** Everything the wizard needs, gathered impurely by {@link file://./dev-wizard-run.ts}. */
export interface WizardModel {
  /** All discovered apps (api and/or ui), sorted by name. */
  apps: WizardApp[]
  /** `devServersPresets` names (drives the preset-or-manual step-0). */
  presets: string[]
  /** Configured `environments` (the cloud-env `select` options). */
  environments: string[]
}

/** The manual-branch answers collected from the prompts, fed to {@link deriveManualPlan}. */
export interface ManualSelection {
  /**
   * The target keys the user ticked directly: every selected `<app>/ui` frontend, plus any api-only
   * `<app>/api` backend (apps with an api but no ui). A full-stack backend is NOT ticked here — it is
   * launched by choosing `local` for one of its frontend's routes (recorded in {@link sources}).
   */
  targets: string[]
  /**
   * Explicit per-route choice for every TWO-OPTION route, keyed `${app}/ui ${routePath}` (e.g.
   * `client/ui /api`). Single-option routes are absent (auto-picked). Missing two-option answers fall
   * back to the route's cloud/local capability in {@link deriveManualPlan}.
   */
  sources: Record<string, ProxySource>
  /** Chosen cloud env for cloud routes (undefined when nothing resolves cloud). */
  env?: string
  /** Rebuild + restart on save. */
  watch: boolean
  /** One cmux pane per app. */
  cmux: boolean
}

/** The resolved run plan derived from a {@link ManualSelection}. */
export interface DerivedPlan {
  /** In-memory preset handed to the runner (`options.presetDef`). */
  presetDef: DevPreset
  /** At least one route resolves to cloud → an env must be chosen (pre-flight gate). */
  anyCloudRoute: boolean
  /** Resolved `<app>/<part>` target keys, sorted — for the echo + audit display. */
  targetKeys: string[]
}

/** App folder name from an `<app>/<part>` target key. */
const appOf = (key: string): string => {
  return key.split('/')[0]!
}

/** Index a model's apps by folder name for O(1) lookup. */
const byName = (model: WizardModel): Map<string, WizardApp> => {
  return new Map(
    model.apps.map((a) => {
      return [a.name, a]
    }),
  )
}

/** Is this route a real choice (both local and cloud reachable)? */
const isTwoOption = (route: RouteCap): boolean => {
  return route.localCapable && route.cloudCapable
}

/**
 * The source a single route resolves to BEFORE per-backend reconciliation:
 *  - two-option: the user's recorded answer, else 'cloud' when cloud-capable else 'local';
 *  - single local-only: always 'local';
 *  - single cloud-only: always 'cloud'.
 */
const rawSource = (uiKey: string, route: RouteCap, sources: Record<string, ProxySource>): ProxySource => {
  if (isTwoOption(route)) {
    return sources[`${uiKey} ${route.path}`] ?? (route.cloudCapable ? 'cloud' : 'local')
  }

  return route.localCapable ? 'local' : 'cloud'
}

/**
 * Pass 1: which backend packages resolve local (any of their routes did), plus each package's owner app.
 * A package's local verdict is shared across every frontend that proxies to it — that is the reconcile.
 */
const collectLocalPackages = (
  uiKeys: string[],
  apps: Map<string, WizardApp>,
  sources: Record<string, ProxySource>,
): { localPkgs: Set<string>; ownerByPkg: Map<string, string | undefined> } => {
  const localPkgs = new Set<string>()
  const ownerByPkg = new Map<string, string | undefined>()

  for (const key of uiKeys) {
    const app = apps.get(appOf(key))

    for (const backend of app?.backends ?? []) {
      ownerByPkg.set(backend.packageName, backend.ownerApp)
      for (const route of backend.routes) {
        if (rawSource(key, route, sources) === 'local') localPkgs.add(backend.packageName)
      }
    }
  }

  return { localPkgs, ownerByPkg }
}

/**
 * Pass 2 for ONE frontend: its per-route overrides after the per-package verdict, and whether any route
 * went cloud. A local-capable route on a local package is `local` (reconciled up); everything else `cloud`.
 */
const frontendOverrides = (
  app: WizardApp | undefined,
  localPkgs: ReadonlySet<string>,
): { overrides: Record<string, ProxySource>; anyCloud: boolean } => {
  const overrides: Record<string, ProxySource> = {}
  let anyCloud = false

  for (const backend of app?.backends ?? []) {
    const backendLocal = localPkgs.has(backend.packageName)

    for (const route of backend.routes) {
      const source: ProxySource = route.localCapable && backendLocal ? 'local' : 'cloud'

      overrides[route.path] = source
      if (source === 'cloud') anyCloud = true
    }
  }

  return { overrides, anyCloud }
}

/**
 * Turn the manual {@link ManualSelection} into an in-memory {@link DevPreset}. The frontend checkbox picks
 * which UIs (and standalone api-only backends) to run; the per-route answers in {@link ManualSelection.sources}
 * decide each two-option route. Resolution is two passes so same-backend routes stay coherent:
 *
 *  1. Resolve every route of every selected frontend to its raw source; a package is LOCAL iff any of its
 *     routes resolved local.
 *  2. Re-resolve each route against that per-package verdict: a local-capable route on a local package is
 *     `local` (reconciled up even if it was individually answered cloud); a cloud-only route stays `cloud`.
 *
 * Launched backends are the ticked api-only parts ∪ every package that resolved local (added as
 * `${ownerApp}/api` when the owner is discoverable — a local override on an owner-less package is still
 * emitted, and the audit flags it).
 *
 * @example
 * // client frontend, its /api answered local → launches client/api + client/ui, /api resolves local:
 * deriveManualPlan(
 *   { targets: ['client/ui'], sources: { 'client/ui /api': 'local' }, watch: false, cmux: false },
 *   { apps: [{ name: 'client', hasApi: true, hasUi: true,
 *              backends: [{ packageName: 'client-api', cloudCapable: true, localCapable: true,
 *                           routes: [{ path: '/api', localCapable: true, cloudCapable: true }],
 *                           ownerApp: 'client' }] }],
 *     presets: [], environments: ['dev'] },
 * ).targetKeys // => ['client/api', 'client/ui']
 */
export const deriveManualPlan = (selection: ManualSelection, model: WizardModel): DerivedPlan => {
  const apps = byName(model)
  const uiKeys = selection.targets.filter((t) => {
    return t.endsWith('/ui')
  })
  const apiOnlyKeys = selection.targets.filter((t) => {
    return t.endsWith('/api')
  })

  // Pass 1: a package is local iff any of its routes (across every selected frontend) resolved local.
  const { localPkgs, ownerByPkg } = collectLocalPackages(uiKeys, apps, selection.sources)

  // Pass 2: re-resolve each route against the per-package verdict + build per-frontend overrides.
  const presetApps: Record<string, { proxy?: Record<string, ProxySource> }> = {}
  let anyCloud = false

  for (const key of uiKeys) {
    const { overrides, anyCloud: cloud } = frontendOverrides(apps.get(appOf(key)), localPkgs)

    if (cloud) anyCloud = true
    presetApps[key] = Object.keys(overrides).length > 0 ? { proxy: overrides } : {}
  }

  // Launch: the ticked api-only backends, plus every package that resolved local (via its owner app).
  for (const key of apiOnlyKeys) {
    presetApps[key] ??= {}
  }
  for (const pkg of localPkgs) {
    const owner = ownerByPkg.get(pkg)

    if (owner != null) presetApps[`${owner}/api`] ??= {}
  }

  return {
    presetDef: { apps: presetApps, cmux: selection.cmux },
    anyCloudRoute: anyCloud,
    targetKeys: Object.keys(presetApps).sort(),
  }
}

/** The equivalent non-interactive command for a derived plan. */
export interface EquivalentCommand {
  /** The `--target=<app>/<part>,…`-form flag string (no leading `infra-kit dev`). */
  flags: string
}

/**
 * Build the equivalent `infra-kit dev --target=… [--watch] [--cmux]` flag string for a derived plan.
 * Always exact: `--target` names packages at `<app>/<part>` granularity — the same grammar the plan's
 * `targetKeys` already use — so every wizard selection, whole-app or part-level, round-trips into a
 * pasteable command. (`--app` is deliberately NOT used here: its app-name granularity over-launches a
 * part-level pick — `--app=client` starts `client/api` even when only `client/ui` was ticked.)
 */
export const equivalentCommand = (plan: DerivedPlan, selection: ManualSelection): EquivalentCommand => {
  const parts = [`--target=${plan.targetKeys.join(',')}`]

  if (selection.watch) parts.push('--watch')
  if (selection.cmux) parts.push('--cmux')

  return { flags: parts.join(' ') }
}
