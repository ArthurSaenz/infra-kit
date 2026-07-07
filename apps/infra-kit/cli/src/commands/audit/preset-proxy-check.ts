/**
 * Root-audit check for `devPresets` proxy locality.
 *
 * Bridges the impure world (project config + discovery + each frontend's loaded
 * `infra-kit.config.ts`) to the pure {@link validatePresetProxy} rule, then shapes
 * the result as a {@link PackageValidationResult} so it slots into the existing
 * `infra-kit audit --root` output. Skipped (returns null) when the project declares
 * no `devPresets`.
 */
import path from 'node:path'

import { discoverApiApps, discoverUiApps } from 'src/dev/discovery'
import { resolvePreset, validatePresetProxy } from 'src/dev/presets'
import type { DiscoveredParts, PresetProxyContext } from 'src/dev/presets'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { DevPresets } from 'src/lib/infra-kit-config'
import type { PackageCheck, PackageValidationResult } from 'src/lib/package-validator'
import { loadDev } from 'src/lib/vite/vite'

/** A frontend config that a preset references but that failed to load (bad/invalid config). */
interface LoadError {
  app: string
  message: string
}

interface RoutePkgLookup {
  routePkg: PresetProxyContext['routePkg']
  loadErrors: LoadError[]
}

/**
 * The set of frontend app folders any preset's proxy override actually references —
 * the only configs the audit needs to load. Scoping to these keeps an unrelated
 * broken frontend config from failing (or crashing) the devPresets audit.
 */
const collectReferencedApps = (presets: DevPresets, discovered: DiscoveredParts): string[] => {
  const apps = new Set<string>()

  for (const preset of Object.values(presets)) {
    for (const app of Object.keys(resolvePreset(preset, discovered).proxy)) {
      apps.add(app)
    }
  }

  return [...apps]
}

/**
 * Load each referenced frontend's `dev.proxy.routes` into a sync `(app, route) → pkg`
 * lookup. A config that throws (schema-invalid, import error) is captured as a
 * {@link LoadError} instead of rejecting, so one bad config yields an actionable
 * audit line rather than crashing the whole `audit --root`.
 */
const buildRoutePkgLookup = async (root: string, apps: string[]): Promise<RoutePkgLookup> => {
  const routesByApp: Record<string, Record<string, string>> = {}
  const loadErrors: LoadError[] = []

  await Promise.all(
    apps.map(async (app) => {
      try {
        const dev = await loadDev(path.join(root, 'apps', app, 'ui'))
        const routes = dev?.proxy?.routes

        if (!routes) return

        routesByApp[app] = Object.fromEntries(
          Object.entries(routes).map(([route, route_]) => {
            return [route, route_.packageName]
          }),
        )
      } catch (error) {
        loadErrors.push({ app, message: error instanceof Error ? error.message : String(error) })
      }
    }),
  )

  return {
    routePkg: (app, route) => {
      return routesByApp[app]?.[route]
    },
    loadErrors,
  }
}

/** Shape validator issues + config load errors into audit check lines (fail-only; caller adds the pass line). */
const toFailChecks = (issues: ReturnType<typeof validatePresetProxy>, loadErrors: LoadError[]): PackageCheck[] => {
  return [
    ...loadErrors.map((error): PackageCheck => {
      return {
        name: `devPresets:config:${error.app}`,
        status: 'fail',
        message: `could not load apps/${error.app}/ui/infra-kit.config.ts (referenced by a preset proxy override): ${error.message}`,
      }
    }),
    ...issues.map((issue): PackageCheck => {
      return { name: `devPresets:${issue.preset}`, status: 'fail', message: issue.message }
    }),
  ]
}

/**
 * Run the `devPresets` proxy-locality audit for the monorepo root. Returns a
 * synthetic `devPresets` validation result (one pass line, or one fail line per
 * violation / unloadable referenced config), or null when there are no presets to
 * check.
 *
 * @example
 * const result = await checkDevPresets('/repo')
 * // result?.checks[0] => { name: 'devPresets:proxy-locality', status: 'pass', message: '…' }
 */
export const checkDevPresets = async (root: string): Promise<PackageValidationResult | null> => {
  const presets = (await getInfraKitConfig()).devPresets

  if (!presets || Object.keys(presets).length === 0) {
    return null
  }

  const apiApps = discoverApiApps(root)
  const uiApps = discoverUiApps(root)
  const discovered: DiscoveredParts = {
    api: apiApps.map((a) => {
      return a.name
    }),
    ui: uiApps.map((a) => {
      return a.name
    }),
  }

  const { routePkg, loadErrors } = await buildRoutePkgLookup(root, collectReferencedApps(presets, discovered))

  const ctx: PresetProxyContext = {
    discovered,
    apiPkgByApp: Object.fromEntries(
      apiApps.map((a) => {
        return [a.name, a.packageName]
      }),
    ),
    routePkg,
  }

  const failChecks = toFailChecks(validatePresetProxy(presets, ctx), loadErrors)

  const checks: PackageCheck[] =
    failChecks.length === 0
      ? [
          {
            name: 'devPresets:proxy-locality',
            status: 'pass',
            message: 'every local proxy override resolves to a backend the preset launches',
          },
        ]
      : failChecks

  return { packageDir: root, packageName: 'devPresets', checks, passed: failChecks.length === 0 }
}
