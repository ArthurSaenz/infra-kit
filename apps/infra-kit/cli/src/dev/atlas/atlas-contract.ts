import type { HealthState } from '../render.js'

/**
 * The `/__atlas/state.json` wire shape. The page that reads it ships in this same package, so the version
 * guards only a page left open across a CLI self-update.
 */
export const ATLAS_CONTRACT_VERSION = 1

/** What the page posts to `/__atlas/open` for the run's log folder; a log is named by its `service`. */
export const ATLAS_RUN_FOLDER_ID = 'run-folder'

export type AtlasReason =
  /** A fragment for the package is live (this run or another runner). */
  | 'local'
  /** This run is booting the backend and has not written its fragment yet. */
  | 'starting'
  /** `route.from` has no `'local'`. */
  | 'cloud-only'
  /** Local-capable, not up, not launched by this run: fell back. */
  | 'not-running'
  /** This run launched it and it failed: held local (`--watch`) or fell back. */
  | 'launched-failed'
  /** Falls back to `'local'` (`from: ['local']`, no default) and nothing serves the alias. */
  | 'local-unserved'
  /** Source cloud, `deployedUrlEnv` not loaded. */
  | 'cloud-unset'

export type AtlasServed = 'match' | 'differs' | 'user-proxy' | 'unknown'

export interface AtlasLog {
  service: string
  path: string
  href: string
  exists: boolean
}

export interface AtlasRoute {
  path: string
  packageName: string
  source: 'local' | 'cloud'
  target: { kind: 'backend' | 'cloud'; id: string } | null
  reason: AtlasReason
  /** `'unknown'` on every site but the viewer's: only that site's vite reported what it serves. */
  served: AtlasServed
}

export interface AtlasSite {
  id: string
  app: string
  packageName: string
  host: string | null
  health: HealthState
  log: AtlasLog
  routes: AtlasRoute[]
}

export interface AtlasBackend {
  id: string
  app: string | null
  host: string | null
  health: HealthState
  owner: 'this-run' | 'other-runner'
  log: AtlasLog | null
}

export interface AtlasSnapshot {
  v: typeof ATLAS_CONTRACT_VERSION
  /** sha256 of the snapshot minus `generatedAt`; the ETag. */
  revision: string
  generatedAt: string
  run: { pid: number; logDir: string; logDirHref: string }
  /** From the site header the forwarder sets. */
  viewer: { siteId: string | null }
  sites: AtlasSite[]
  backends: AtlasBackend[]
  clouds: Array<{ id: string; host: string }>
  /** runner, turbo, watch */
  logs: AtlasLog[]
}
