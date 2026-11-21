import type { InfraKitDevProxy, InfraKitDevProxyRoute } from '@slip-stream-kit/config'
import { describeProxyRoutes } from '@slip-stream-kit/config/internal'
import type { CloudOrigin, LocalContext, ProxyRouteDescription } from '@slip-stream-kit/config/internal'
import { createHash } from 'node:crypto'

import type { HealthState } from '../render.js'
import { ATLAS_CONTRACT_VERSION } from './atlas-contract.js'
import type {
  AtlasBackend,
  AtlasLog,
  AtlasReason,
  AtlasRoute,
  AtlasServed,
  AtlasSite,
  AtlasSnapshot,
} from './atlas-contract.js'

/** What the viewer's vite holds per proxy key, as the forwarder's served-routes header reports it. */
// A Map, not an object: the keys come from a request header, and `__proto__` as an object key rewires the prototype.
export type ServedRoutes = ReadonlyMap<string, { host: string | null; user: boolean }>

/** Which packages this run launched, and how each one is doing right now. */
export interface AtlasRunFacts {
  /** Bound a port and serve (the runner's `appServers`). */
  running: ReadonlySet<string>
  /** Threw at start, held local or fallen back (`failedApps`, `heldLocalPkgs`). */
  failed: ReadonlySet<string>
  /** Every backend this run planned; one in neither set above is still booting. */
  booting: ReadonlySet<string>
}

export interface AtlasSiteInput {
  app: string
  packageName: string
  host: string | null
  health: HealthState
  logPath: string
  proxy: InfraKitDevProxy | undefined
  localContext: LocalContext
  /** `INFRA_KIT_ENV` as the UI's vite reads it, after its `dev.env`. */
  env: string | undefined
  cloud: CloudOrigin
  getRelease: () => string
}

/** A backend this run launched. */
export interface AtlasBackendInput {
  app: string
  packageName: string
  host: string | null
  health: HealthState
  logPath: string
}

export interface AtlasSnapshotInputs {
  pid: number
  logDir: string
  sites: readonly AtlasSiteInput[]
  backends: readonly AtlasBackendInput[]
  facts: AtlasRunFacts
  logs: ReadonlyArray<{ service: string; path: string }>
  exists: (path: string) => boolean
  viewer: { siteId: string | null }
  served: ServedRoutes | null
  now: Date
}

export const vscodeHref = (path: string): string => {
  return `vscode://file${encodeURI(path)}`
}

/** Hostname only: a target can carry userinfo, a port, a path or a query, and none of it may reach the page. */
export const hostOnly = (value: string | null | undefined): string | null => {
  if (!value) return null

  try {
    return new URL(value).hostname || null
  } catch {
    return null
  }
}

/** The first rule that matches wins; the order is the plan's derivation table. */
export const deriveReason = (
  d: ProxyRouteDescription,
  spec: InfraKitDevProxyRoute,
  facts: AtlasRunFacts,
  localPackages: ReadonlySet<string>,
): AtlasReason => {
  const pkg = d.packageName

  if (!spec.from.includes('local')) return 'cloud-only'
  if (facts.failed.has(pkg)) return 'launched-failed'
  if (facts.booting.has(pkg) && !facts.running.has(pkg)) return 'starting'
  if (d.source === 'local') return localPackages.has(pkg) ? 'local' : 'local-unserved'

  return d.target === null ? 'cloud-unset' : 'not-running'
}

/**
 * The forwarder already reports, per key, the key that WINS in vite, so a user `/` shadowing `/api` arrives
 * as `/api: { user: true }` and needs no matching here.
 */
export const deriveServed = (
  routes: ReadonlyArray<Pick<ProxyRouteDescription, 'path' | 'target'>>,
  served: ServedRoutes | null,
): AtlasServed[] => {
  return routes.map((route) => {
    const entry = served?.get(route.path)

    if (entry === undefined) return 'unknown'

    if (entry.user) return 'user-proxy'

    return entry.host === hostOnly(route.target) ? 'match' : 'differs'
  })
}

const isServedEntry = (value: unknown): value is { host: string | null; user: boolean } => {
  if (typeof value !== 'object' || value === null) return false

  const { host, user } = value as Record<string, unknown>

  return (host === null || typeof host === 'string') && typeof user === 'boolean'
}

/** `null` for an absent or malformed header, which reads as "this vite did not say" (`unknown`). */
export const parseServedRoutes = (raw: string | undefined): ServedRoutes | null => {
  if (!raw) return null

  let value: unknown

  try {
    value = JSON.parse(decodeURIComponent(raw))
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const routes = new Map<string, { host: string | null; user: boolean }>()

  for (const [key, entry] of Object.entries(value)) {
    if (!isServedEntry(entry)) return null
    // Re-reduced here: the header is a request input, and the snapshot promises hostnames only.
    routes.set(key, { host: entry.host === null ? null : hostOnly(`https://${entry.host}`), user: entry.user })
  }

  return routes
}

const atlasLog = (service: string, path: string, exists: (path: string) => boolean): AtlasLog => {
  return { service, path, href: vscodeHref(path), exists: exists(path) }
}

const routeTarget = (d: ProxyRouteDescription, backendIds: ReadonlySet<string>): AtlasRoute['target'] => {
  if (d.source === 'cloud') {
    const host = hostOnly(d.target)

    return host === null ? null : { kind: 'cloud', id: host }
  }

  return backendIds.has(d.packageName) ? { kind: 'backend', id: d.packageName } : null
}

const describeSite = (site: AtlasSiteInput): ProxyRouteDescription[] => {
  if (!site.proxy) return []

  // No `authHeader`: the description carries targets only, and a credential has no reason to be computed.
  return describeProxyRoutes({
    proxy: site.proxy,
    localContext: site.localContext,
    env: site.env,
    cloud: site.cloud,
    getRelease: site.getRelease,
  })
}

const collectBackends = (inputs: AtlasSnapshotInputs): AtlasBackend[] => {
  const backends = new Map<string, AtlasBackend>()

  for (const backend of inputs.backends) {
    backends.set(backend.packageName, {
      id: backend.packageName,
      app: backend.app,
      host: backend.host,
      health: backend.health,
      owner: 'this-run',
      log: atlasLog(`${backend.app}/api`, backend.logPath, inputs.exists),
    })
  }

  for (const site of inputs.sites) {
    for (const pkg of site.localContext.packages) {
      if (backends.has(pkg)) continue

      // Another runner's backend: its health and its log belong to that runner.
      backends.set(pkg, {
        id: pkg,
        app: null,
        host: hostOnly(site.localContext.info.get(pkg)?.origin),
        health: 'unknown',
        owner: 'other-runner',
        log: null,
      })
    }
  }

  return [...backends.values()].toSorted((a, b) => {
    return a.id.localeCompare(b.id)
  })
}

const buildSite = (site: AtlasSiteInput, inputs: AtlasSnapshotInputs, backendIds: ReadonlySet<string>): AtlasSite => {
  const described = describeSite(site)
  const isViewer = inputs.viewer.siteId === site.packageName
  const served = deriveServed(described, isViewer ? inputs.served : null)

  return {
    id: site.packageName,
    app: site.app,
    packageName: site.packageName,
    host: site.host,
    health: site.health,
    log: atlasLog(`${site.app}/ui`, site.logPath, inputs.exists),
    routes: described.map((d, index): AtlasRoute => {
      return {
        path: d.path,
        packageName: d.packageName,
        source: d.source,
        target: routeTarget(d, backendIds),
        reason: deriveReason(d, site.proxy!.routes[d.path]!, inputs.facts, site.localContext.packages),
        served: served[index] ?? 'unknown',
      }
    }),
  }
}

const collectClouds = (sites: readonly AtlasSiteInput[]): AtlasSnapshot['clouds'] => {
  const hosts = new Set<string>()

  for (const site of sites) {
    const host = hostOnly(site.cloud.url)

    if (host !== null) hosts.add(host)
  }

  return [...hosts].toSorted().map((host) => {
    return { id: host, host }
  })
}

export const buildAtlasSnapshot = (inputs: AtlasSnapshotInputs): AtlasSnapshot => {
  const backends = collectBackends(inputs)

  const backendIds = new Set(
    backends.map((b) => {
      return b.id
    }),
  )

  const body: Omit<AtlasSnapshot, 'revision' | 'generatedAt'> = {
    v: ATLAS_CONTRACT_VERSION,
    run: { pid: inputs.pid, logDir: inputs.logDir, logDirHref: vscodeHref(inputs.logDir) },
    // A request header, echoed only when it names a site of this run, so no caller-chosen text is reflected.
    viewer: {
      siteId: inputs.sites.some((site) => {
        return site.packageName === inputs.viewer.siteId
      })
        ? inputs.viewer.siteId
        : null,
    },
    sites: inputs.sites.map((site) => {
      return buildSite(site, inputs, backendIds)
    }),
    backends,
    clouds: collectClouds(inputs.sites),
    logs: inputs.logs.map(({ service, path }) => {
      return atlasLog(service, path, inputs.exists)
    }),
  }

  const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex')

  return { ...body, revision, generatedAt: inputs.now.toISOString() }
}
