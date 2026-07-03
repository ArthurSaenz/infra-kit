/**
 * Pure port / URL-prefix resolution for the dev-server.
 *
 * These functions are intentionally side-effect free: the environment is passed
 * in (never read from `process.env` here) and no cwd / fs access happens. That
 * keeps port precedence and conflict detection unit-testable in isolation.
 */
import type { DevConfig } from '../lib/infra-kit-config/index.js'

/** Fallback port when no PORT / {APP}_PORT env var and no config port is set. */
export const DEFAULT_PORT = 3010

/**
 * URL prefix applied to each app's routes when nothing is configured. Overridable
 * per app via `dev.<app>.prefixUrl` in infra-kit.json — this is only the fallback.
 */
export const DEFAULT_PREFIX_URL = '/api/v1'

/**
 * Parse a raw port string (env var or config), stripping a single pair of
 * surrounding quotes and treating blank / non-numeric input as "unset".
 */
export function parsePortString(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') {
    return undefined
  }

  const n = parseInt(raw.trim().replace(/^["']|["']$/g, ''), 10)

  return Number.isNaN(n) ? undefined : n
}

/**
 * Resolve the PORT for an API app (highest priority first):
 *
 * 1. **`{APP}_PORT`** — e.g. `CLIENT_PORT`, `SEARCH_ENGINE_PORT` (secrets manager or shell)
 * 2. **`PORT`** — shared fallback (multi-app: use distinct `{APP}_PORT` in env)
 * 3. **`dev.<app>.port`** from infra-kit.json
 * 4. Default {@link DEFAULT_PORT}
 *
 * Per-app env keys use the app folder name in **UPPER_SNAKE_CASE** (hyphens → underscores).
 */
export function resolvePort(appName: string, env: NodeJS.ProcessEnv, devConfig: DevConfig): number {
  const prefix = appName.replace(/-/g, '_').toUpperCase()
  const prefixedKey = `${prefix}_PORT`

  const fromPrefixed = parsePortString(env[prefixedKey])

  if (fromPrefixed != null) {
    return fromPrefixed
  }

  const fromPort = parsePortString(env.PORT)

  if (fromPort != null) {
    return fromPort
  }

  const fromConfig = devConfig[appName]?.port

  if (fromConfig != null) {
    return fromConfig
  }

  return DEFAULT_PORT
}

/**
 * Resolve the URL prefix for an API app: `dev.<app>.prefixUrl` from
 * infra-kit.json, falling back to {@link DEFAULT_PREFIX_URL} (`/api/v1`).
 */
export function resolvePrefixUrl(appName: string, devConfig: DevConfig): string {
  return devConfig[appName]?.prefixUrl ?? DEFAULT_PREFIX_URL
}

/** The apps that collide on a port, plus the raw duplicate-port list for messaging. */
export interface PortConflicts {
  /** Ports that appear more than once (one entry per extra occurrence, in scan order). */
  duplicatePorts: number[]
  /** Every app whose resolved port is one of the duplicates. */
  conflictingApps: Array<{ name: string; port: number }>
}

/**
 * Find apps that resolve to the same port. Returns empty `duplicatePorts` when
 * there is no conflict; the caller decides how to surface / throw.
 */
export function findPortConflicts(apps: Array<{ name: string; port: number }>): PortConflicts {
  const ports = apps.map((a) => {
    return a.port
  })
  const duplicatePorts = ports.filter((port, index) => {
    return ports.indexOf(port) !== index
  })
  const conflictingApps = apps.filter((a) => {
    return duplicatePorts.includes(a.port)
  })

  return { duplicatePorts, conflictingApps }
}
