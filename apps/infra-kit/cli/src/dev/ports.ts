/**
 * Pure port / URL-prefix resolution for the dev-server.
 *
 * These functions are intentionally side-effect free: the environment is passed
 * in (never read from `process.env` here) and no cwd / fs access happens. That
 * keeps port precedence and conflict detection unit-testable in isolation.
 */
import type { DevConfig } from '../lib/infra-kit-config/index.js'

/**
 * The port the dev-server used to fall back to before dynamic allocation.
 *
 * NOT a live fallback any more — nothing resolves to it. It is retained as the named anchor for the
 * regression guards that assert a bound port is a REAL ephemeral port and not this static value
 * (`serverless-local-run.test.ts`, `dev-context-fragment.test.ts`). Inlining `3010` at those call
 * sites would turn a stated invariant into a magic number.
 */
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
 * Resolve the EXPLICITLY-configured port for an API app (highest priority first): `{APP}_PORT` — e.g.
 * `CLIENT_PORT`, `SEARCH_ENGINE_PORT` — then a bare `PORT`, then `dev.<app>.port` from infra-kit.json,
 * or `undefined` when none is set. Per-app env keys use the app folder name in **UPPER_SNAKE_CASE**
 * (hyphens → underscores).
 *
 * There is deliberately NO default-port tier: `undefined` is what distinguishes an app the developer
 * pinned to a port (a preferred bind target) from an unconfigured app, which binds ephemeral straight
 * away under dynamic allocation. Used by the dev-server to (a) pick the preferred bind port and (b)
 * relax the conflict gate to explicit ports only.
 *
 * `allowBarePort` gates ONLY the second tier, and defaults to `true` so every standalone caller keeps
 * today's precedence. The per-app `{APP}_PORT` and `dev.<app>.port` tiers are unaffected either way.
 */
// Why `allowBarePort` exists: a bare `PORT` is not app-scoped, so in a multi-app run it hands every app
// the same preferred port and the caller's conflict gate then throws on duplicates it manufactured itself
// — a shell or Doppler `PORT` refusing to start a run it has nothing to do with. The caller passes `false`
// once it knows more than one app is being launched.
export function resolvePreferredPort(
  appName: string,
  env: NodeJS.ProcessEnv,
  devConfig: DevConfig,
  allowBarePort = true,
): number | undefined {
  const prefix = appName.replace(/-/g, '_').toUpperCase()
  const prefixedKey = `${prefix}_PORT`

  const fromPrefixed = parsePortString(env[prefixedKey])

  if (fromPrefixed != null) {
    return fromPrefixed
  }

  if (allowBarePort) {
    const fromPort = parsePortString(env.PORT)

    if (fromPort != null) {
      return fromPort
    }
  }

  return devConfig[appName]?.port ?? undefined
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
