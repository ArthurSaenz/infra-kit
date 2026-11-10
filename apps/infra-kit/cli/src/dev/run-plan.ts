import process from 'node:process'
import { z } from 'zod'

import { agentMode } from 'src/lib/agent-mode'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

import { planAppRun } from './app-plan.js'
import { discoverApiApps as discoverApiAppsBare, discoverUiApps as discoverUiAppsBare } from './discovery.js'
import type { DiscoveredUiApp } from './discovery.js'
import { DEFAULT_PREFIX_URL, resolvePreferredPort as resolvePreferredPortPure } from './ports.js'
import { resolvePreset } from './presets.js'
import type { DevPreset, DiscoveredParts, ProxySource } from './presets.js'
import type { DevServerOptions, IApiAppConfig, LogFn } from './runner-types.js'

/** What planning a run reads from the runner: its options, where the repo is, and a way to warn. */
export interface RunPlanContext {
  options: DevServerOptions
  monorepoRoot: string
  log: LogFn
}

/**
 * Discover API apps and resolve each app's port. Delegates bare filesystem discovery to
 * {@link discoverApiAppsBare} and per-app resolution to the pure `resolvePreferredPort` of `ports.ts`.
 */
const discoverApiApps = (monorepoRoot: string): IApiAppConfig[] => {
  return discoverApiAppsBare(monorepoRoot).map((app) => {
    return {
      ...app,
      preferredPort: resolvePreferredPortPure(app.name, process.env),
      // Resolved alongside, never instead: which of the two wins is decided in `resolveRunPlan`,
      // once the number of apps this run launches is known. See `IApiAppConfig.appScopedPort`.
      appScopedPort: resolvePreferredPortPure(app.name, process.env, false),
      prefixUrl: DEFAULT_PREFIX_URL,
    }
  })
}

/**
 * The plan to run: the in-memory one (wizard / `--target`), else the app plan for `infra-kit dev <app>`
 * (see {@link planAppRun}), or an `apps`-less plan when no app was given — which `resolvePreset` expands
 * to every discovered app + part.
 */
const resolvePresetDef = async (
  ctx: RunPlanContext,
  apiApps: IApiAppConfig[],
  uiApps: DiscoveredUiApp[],
): Promise<DevPreset> => {
  if (ctx.options.presetDef != null) {
    return ctx.options.presetDef
  }

  const name = ctx.options.app

  if (name == null) {
    return {}
  }

  const plan = await planAppRun(name, apiApps, uiApps)

  if (plan) {
    if (plan.unprovided.length > 0) {
      ctx.log(
        `⚠️  No apps/*/api provides these local-capable routes, so they stay on cloud: ${plan.unprovided.join(', ')}`,
        'warn',
      )
    }

    return plan.preset
  }

  const [first, ...rest] = [
    ...new Set(
      [...apiApps, ...uiApps]
        .map((app) => {
          return app.name
        })
        .toSorted(),
    ),
  ]

  if (first === undefined) {
    throw new OperationError(undefined, {
      operation: `run "${name}"`,
      remediation: 'omit the name to run every app',
      stderrExcerpt: 'no apps were discovered',
    })
  }

  // App names are per-repo, so an agent gets them as choices instead of guessing again.
  throw new StructuredRefusalError(
    {
      status: 'argument_required',
      argument: 'app',
      choices: z.toJSONSchema(z.object({ app: z.enum([first, ...rest]) })),
      agentMode: agentMode.source,
    },
    2,
    {
      operation: 'pick what infra-kit dev runs',
      remediation: `pass an app: ${[first, ...rest].join(', ')}`,
      stderrExcerpt: `"${name}" is not an app`,
    },
  )
}

/**
 * Resolve WHAT to run: discover the api/ui app parts, resolve the active plan against them, then
 * narrow to the `--app`/`--self` include set. Returns both the filtered run sets (`apps`/`uiApps`)
 * and the full discovered sets (`apiAppsAll`/`uiAppsAll`), which the ready-header target label needs.
 */
export const resolveRunPlan = async (
  ctx: RunPlanContext,
  include: string[] | null,
): Promise<{
  apps: IApiAppConfig[]
  uiApps: DiscoveredUiApp[]
  apiAppsAll: IApiAppConfig[]
  uiAppsAll: DiscoveredUiApp[]
  /**
   * Backend packages the PLAN promised to serve locally, captured BEFORE `--app`/`--self` narrowing.
   * Narrowing changes what runs; it does not change what the plan promised, and a backend dropped by
   * a narrowing flag is never attempted — so it never lands in `failedApps` and a crash-keyed check
   * would say nothing while its frontend quietly proxied to cloud. See `local-pairing.ts`.
   */
  wantedLocalPkgs: Set<string>
  /** The plan's declared per-route proxy pins (`app → route → source`), for `pinnedLocal`. */
  presetProxy: Record<string, Record<string, ProxySource>>
}> => {
  // The plan is resolved against the discovered app parts (api/ui). No plan → run everything (`*`).
  // `--app`/`--self` (`include`) further narrow it.
  const apiAppsAll = discoverApiApps(ctx.monorepoRoot)
  const uiAppsAll = discoverUiAppsBare(ctx.monorepoRoot)
  const presetDef = await resolvePresetDef(ctx, apiAppsAll, uiAppsAll)

  const discovered: DiscoveredParts = {
    api: apiAppsAll.map((a) => {
      return a.name
    }),
    ui: uiAppsAll.map((a) => {
      return a.name
    }),
  }

  const resolved = resolvePreset(presetDef, discovered)

  if (resolved.unmatched.length > 0) {
    ctx.log(`⚠️  Targets not found (skipped): ${resolved.unmatched.join(', ')}`, 'warn')
  }

  const apiNames = new Set(
    resolved.targets
      .filter((t) => {
        return t.part === 'api'
      })
      .map((t) => {
        return t.app
      }),
  )

  const uiNames = new Set(
    resolved.targets
      .filter((t) => {
        return t.part === 'ui'
      })
      .map((t) => {
        return t.app
      }),
  )

  const passesInclude = (name: string): boolean => {
    return !include || include.includes(name)
  }

  // Split from the map below so the SURVIVOR COUNT is known before each app's port is chosen. The
  // choice cannot be made where the ports are resolved (`discoverApiApps`, over the full discovered
  // set): hulyo has 7 api apps, so a count taken there is never 1 even for `--app=client`.
  const selected = apiAppsAll.filter((a) => {
    return apiNames.has(a.name) && passesInclude(a.name)
  })

  const apps = selected.map((a) => {
    return {
      ...a,
      // One app → today's precedence exactly, bare `PORT` included. Two or more → the shared bare
      // `PORT` is dropped and each app falls to `{APP}_PORT` or an ephemeral bind, so a stray
      // `PORT` in the shell can no longer manufacture the conflict that refuses the whole run.
      preferredPort: selected.length === 1 ? a.preferredPort : a.appScopedPort,
    }
  })

  const uiApps = uiAppsAll.filter((a) => {
    return uiNames.has(a.name) && passesInclude(a.name)
  })

  // Every api the PLAN names, pre-`passesInclude` — the promise, not the survivors.
  const wantedLocalPkgs = new Set(
    apiAppsAll
      .filter((a) => {
        return apiNames.has(a.name)
      })
      .map((a) => {
        return a.packageName
      }),
  )

  return { apps, uiApps, apiAppsAll, uiAppsAll, wantedLocalPkgs, presetProxy: resolved.proxy }
}
