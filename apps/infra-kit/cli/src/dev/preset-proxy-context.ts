/**
 * Assembles the impure {@link PresetProxyContext} `validatePresetProxy` needs, so the STATIC
 * proxy-locality rule in `presets.ts` never has to touch the filesystem or `loadDev` itself.
 *
 * Shared by two callers that must never disagree about what "satisfiable" means:
 *  - `infra-kit audit` (`commands/audit/preset-proxy-check.ts`) — checks every preset.
 *  - `infra-kit dev <preset>` (`dev-server.ts`) — checks only the one preset about to run, BEFORE
 *    any server spawns.
 */
import { loadDev } from '@slip-stream-kit/config/internal'
import path from 'node:path'

import { resolvePreset } from 'src/dev/presets'
import type { DiscoveredParts, PresetProxyContext } from 'src/dev/presets'
import type { DevPresets } from 'src/lib/infra-kit-config'

/** A frontend config that a preset references but that failed to load (bad/invalid config). */
export interface LoadError {
  app: string
  message: string
}

interface RoutePkgLookup {
  routePkg: PresetProxyContext['routePkg']
  loadErrors: LoadError[]
}

/**
 * The set of frontend app folders any preset's proxy override actually references —
 * the only configs the caller needs to load. Scoping to these keeps an unrelated
 * broken frontend config from failing (or crashing) a check it was never relevant to.
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
 * result rather than crashing the whole check.
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

/** Result of {@link buildPresetProxyContext}: the assembled context, plus any config that failed to load. */
export interface PresetProxyContextResult {
  ctx: PresetProxyContext
  loadErrors: LoadError[]
}

/**
 * Build the {@link PresetProxyContext} `validatePresetProxy` needs for `presets`: a sync
 * `(app, route) → pkg` lookup from each referenced frontend's `infra-kit.config.ts`
 * (the SAME file, through the same `loadDev`, that the vite helper resolves at runtime), plus
 * the api package name for every discovered api app.
 *
 * @example
 * const { ctx, loadErrors } = await buildPresetProxyContext('/repo', presets, discovered, apiApps)
 * const issues = validatePresetProxy(presets, ctx)
 */
export const buildPresetProxyContext = async (
  root: string,
  presets: DevPresets,
  discovered: DiscoveredParts,
  apiApps: { name: string; packageName: string }[],
): Promise<PresetProxyContextResult> => {
  const { routePkg, loadErrors } = await buildRoutePkgLookup(root, collectReferencedApps(presets, discovered))

  return {
    ctx: {
      discovered,
      apiPkgByApp: Object.fromEntries(
        apiApps.map((a) => {
          return [a.name, a.packageName]
        }),
      ),
      routePkg,
    },
    loadErrors,
  }
}
