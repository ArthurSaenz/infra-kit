import { loadDev } from '@slip-stream-kit/config/internal'

import type { DevPreset, ProxySource } from 'src/lib/infra-kit-config'

interface PlanApi {
  name: string
  packageName: string
}

interface PlanUi {
  name: string
  path: string
}

export interface AppPlan {
  /** The run plan, in the shape a `devServersPresets` entry has — the runner treats it as one. */
  preset: DevPreset
  /** `<route> (<package>)` for routes that could run locally, but no `apps/*\/api` provides their backend. */
  unprovided: string[]
}

/**
 * What `infra-kit dev <app>` runs: the app's own parts, plus every backend its UI's proxy routes can run
 * locally (`from` includes `local`), with those routes pinned `local`. Derived from the routes rather than
 * written as a preset, so `dev backoffice` brings up the cronjob backend its `/api/v1/cronjob` route needs
 * without anyone having to keep a preset in step with the config.
 *
 * @returns `null` when no `apps/<app>/api` or `apps/<app>/ui` was discovered.
 */
export const planAppRun = async (app: string, apiApps: PlanApi[], uiApps: PlanUi[]): Promise<AppPlan | null> => {
  const ownApi = apiApps.find((api) => {
    return api.name === app
  })
  const ui = uiApps.find((candidate) => {
    return candidate.name === app
  })

  if (!ownApi && !ui) return null

  const apps: NonNullable<DevPreset['apps']> = {}
  const unprovided: string[] = []

  if (ownApi) apps[`${app}/api`] = {}

  if (ui) {
    const pins: Record<string, ProxySource> = {}

    for (const [routePath, route] of Object.entries((await loadDev(ui.path))?.proxy?.routes ?? {})) {
      if (!route.from.includes('local')) continue

      const backend = apiApps.find((api) => {
        return api.packageName === route.packageName
      })

      if (!backend) {
        unprovided.push(`${routePath} (${route.packageName})`)
        continue
      }

      apps[`${backend.name}/api`] = {}
      pins[routePath] = 'local'
    }

    apps[`${app}/ui`] = Object.keys(pins).length > 0 ? { proxy: pins } : {}
  }

  return { preset: { apps }, unprovided }
}
