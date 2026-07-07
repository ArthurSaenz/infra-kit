import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import type {
  InfraKitDev,
  InfraKitDevProxy,
  InfraKitDevProxyRoute,
  InfraKitDevProxySource,
} from '../package-config/package-config'
import { packageConfigSchema } from '../package-config/package-config-schema'

/**
 * Env-name handle read at vite-config time to fill the `<env>` placeholder in a
 * cloud proxy target. Inlined (not imported from `src/lib/constants`) to keep the
 * `infra-kit/vite` bundle's import graph tiny — see the module header. Kept
 * byte-identical to `INFRA_KIT_ENV_VAR` in `src/lib/constants/constants.ts`.
 */
const INFRA_KIT_ENV = 'INFRA_KIT_ENV'

/** Per-package config filename, mirrored from the CLI's `PACKAGE_CONFIG_FILE`. */
const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

/** Repo-relative path to the local dev-package manifest, searched upward from cwd. */
const DEV_CONTEXT_FILE = path.join('.infra-kit', 'dev-context.json')

/**
 * A single Vite `server.proxy` entry. `changeOrigin` is always set; the
 * cloud-only pair (`secure: false` + `cookieDomainRewrite: 'localhost'`) makes a
 * local FE talk to an HTTPS cloud BE without cert/cookie-domain breakage.
 * `headers` is present only when HTTP Basic Auth is injected (see
 * {@link buildBasicAuthHeader}) — it carries the `Authorization` header applied
 * uniformly to every route so upstream environments behind auth (e2e/staging)
 * stay reachable.
 */
export interface InfraKitViteProxyEntry {
  target: string
  changeOrigin: true
  secure?: false
  cookieDomainRewrite?: 'localhost'
  headers?: Record<string, string>
}

/** A Vite `server.proxy`-shaped map: path-prefix → proxy entry. */
export type InfraKitViteProxy = Record<string, InfraKitViteProxyEntry>

/** Explicit HTTP Basic Auth credentials, overriding the `E2E__BASIC_AUTH_*` env vars. */
export interface InfraKitBasicAuth {
  username: string
  password: string
}

export interface InfraKitDevOptions {
  /** Package dir whose `infra-kit.config.ts` is loaded. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Explicit HTTP Basic Auth credentials injected into every proxy route as an
   * `Authorization` header. Takes precedence over the `E2E__BASIC_AUTH_USERNAME`
   * / `E2E__BASIC_AUTH_PASSWORD` env vars. Omit to use the env-based default.
   */
  basicAuth?: InfraKitBasicAuth
}

/**
 * Build the `Authorization: Basic <base64(user:pass)>` header value. Credentials
 * come from `override` when given, else from `E2E__BASIC_AUTH_USERNAME` /
 * `E2E__BASIC_AUTH_PASSWORD` (NOTE: double underscore). Returns `undefined` when
 * either half is missing, so callers add no `headers` key at all.
 */
const buildBasicAuthHeader = (env: NodeJS.ProcessEnv, override?: InfraKitBasicAuth): string | undefined => {
  const username = override?.username ?? env.E2E__BASIC_AUTH_USERNAME
  const password = override?.password ?? env.E2E__BASIC_AUTH_PASSWORD

  if (!username || !password) return undefined

  const encoded = Buffer.from(`${username}:${password}`).toString('base64')

  return `Basic ${encoded}`
}

/**
 * Slugify a git branch into a `<release>` token: strip a leading git-flow prefix
 * (`feature/`, `release/`, …), lowercase, collapse non-alphanumeric runs to `-`,
 * and trim stray dashes.
 *
 * @example
 * slugifyRelease('release/2.4')     // => '2-4'
 * slugifyRelease('feature/HUL-123') // => 'hul-123'
 */
export const slugifyRelease = (branch: string): string => {
  // Collect the alphanumeric runs and join with `-`. Doing it this way (rather
  // than collapse-then-trim) is linear and sidesteps a super-linear trim regex,
  // while inherently dropping any leading/trailing separators.
  const runs = branch
    .replace(/^(?:feature|feat|release|hotfix|bugfix|fix|chore)\//i, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)

  return runs ? runs.join('-') : ''
}

/** Fill the `<release>`/`<packageName>`/`<env>` placeholders in a URL template. */
const interpolate = (template: string, values: { release: string; packageName: string; env: string }): string => {
  return template
    .replaceAll('<release>', values.release)
    .replaceAll('<packageName>', values.packageName)
    .replaceAll('<env>', values.env)
}

/**
 * Pick the effective source for a route: `local` when the route lists `local` as
 * a capability AND its packageName is in the local dev set; otherwise the fallback
 * — the declared `default` for a multi-source route, or the sole `from` entry for
 * a single-source one. Always resolves (the schema guarantees a usable fallback).
 */
const pickSource = (route: InfraKitDevProxyRoute, localSet: ReadonlySet<string>): InfraKitDevProxySource => {
  // `from` is guaranteed non-empty by the schema, so `from[0]` is always present.
  const fallback = route.default ?? route.from[0]!

  return route.from.includes('local') && localSet.has(route.packageName) ? 'local' : fallback
}

interface ResolveRouteArgs {
  routePath: string
  route: InfraKitDevProxyRoute
  templates: InfraKitDevProxy['templates']
  localSet: ReadonlySet<string>
  env: string | undefined
  getRelease: () => string
}

/** Resolve one route into a Vite proxy entry (or throw an actionable error). */
const resolveRoute = ({
  routePath,
  route,
  templates,
  localSet,
  env,
  getRelease,
}: ResolveRouteArgs): InfraKitViteProxyEntry => {
  const source = pickSource(route, localSet)

  if (source === 'local') {
    const target = interpolate(templates.local, {
      release: getRelease(),
      packageName: route.packageName,
      env: env ?? '',
    })

    return { target, changeOrigin: true }
  }

  if (!env) {
    throw new Error(
      `infra-kit/vite: proxy route "${routePath}" resolves to a cloud backend but ${INFRA_KIT_ENV} is not set. Source an environment from Doppler first (e.g. \`infra-kit env-load dev\`).`,
    )
  }

  const target = interpolate(templates.cloud, { release: '', packageName: route.packageName, env })

  return { target, changeOrigin: true, secure: false, cookieDomainRewrite: 'localhost' }
}

interface ResolveProxyArgs {
  proxy: InfraKitDevProxy
  localSet: ReadonlySet<string>
  env: string | undefined
  getRelease: () => string
  /** Pre-computed `Authorization` header value applied uniformly to every route. */
  authHeader?: string
}

/**
 * Pure resolver: turn a `dev.proxy` config + resolved inputs (local set, env,
 * lazy release) into a Vite `server.proxy` map. Side-effect-free so the
 * resolution shape is fully unit-testable. When `authHeader` is set, every route
 * entry gets a matching `headers.Authorization`; otherwise no `headers` key.
 */
export const resolveProxyConfig = ({
  proxy,
  localSet,
  env,
  getRelease,
  authHeader,
}: ResolveProxyArgs): InfraKitViteProxy => {
  const result: InfraKitViteProxy = {}
  const headers = authHeader ? { Authorization: authHeader } : undefined

  for (const [routePath, route] of Object.entries(proxy.routes)) {
    const entry = resolveRoute({ routePath, route, templates: proxy.templates, localSet, env, getRelease })

    result[routePath] = headers ? { ...entry, headers } : entry
  }

  return result
}

/** Memoize a zero-arg thunk so `<release>` git resolution runs at most once. */
const once = <T>(fn: () => T): (() => T) => {
  let cached: { value: T } | undefined

  return () => {
    cached ??= { value: fn() }

    return cached.value
  }
}

/**
 * Load a package's `infra-kit.config.ts` and return its `dev` block, or
 * `undefined` when the config or the `dev` key is absent. The `.ts` config is
 * evaluated via Node's native type stripping (Node >= 24) — the same mechanism
 * the CLI's config loader uses. Cache-busted by mtime so repeated dev-server
 * reloads pick up edits.
 */
export const loadDev = async (cwd: string): Promise<InfraKitDev | undefined> => {
  const configPath = path.join(cwd, PACKAGE_CONFIG_FILE)

  if (!fs.existsSync(configPath)) return undefined

  const stat = fs.statSync(configPath)
  const moduleUrl = `${pathToFileURL(configPath).href}?mtime=${Number(stat.mtimeMs)}`

  const imported = (await import(moduleUrl)) as { default?: unknown }
  const rawExport = imported.default

  if (rawExport === undefined) return undefined

  const resolved = typeof rawExport === 'function' ? await (rawExport as () => unknown)() : rawExport

  const parsed = packageConfigSchema.safeParse(resolved)

  if (!parsed.success) {
    throw new Error(`infra-kit/vite: invalid ${PACKAGE_CONFIG_FILE} at ${configPath}: ${z.prettifyError(parsed.error)}`)
  }

  return parsed.data.dev
}

/** Coerce a parsed dev-context.json into the set of locally-running package names. */
const extractPackages = (parsed: unknown): string[] => {
  if (Array.isArray(parsed)) {
    return parsed.filter((v): v is string => {
      return typeof v === 'string'
    })
  }

  if (parsed !== null && typeof parsed === 'object') {
    const candidate = (parsed as Record<string, unknown>).packages ?? (parsed as Record<string, unknown>).localPackages

    if (Array.isArray(candidate)) {
      return candidate.filter((v): v is string => {
        return typeof v === 'string'
      })
    }
  }

  return []
}

/** Search upward from `start` for `relative`, returning the first hit or undefined. */
const findUp = (start: string, relative: string): string | undefined => {
  let dir = path.resolve(start)

  for (;;) {
    const candidate = path.join(dir, relative)

    if (fs.existsSync(candidate)) return candidate

    const parent = path.dirname(dir)

    if (parent === dir) return undefined

    dir = parent
  }
}

/**
 * Read the set of locally-running packages from the nearest
 * `.infra-kit/dev-context.json` (searched upward from cwd). Absent file → empty
 * set, i.e. the frontend-only case where every route resolves to cloud.
 */
export const readLocalSet = (cwd: string): ReadonlySet<string> => {
  const file = findUp(cwd, DEV_CONTEXT_FILE)

  if (!file) return new Set()

  try {
    return new Set(extractPackages(JSON.parse(fs.readFileSync(file, 'utf-8'))))
  } catch {
    return new Set()
  }
}

/** Current git branch of `cwd` (raw, un-slugified). */
const readGitBranch = (cwd: string): string => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
}

/**
 * Resolve a package's `dev` block into a spreadable Vite `server` fragment. Loads
 * the package's `infra-kit.config.ts`, reads the local dev set from
 * `.infra-kit/dev-context.json`, and interpolates the local/cloud templates.
 * `<env>` comes from `INFRA_KIT_ENV`; `<release>` from the slugified git branch
 * (computed lazily, only when a local route needs it). Returns `{ proxy: {} }`
 * when there is no `dev` block.
 *
 * @example
 * // vite.config.ts
 * import { infraKitDev } from 'infra-kit/vite'
 * export default defineConfig(async () => ({ server: { ...(await infraKitDev()) } }))
 */
export const infraKitDev = async (options: InfraKitDevOptions = {}): Promise<{ proxy: InfraKitViteProxy }> => {
  const cwd = options.cwd ?? process.cwd()

  const dev = await loadDev(cwd)

  if (!dev?.proxy) return { proxy: {} }

  const localSet = readLocalSet(cwd)
  const env = process.env[INFRA_KIT_ENV]
  const authHeader = buildBasicAuthHeader(process.env, options.basicAuth)
  const getRelease = once(() => {
    return slugifyRelease(readGitBranch(cwd))
  })

  return { proxy: resolveProxyConfig({ proxy: dev.proxy, localSet, env, getRelease, authHeader }) }
}

/**
 * Convenience wrapper returning just the proxy map (for spreading into
 * `server.proxy` directly). Equivalent to `(await infraKitDev(options)).proxy`.
 */
export const infraKitProxy = async (options: InfraKitDevOptions = {}): Promise<InfraKitViteProxy> => {
  return (await infraKitDev(options)).proxy
}
