/**
 * Pure core of the interactive `infra-kit dev` wizard (the no-args, TTY path).
 *
 * The wizard is FRONTEND-CENTRIC: you pick apps to run, and for each frontend you choose, per backend
 * it proxies to, whether that backend runs LOCALLY (its `/api` is launched → the route resolves local)
 * or stays CLOUD (not launched → the route proxies to the `<env>` cloud target). A backend runs iff a
 * frontend points at it locally, or its app is selected and not demoted to cloud. This module turns
 * those answers into an in-memory {@link DevPreset} the runner consumes verbatim (part-level targets
 * that the app-name-only `--app` include cannot express) — and is side-effect-free so the mapping is
 * fully unit-testable. The impure I/O (discovery, inquirer prompts, audit, launch) lives in
 * {@link file://./dev-wizard-run.ts}.
 */
import type { DevPreset, ProxySource } from 'src/lib/infra-kit-config'

/**
 * One backend a frontend's proxy routes can be pointed at, grouped by the backend package. A frontend
 * that maps `/api` and `/media` to the same package yields ONE {@link ProxyBackend} with both routes —
 * launching the package flips every one of its `local`-capable routes together (see `pickSource`).
 */
export interface ProxyBackend {
  /** Backend package name (a route's `packageName`). */
  packageName: string
  /** Route paths that resolve to this package (for display + the audit's per-route overrides). */
  routes: string[]
  /** True when at least one of `routes` lists `local` in its `from` capabilities — i.e. it is toggleable. A `false` backend is fixed-cloud, shown as info. */
  localCapable: boolean
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
   * The `<app>/<part>` target keys the user ticked directly (e.g. `client/ui`, `client/api`). A frontend's
   * proxy route resolves LOCAL iff the backend's owner-api part is in this set — otherwise CLOUD — so the
   * part checkbox IS the local/cloud decision; there is no separate per-backend question.
   */
  targets: string[]
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

/**
 * Resolve ONE selected frontend's proxy routes against the set of api parts the user ticked: a route is
 * `local` iff its backend is `localCapable` AND that backend's owner-api part was selected — otherwise
 * `cloud`. Kept separate from {@link deriveManualPlan} so the per-app override loop stays flat.
 */
const resolveUiProxy = (
  app: WizardApp,
  selectedApiApps: ReadonlySet<string>,
): { overrides: Record<string, ProxySource>; anyCloud: boolean } => {
  const overrides: Record<string, ProxySource> = {}
  let anyCloud = false

  for (const backend of app.backends) {
    const isLocal = backend.localCapable && backend.ownerApp != null && selectedApiApps.has(backend.ownerApp)

    if (!isLocal) anyCloud = true
    for (const route of backend.routes) {
      overrides[route] = isLocal ? 'local' : 'cloud'
    }
  }

  return { overrides, anyCloud }
}

/**
 * Turn a part-level {@link ManualSelection} into an in-memory {@link DevPreset}. Because the user picks
 * `<app>/<part>` targets directly, the mapping is straightforward:
 *  - every selected `<app>/ui` runs that frontend;
 *  - every selected `<app>/api` runs that backend locally;
 *  - each frontend's proxy route resolves `local` iff the backend's owner-api part was also selected
 *    (even cross-app), else `cloud` — i.e. ticking the api part IS the local choice.
 *
 * @example
 * // client frontend only (its /api left unticked → its proxy route resolves to cloud):
 * deriveManualPlan(
 *   { targets: ['client/ui'], watch: false, cmux: false },
 *   { apps: [{ name: 'client', hasApi: true, hasUi: true,
 *              backends: [{ packageName: 'client-api', routes: ['/api'], localCapable: true, ownerApp: 'client' }] }],
 *     presets: [], environments: ['dev'] },
 * ).targetKeys // => ['client/ui']
 */
export const deriveManualPlan = (selection: ManualSelection, model: WizardModel): DerivedPlan => {
  const apps = byName(model)
  const uiKeys = selection.targets.filter((t) => {
    return t.endsWith('/ui')
  })
  const apiApps = new Set(
    selection.targets
      .filter((t) => {
        return t.endsWith('/api')
      })
      .map(appOf),
  )

  const presetApps: Record<string, { proxy?: Record<string, ProxySource> }> = {}
  let anyCloud = false

  for (const key of uiKeys) {
    const app = apps.get(appOf(key))
    const { overrides, anyCloud: cloud } = app ? resolveUiProxy(app, apiApps) : { overrides: {}, anyCloud: false }

    if (cloud) anyCloud = true
    presetApps[key] = Object.keys(overrides).length > 0 ? { proxy: overrides } : {}
  }
  for (const name of apiApps) {
    presetApps[`${name}/api`] ??= {}
  }

  return {
    presetDef: { apps: presetApps, cmux: selection.cmux },
    anyCloudRoute: anyCloud,
    targetKeys: Object.keys(presetApps).sort(),
  }
}

/** The equivalent non-interactive command, plus whether it reproduces the selection exactly. */
export interface EquivalentCommand {
  /** The `--app=…`-form flag string (no leading `infra-kit dev`). */
  flags: string
  /**
   * True when `--app` reproduces the plan exactly — i.e. every involved app runs ALL the parts it has.
   * False for a part-level selection (e.g. frontend-only), which `--app` (app-name granularity) cannot
   * express; the caller then hints "save as a preset" for exact reproduction.
   */
  exact: boolean
}

/**
 * Build the equivalent `infra-kit dev --app=… [--watch] [--cmux]` flag string for a derived plan.
 * `exact` is true only when the target set covers every part each involved app HAS (a whole-app
 * selection), since `--app` filters by app name, not part.
 */
export const equivalentCommand = (
  plan: DerivedPlan,
  selection: ManualSelection,
  model: WizardModel,
): EquivalentCommand => {
  const apps = byName(model)
  const involved = [...new Set(plan.targetKeys.map(appOf))].sort()
  const present = new Set(plan.targetKeys)

  const exact = involved.every((name) => {
    const app = apps.get(name)

    if (!app) return false

    const uiOk = !app.hasUi || present.has(`${name}/ui`)
    const apiOk = !app.hasApi || present.has(`${name}/api`)

    return uiOk && apiOk
  })

  const parts = [`--app=${involved.join(',')}`]

  if (selection.watch) parts.push('--watch')
  if (selection.cmux) parts.push('--cmux')

  return { flags: parts.join(' '), exact }
}
