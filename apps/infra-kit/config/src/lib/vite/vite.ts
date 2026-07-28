import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
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
import { DEFAULT_RELEASE_SLUG, slugifyHostLabel, slugifyRelease } from '../release-slug/release-slug'

/**
 * Env-name handle read at vite-config time to fill the `<env>` placeholder in a
 * cloud proxy target. Inlined (not imported from `src/lib/constants`) to keep the
 * `infra-kit/vite` bundle's import graph tiny — see the module header. Kept
 * byte-identical to `INFRA_KIT_ENV_VAR` in `src/lib/constants/constants.ts`.
 */
const INFRA_KIT_ENV = 'INFRA_KIT_ENV'

/** Per-package config filename, mirrored from the CLI's `PACKAGE_CONFIG_FILE`. */
const PACKAGE_CONFIG_FILE = 'infra-kit.config.ts'

/**
 * Repo-relative dev-context fragment DIRECTORY, searched upward from cwd. Each
 * runner (single-process or cmux pane) writes its OWN `<app>.json` fragment here
 * recording its real bound port + release; the helper merges them (see
 * {@link readLocalContext}). This is the current source of truth.
 */
const DEV_CONTEXT_DIR = path.join('.infra-kit', 'dev-context')

/**
 * Legacy single-file dev-context manifest, searched upward from cwd. Read only as
 * a transitional back-compat path when {@link DEV_CONTEXT_DIR} is absent (the
 * directory wins per-package when both exist).
 */
const DEV_CONTEXT_FILE = path.join('.infra-kit', 'dev-context.json')

/**
 * One `.infra-kit/dev-context/<app>.json` fragment. `package` is the load-bearing
 * field the helper reads (→ localSet); `origin` is **the authoritative local target** —
 * the exact origin the runner registered, obeyed verbatim by {@link resolveLocalTarget}.
 * The runner is the only party that knows the scheme and port its alias is really served
 * on, so the helper never re-derives them when `origin` is present.
 *
 * `release`, `alias` and `proxyPort` are the LEGACY inputs, read only when `origin` is
 * absent — which can only happen when an OLD CLI wrote the fragment (a CLI-only rollback).
 * `port` is no longer a proxy target (the direct `127.0.0.1:<port>` branch is gone) — it
 * survives as diagnostic provenance. `pid` is the staleness guard: {@link readFragmentDir}
 * drops a fragment whose writer is no longer alive, so a crashed runner cannot keep a
 * package pinned `local` at a dead alias. `writtenAt` is provenance only.
 *
 * Kept lenient (not `.strict()`) so extra writer fields never reject a valid fragment, and
 * deliberately un-`refine`d: a rejected fragment would drop a started package to `cloud`
 * instead of falling into legacy mode, which is what makes the rollback path work.
 */
const devContextFragmentSchema = z.object({
  package: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  writtenAt: z.number().optional(),
  release: z.string().optional(),
  alias: z.string().optional(),
  proxyPort: z.number().optional(),
  origin: z.string().optional(),
  v: z.number().optional(),
})

/**
 * Wire version of the dev-context fragment — the ONE contract between the `infra-kit` CLI (which writes
 * fragments) and this helper (which reads them). They ship as SEPARATE npm packages on separate cadences,
 * so this number is the only thing either side can trust about the other.
 *
 * `v >= 2` is a PROMISE that `origin` is present and authoritative.
 *
 * That promise is what makes the guard in {@link resolveLocalTarget} possible. Without it, a missing
 * `origin` is ambiguous — it means BOTH "an old CLI wrote this, legacy mode is correct" AND "a current
 * CLI wrote a broken fragment, legacy mode is catastrophic" — and the helper has to guess. It guesses
 * legacy, rebuilds the target from a `templates.local` that says `http://`, and proxies plain HTTP into
 * a TLS listener. Silently, because portless answers :80 with a 302 rather than refusing.
 *
 * A fragment with NO `v` is a pre-v2 (legacy) writer and must still be honoured: rejecting it would drop
 * a running package to `cloud` instead of falling into legacy mode, and that rollback path is exactly why
 * the schema above is lenient and un-`refine`d. Absent or unknown `v` therefore NEVER rejects.
 */
export const DEV_CONTEXT_WIRE_VERSION = 2

/**
 * A single Vite `server.proxy` entry. `changeOrigin` is always set. `cookieDomainRewrite` is cloud-only
 * (it keeps an HTTPS cloud BE's cookies usable from a local FE) and is always the EMPTY string, which
 * makes vite delete the whole `; Domain=…` segment rather than rewrite it (`rewriteCookieProperty`
 * returns `''` for a falsy replacement). A host-only cookie is then scoped to whatever host the browser
 * actually used, so it works from `127.0.0.1`, `localhost` and a `*.localhost` portless alias alike —
 * whereas a literal `Domain=localhost` is rejected outright by an IP host, and by a multi-label
 * `*.localhost` origin under the RFC 6265 §5.3 public-suffix rule. `secure: false` appears on BOTH sources
 * but for different reasons: a cloud target may serve a cert the local store rejects, and a local target
 * is served by portless from its own private CA — set there only for a loopback host (see
 * {@link isLoopbackTarget}). `headers` is present only when HTTP Basic Auth is injected (see
 * {@link buildBasicAuthHeader}) — it carries the `Authorization` header applied
 * uniformly to every route so upstream environments behind auth (e2e/staging)
 * stay reachable.
 */
export interface InfraKitViteProxyEntry {
  target: string
  changeOrigin: true
  secure?: false
  cookieDomainRewrite?: ''
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
  /**
   * Vite's `command`. Pass it (`defineConfig(async ({ command }) => ({ server: await infraKitDev({ command }) }))`)
   * so `build` is a no-op: `server` is irrelevant to a build and proxy resolution would otherwise
   * fail-fast on a cloud route with no sourced env. Omit (or `'serve'`) for the dev-server config.
   */
  command?: 'build' | 'serve'
  /**
   * Explicit dev-server port. Omit for a **per-worktree dynamic** free port (a fresh OS-assigned
   * port) so N simultaneous git worktrees never collide on Vite's default `5173`; Vite prints the
   * chosen URL. Pass a fixed number only when an external contract pins the port.
   */
  port?: number
  /**
   * Interface the dev server binds. Defaults to {@link LOOPBACK_V4} so a portless alias can reach it
   * (Vite's own `localhost` default binds `[::1]` only, which the proxy cannot dial). Override when
   * the dev server must be reachable off the loopback — `'0.0.0.0'` or `true` inside a container, on
   * a LAN, or for an e2e runner on another host.
   */
  host?: string | boolean
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
 * Re-exported from the shared, dependency-light `lib/release-slug` module so the
 * published `infra-kit/vite` surface (`entry/vite.ts:7`) is unchanged while the
 * dev-server's fragment writer derives `<release>` from the SAME implementation
 * (no slug drift). See {@link slugifyRelease}.
 */
export { slugifyRelease }

/** Fill the `<release>`/`<packageName>`/`<env>` placeholders in a URL template. */
const interpolate = (template: string, values: { release: string; packageName: string; env: string }): string => {
  return template
    .replaceAll('<release>', values.release)
    .replaceAll('<packageName>', values.packageName)
    .replaceAll('<env>', values.env)
}

/** The port a bare `http://` target implies, and the proxy's default — never spelled out in a URL. */
const DEFAULT_HTTP_PORT = 80

/**
 * The interface the vite dev server binds. Pinned to IPv4 loopback because portless dials its routes
 * on `127.0.0.1`, while vite's default `host: 'localhost'` combined with its
 * `dns.setDefaultResultOrder('verbatim')` binds `[::1]` ONLY — the alias then resolves, the proxy
 * connects, and the connection is refused, surfacing as a 502 on every UI request. Backends never hit
 * this because `ServerlessLocalRun` already binds `127.0.0.1`. Still loopback-only: this narrows the
 * address family, it does not expose the dev server to the network.
 */
const LOOPBACK_V4 = '127.0.0.1'

/**
 * Graft the proxy's listen port onto an interpolated local target. The `dev.proxy` local template is
 * written port-free (`https://<release>.<packageName>.localhost`) because the proxy serves TLS on `:443`,
 * the only port a port-free HTTPS URL can come from. A consumer who trades the clean URL for a zero-sudo
 * unprivileged port still needs the frontend to reach it, so the runner records the port it actually bound
 * and we append it here. A template that already pins its own port keeps it.
 */
const withProxyPort = (target: string, proxyPort: number | undefined): string => {
  if (proxyPort == null || proxyPort === DEFAULT_HTTP_PORT) return target

  let url: URL

  try {
    url = new URL(target)
  } catch {
    throw new Error(
      `@slip-stream-kit/config/vite: dev.proxy templates.local resolved to "${target}", which is not a valid URL, so the proxy port ${proxyPort} cannot be applied.`,
    )
  }

  if (url.port !== '') return target
  url.port = String(proxyPort)

  // `URL.toString()` synthesizes a `/` pathname for an authority-only URL, so the common port-free
  // template would come back as `…localhost:1355/`. Strip that ONLY when the template had no trailing
  // slash of its own — a template ending in `/` (e.g. `…localhost/base/`) means it, and silently
  // trimming it would change the path the frontend proxies to.
  const grafted = url.toString()

  return !target.endsWith('/') && grafted.endsWith('/') ? grafted.slice(0, -1) : grafted
}

/**
 * The lowest port a daemon can bind without root. An origin-less fragment recording a port AT OR ABOVE
 * this was written by an old CLI whose `spawnDaemon` always passed `--no-tls`, so infra-kit itself could
 * only ever have put PLAIN HTTP there. Below it (80/443) the daemon was installed out-of-band, where
 * portless defaults to TLS ON — which is precisely why the legacy scheme is left alone down there.
 */
const LEGACY_SELF_SPAWNED_PORT_FLOOR = 1024

/**
 * Legacy target resolution — reached ONLY for an origin-less fragment, i.e. one written by an OLD CLI
 * (a CLI-only rollback). It must reproduce the old helper rather than reject anything, because that is
 * what lets the CLI be reverted without touching a single consumer repo.
 *
 * `proxyPort >= 1024`: force the scheme to `http`. **Mitigation, not a proof** — infra-kit's own
 * `spawnDaemon` always passed `--no-tls`, so an unprivileged daemon *infra-kit created* was always plain
 * HTTP; a HAND-STARTED TLS daemon on such a port (portless's own default is TLS) would be wrongly
 * downgraded here. That corner is accepted: forcing `http` reproduces what the old CLI + old helper
 * already emitted, so it regresses nothing that worked.
 *
 * `proxyPort < 1024` (80/443) or absent: the daemon was installed out-of-band and may well be TLS, and we
 * cannot know. Reproduce the old helper verbatim and NEVER rewrite the scheme — forcing `http` on a `:443`
 * fragment would emit `http://<alias>:443`, plain HTTP into a TLS listener, the exact silent failure this
 * design exists to remove.
 */
const resolveLegacyTarget = (target: string, proxyPort: number | undefined): string => {
  if (proxyPort != null && proxyPort >= LEGACY_SELF_SPAWNED_PORT_FLOOR) {
    return withProxyPort(target.replace(/^https:\/\//iu, 'http://'), proxyPort)
  }

  return withProxyPort(target, proxyPort)
}

/**
 * The proxy target for a route resolved to `local`. The runner PUBLISHES the contract and the helper OBEYS
 * it: when the fragment carries an `origin`, that string is the target verbatim — the runner is the only
 * party that knows the scheme and port the alias it registered is actually served on, and this helper ships
 * on its own release cadence, so any re-derivation here is a guess that can silently disagree.
 *
 * `templates.local` is consulted ONLY in legacy mode (see {@link resolveLegacyTarget}).
 *
 * The target proxies to a stable HOSTNAME, and the runner re-points that alias at the freshly-bound port
 * on every `--watch` restart, so it self-heals without Vite reloading its config.
 */
const resolveLocalTarget = (args: {
  route: InfraKitDevProxyRoute
  templates: InfraKitDevProxy['templates']
  env: string | undefined
  getRelease: () => string
  info: LocalPackageInfo | undefined
}): string => {
  const { route, templates, env, getRelease, info } = args

  if (info?.origin) return info.origin

  // The fragment declared a wire version, which PROMISES an `origin` — and there isn't one. Falling into
  // legacy mode here would rebuild the target from `templates.local` and downgrade it to `http://`, i.e.
  // proxy plain HTTP into portless's TLS listener. That failure is silent (:80 answers with a 302 rather
  // than refusing), so nothing downstream would catch it. A fragment with NO `v` is a genuinely old writer
  // and still falls through to legacy below — that rollback path is intact. This branch is only the
  // impossible one: a writer that announced v2 and then broke its own promise.
  if (info?.wire != null) {
    throw new Error(
      `@slip-stream-kit/config/vite: the dev-context fragment for "${route.packageName}" declares wire v${info.wire} but ` +
        `carries no \`origin\`. A v${DEV_CONTEXT_WIRE_VERSION} writer must publish the exact origin it ` +
        `registered. Refusing to guess a target rather than silently proxy plain HTTP at a TLS listener — ` +
        `restart \`infra-kit dev\`, and if it persists the CLI and this helper are incompatible.`,
    )
  }

  const target = interpolate(templates.local, {
    // Prefer THIS package's runner-recorded release slug (R4) over the single global git derivation,
    // so cross-branch FE/BE pairings don't drift the emitted `<release>` from the segment the runner
    // aliased. Fall back to the global git slug only when the fragment carried no release.
    release: info?.release ?? getRelease(),
    // The local template resolves to a `<release>.<packageName>.localhost` alias the dev-server
    // registered with portless — which slugifies the package name to a legal DNS label. Slugify
    // identically here or a scoped name (`@hulyo/client-ui`) emits a target that no alias backs.
    packageName: slugifyHostLabel(route.packageName),
    env: env ?? '',
  })

  return resolveLegacyTarget(target, info?.proxyPort)
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
  /** Per-package runtime data (recorded release/port) from the dev-context merge. */
  localInfo?: ReadonlyMap<string, LocalPackageInfo>
}

/** Hostnames that can only be this machine — the only ones a private-CA cert is allowed to go unchecked on. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Is `target` unambiguously on this machine? Only then may {@link resolveRoute} disable cert validation:
 * `templates.local` is an unconstrained string in a consumer-authored config, so an unconditional
 * `secure: false` in a PUBLISHED helper would silently switch off validation for whatever URL a consumer
 * wrote there. Scoping it to `.localhost`/loopback is what makes "no MITM surface" true by construction.
 * An unparseable target is NOT local (the caller then leaves `secure` unset — fail closed).
 */
const isLoopbackTarget = (target: string): boolean => {
  let hostname: string

  try {
    hostname = new URL(target).hostname.toLowerCase()
  } catch {
    return false
  }

  // `URL.hostname` brackets an IPv6 literal (`[::1]`); compare the bare address.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  return bare.endsWith('.localhost') || LOOPBACK_HOSTNAMES.has(bare)
}

/** Resolve one route into a Vite proxy entry (or throw an actionable error). */
const resolveRoute = ({
  routePath,
  route,
  templates,
  localSet,
  env,
  getRelease,
  localInfo,
}: ResolveRouteArgs): InfraKitViteProxyEntry => {
  const source = pickSource(route, localSet)

  if (source === 'local') {
    const target = resolveLocalTarget({ route, templates, env, getRelease, info: localInfo?.get(route.packageName) })

    // The local target is now HTTPS, served with a cert minted by portless's own private CA. Node's
    // http-proxy validates the upstream chain against the system store, which does not contain that CA,
    // so every proxied request fails with SELF_SIGNED_CERT_IN_CHAIN (confirmed empirically — see
    // `.omc/research/portless-https-spike.md`). Only a loopback target earns the exemption.
    return isLoopbackTarget(target) ? { target, changeOrigin: true, secure: false } : { target, changeOrigin: true }
  }

  if (!env) {
    throw new Error(
      `@slip-stream-kit/config/vite: proxy route "${routePath}" resolves to a cloud backend but ${INFRA_KIT_ENV} is not set. Source an environment from Doppler first (e.g. \`infra-kit env-load -c dev\`).`,
    )
  }

  const target = interpolate(templates.cloud, { release: '', packageName: route.packageName, env })

  return { target, changeOrigin: true, secure: false, cookieDomainRewrite: '' }
}

interface ResolveProxyArgs {
  proxy: InfraKitDevProxy
  localSet: ReadonlySet<string>
  env: string | undefined
  getRelease: () => string
  /** Pre-computed `Authorization` header value applied uniformly to every route. */
  authHeader?: string
  /** Per-package runtime data (recorded release/port) from the dev-context merge. */
  localInfo?: ReadonlyMap<string, LocalPackageInfo>
}

/**
 * Pure resolver: turn a `dev.proxy` config + resolved inputs (local set, env,
 * lazy release) into a Vite `server.proxy` map. Side-effect-free so the
 * resolution shape is fully unit-testable. When `authHeader` is set, every route
 * entry gets a matching `headers.Authorization`; otherwise no `headers` key.
 */
/**
 * Order the emitted routes so a more specific prefix always beats a more general one.
 *
 * Vite matches `server.proxy` **first-hit-wins over insertion order** — `doesProxyContextMatchUrl` is
 * `context[0] === '^' && new RegExp(context).test(url) || url.startsWith(context)` — so a config that
 * happens to list `/api` before `/api/v1/cronjob` silently routes every cronjob call to whatever `/api`
 * resolves to. Emitting longest-first makes the consumer's key order irrelevant for literal prefixes.
 *
 * **Length is the correct key, and provably so:** if key `B` captures a URL that key `A` also captures,
 * then both are prefixes of that URL, so one is a prefix of the other — `A.startsWith(B)` — and hence
 * `A.length >= B.length`. Sorting by descending length therefore always places the more specific of any
 * overlapping pair first. Segment counting would be *worse*, because `startsWith` is not segment-aware:
 * `/api` captures `/api-docs` too, yet both are "one segment".
 *
 * **Regex keys bail out entirely.** A `^`-anchored key is schema-legal (`routes` is
 * `z.record(z.string().min(1), …)`), and its capture set is unknowable to a sorter — length says nothing
 * about breadth, and there is no position, ahead or behind, that is right in general: a broad
 * `'^/(api|dynamic)'` must lose to `/api/v1/cronjob`, while a narrow one must not. So if ANY key is a
 * regex, the map is returned in the consumer's own order, which is at least the order they can reason
 * about. No consumer uses a regex key today; this exists so the sort can never invert one's intent.
 *
 * Note this only governs the routes INFRA-KIT emits. A consumer who writes their own `server.proxy`
 * keeps priority regardless: vite merges a plugin's config over the user's, placing user keys first.
 */
const orderBySpecificity = (routes: InfraKitViteProxy): InfraKitViteProxy => {
  const keys = Object.keys(routes)

  if (
    keys.some((key) => {
      return key.startsWith('^')
    })
  )
    return routes

  const ordered: InfraKitViteProxy = {}

  // `toSorted` is stable, so equal-length keys keep the consumer's relative order.
  for (const key of keys.toSorted((a, b) => {
    return b.length - a.length
  }))
    ordered[key] = routes[key]!

  return ordered
}

export const resolveProxyConfig = ({
  proxy,
  localSet,
  env,
  getRelease,
  authHeader,
  localInfo,
}: ResolveProxyArgs): InfraKitViteProxy => {
  const result: InfraKitViteProxy = {}
  const headers = authHeader ? { Authorization: authHeader } : undefined

  for (const [routePath, route] of Object.entries(proxy.routes)) {
    const entry = resolveRoute({ routePath, route, templates: proxy.templates, localSet, env, getRelease, localInfo })

    result[routePath] = headers ? { ...entry, headers } : entry
  }

  return orderBySpecificity(result)
}

/**
 * Warn (never throw) when `dev.proxy.templates.local` is not `https://`. The portless daemon that
 * serves the local template is TLS-only, and {@link resolveLegacyTarget} only ever downgrades
 * https -> http for a legacy self-spawned port — it never upgrades — so an `http://` template
 * silently proxies into nothing reachable. Warn-first this release (schema still accepts any
 * non-empty string, see `packageConfigSchema`) so an unknown legit `http://` consumer isn't bricked;
 * make this a hard schema requirement next release.
 */
const warnIfNonHttpsLocalTemplate = (dev: InfraKitDev | undefined, configPath: string): void => {
  const local = dev?.proxy?.templates.local

  if (local !== undefined && !local.startsWith('https://')) {
    console.warn(
      `@slip-stream-kit/config: dev.proxy.templates.local in ${configPath} is "${local}", which is not an ` +
        `https:// URL. The local dev proxy target must be https:// (the portless daemon it points at serves ` +
        `TLS only) — https:// will become a REQUIRED value in a future release.`,
    )
  }
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
 *
 * Reached from two different processes, and only one of them is ours. Under the
 * CLI (`infra-kit dev`, `audit`) the entry has installed
 * {@link ../node-warnings.suppressTypelessPackageJsonWarning}, so a consumer package
 * with no `"type"` loads quietly. Under `infraKitDev()` in a consumer's own
 * `vite.config.ts` we are a library in their process and do NOT patch their globals,
 * so such a package still prints Node's MODULE_TYPELESS_PACKAGE_JSON banner there.
 * Harmless (it is a double-parse notice), and latent while consumer UI packages
 * declare `"type": "module"`.
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
    throw new Error(
      `@slip-stream-kit/config/vite: invalid ${PACKAGE_CONFIG_FILE} at ${configPath}: ${z.prettifyError(parsed.error)}`,
    )
  }

  warnIfNonHttpsLocalTemplate(parsed.data.dev, configPath)

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

/** Per-package runtime data merged from the dev-context fragment directory. */
export interface LocalPackageInfo {
  /** The real bound port the runner recorded. Provenance only — the proxy target is the alias host. */
  port: number
  /**
   * The authoritative local target (`https://<release>.<packageName>.localhost`), published by the
   * runner. Present → {@link resolveLocalTarget} uses it verbatim and consults no template. Absent →
   * the fragment came from an old CLI and the legacy template path runs.
   */
  origin?: string
  /**
   * The fragment's declared wire version (see {@link DEV_CONTEXT_WIRE_VERSION}). Absent → a pre-v2 writer,
   * so legacy mode is the correct reading. Present → the writer PROMISED an `origin`, and a missing one is
   * a broken fragment rather than an old one.
   */
  wire?: number
  /** LEGACY (no `origin`): the runner-recorded release slug, preferred over the helper's git derivation. */
  release?: string
  /** LEGACY (no `origin`): `<release>.<packageName>.localhost`, present only when an alias was registered. */
  alias?: string
  /** LEGACY (no `origin`): the port {@link alias} resolves on. `80` (the default) is implicit in the template. */
  proxyPort?: number
}

/**
 * The locally-running package set plus a `package → { port, release }` map merged
 * from the dev-context fragments. `packages` feeds `pickSource`; `info` lets a
 * `local` route emit the per-package recorded release (see {@link resolveRoute}).
 */
export interface LocalContext {
  packages: ReadonlySet<string>
  info: ReadonlyMap<string, LocalPackageInfo>
}

/** An empty {@link LocalContext} (frontend-only / dev-context absent). */
const emptyLocalContext = (): LocalContext => {
  return { packages: new Set(), info: new Map() }
}

/**
 * Is the runner that wrote a fragment still alive? Signal `0` performs the permission and existence
 * checks without delivering anything. `ESRCH` is the one answer that means "gone"; `EPERM` means the
 * pid exists under another uid, which is still a live process. A fragment with no `pid` predates the
 * field and is trusted (back-compat) rather than dropped.
 */
const isFragmentWriterAlive = (pid: number | undefined): boolean => {
  if (pid == null) return true

  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Merge every `<app>.json` fragment in the dev-context directory into a
 * {@link LocalContext}. Two DISTINCT failure branches (do NOT collapse them into
 * one directory-wide catch):
 *  - `readdir`-ENOENT (directory vanished mid-race) → empty context, matching the
 *    dir-absent back-compat behaviour.
 *  - a single corrupt/truncated/invalid `<app>.json` → that ONE fragment is
 *    SKIPPED (per-fragment `safeParse` isolation); the rest still merge, so one bad
 *    fragment never collapses the whole localSet to empty (which would silently
 *    drop a started package to cloud).
 */
const readFragmentDir = (dir: string): LocalContext => {
  let entries: string[]

  try {
    entries = fs.readdirSync(dir)
  } catch {
    return emptyLocalContext()
  }

  const packages = new Set<string>()
  const info = new Map<string, LocalPackageInfo>()

  for (const name of entries) {
    if (!name.endsWith('.json')) continue

    try {
      const parsed = devContextFragmentSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')))

      if (!parsed.success) continue

      // A runner killed with SIGKILL (or crashed) leaves its fragment AND its portless alias behind.
      // Trusting it would route this package's `/api` at an alias nothing serves — a silent 502 with
      // no diagnostic. The writer already stamps its pid; honour it.
      if (!isFragmentWriterAlive(parsed.data.pid)) continue

      packages.add(parsed.data.package)
      info.set(parsed.data.package, {
        port: parsed.data.port,
        origin: parsed.data.origin,
        release: parsed.data.release,
        alias: parsed.data.alias,
        proxyPort: parsed.data.proxyPort,
        wire: parsed.data.v,
      })
    } catch {
      // Corrupt/truncated fragment (JSON.parse / read failure): skip ONLY this one.
      continue
    }
  }

  return { packages, info }
}

/**
 * Read the locally-running package context, searched upward from `cwd`. Prefers
 * the `.infra-kit/dev-context/` fragment DIRECTORY (merged via
 * {@link readFragmentDir}); when it is absent, falls back to the legacy single
 * `.infra-kit/dev-context.json` file (read as before — no per-package release);
 * when neither exists → empty context (frontend-only, every route resolves cloud).
 */
export const readLocalContext = (cwd: string): LocalContext => {
  const dir = findUp(cwd, DEV_CONTEXT_DIR)

  if (dir) return readFragmentDir(dir)

  const legacy = findUp(cwd, DEV_CONTEXT_FILE)

  if (!legacy) return emptyLocalContext()

  try {
    return { packages: new Set(extractPackages(JSON.parse(fs.readFileSync(legacy, 'utf-8')))), info: new Map() }
  } catch {
    return emptyLocalContext()
  }
}

/**
 * Read the set of locally-running packages (searched upward from `cwd`). Thin
 * wrapper over {@link readLocalContext} preserving the historical `Set`-returning
 * contract. Absent dev-context → empty set (frontend-only cloud resolution).
 */
export const readLocalSet = (cwd: string): ReadonlySet<string> => {
  return readLocalContext(cwd).packages
}

/** Current git branch of `cwd` (raw, un-slugified). */
const readGitBranch = (cwd: string): string => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
}

/**
 * An OS-assigned free TCP port on 127.0.0.1 — the per-worktree dev-server port (mirrors the
 * backend's `listen(0)`). This probes then releases the port, so there is a small TOCTOU window
 * before Vite binds it; Vite's default `strictPort: false` absorbs a lost race by stepping to the
 * next free port. Only a consumer that sets `strictPort: true` would hard-fail on the rare collision.
 */
const getFreePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()

    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0

      srv.close(() => {
        return resolve(port)
      })
    })
  })
}

/** Env var carrying the runner-assigned `{ "<ui-package>": <port> }` map (Layer B). */
const UI_PORTS_ENV = 'INFRA_KIT_UI_PORTS'

/** This package's `package.json` `name`, or `null` (unreadable / nameless). */
const readPackageName = (cwd: string): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as { name?: unknown }

    return typeof parsed.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}

/**
 * What the runner assigned THIS UI. `alias` is present only in the widened record form, i.e. only when the
 * runner both assigned the port AND registered the hostname — which is exactly the condition for pointing
 * HMR at that hostname. The legacy bare-number form yields no alias.
 */
interface ManagedUi {
  port: number
  alias?: string
}

/**
 * What `infra-kit dev` assigned THIS UI via `INFRA_KIT_UI_PORTS` (Layer B), or `null` when the map is
 * absent / this package isn't in it / it's malformed. Present → the helper binds the port with
 * `strictPort` so vite lands on exactly the port the runner already aliased. Absent (a standalone
 * `vite dev`) → the caller falls back to a free port, byte-identical to today.
 *
 * Accepts BOTH the widened `{ port, alias }` record and the legacy bare `<port>` number an older runner
 * writes — a new helper paired with an old CLI must still bind the assigned port.
 */
const resolveManagedUi = (cwd: string): ManagedUi | null => {
  const raw = process.env[UI_PORTS_ENV]

  if (raw == null || raw === '') return null

  const name = readPackageName(cwd)

  if (name == null) return null

  try {
    const entry = (JSON.parse(raw) as Record<string, unknown>)[name]

    if (typeof entry === 'number') return { port: entry }

    if (entry === null || typeof entry !== 'object') return null

    const { port, alias } = entry as { port?: unknown; alias?: unknown }

    if (typeof port !== 'number') return null

    return { port, alias: typeof alias === 'string' ? alias : undefined }
  } catch {
    return null
  }
}

/** The port an `https://` alias is served on — never spelled out in a URL, and what the HMR client dials. */
const HTTPS_PORT = 443

/**
 * Vite's `server.ws` override, pointing the HMR client at the alias instead of at the raw dev-server port.
 * The page is loaded over `https://<alias>`, so its websocket must be `wss://` on the same origin or the
 * browser blocks it as mixed content; `clientPort` is the proxy's implicit `:443`, not vite's bound port.
 *
 * This is `server.ws`, NOT the older `server.hmr`: vite 8 deprecated `server.hmr.{protocol,host,port,
 * path,clientPort,timeout,server}` in favour of `server.ws.*` and warns on every dev boot that sets them
 * — a warning consumers were seeing in the wild, emitted by us. The field names are unchanged (vite's
 * `WsOptions` is `HmrOptions` minus `overlay`), so this is a key rename, not a behaviour change.
 *
 * **Requires vite >= 8.** `server.ws` does not exist before it; vite 8 ships `setupHmrWsOptionCompat` to
 * copy a legacy `hmr` onto `ws`, which is what makes `ws` the forward direction and `hmr` the legacy one.
 * Neither this package (zod-only) nor `@slip-stream-kit/vite` (which imports vite as `import type`, erased
 * at runtime) can detect the version, so the floor is a documented requirement rather than a runtime check.
 * Emitting both keys is NOT an option — it would re-trigger the very deprecation warning being removed.
 */
export interface InfraKitViteWs {
  protocol: 'wss'
  host: string
  clientPort: number
}

/**
 * Resolve a package's `dev` block into a ready-made Vite `server` config: a per-worktree dev-server
 * `port` plus the `proxy` map. Loads the package's `infra-kit.config.ts`, merges the local dev set
 * from the `.infra-kit/dev-context/` fragment directory, and interpolates the local/cloud templates.
 * `<env>` comes from `INFRA_KIT_ENV`; `<release>` from each package's runner-recorded fragment when
 * present, else the slugified git branch (computed lazily, only when a local route needs it).
 *
 * `port` defaults to a fresh OS-assigned free port so simultaneous git worktrees never collide on
 * Vite's `5173` (override via `options.port`). `host` defaults to {@link LOOPBACK_V4} so the portless
 * alias can actually reach it (override via `options.host` for containers/LAN). `ws` is emitted only
 * when `infra-kit dev` registered an alias for this UI, so a bare `vite dev` keeps vite's own HMR
 * defaults. Pass `command` so `build` is a no-op (empty proxy, no port) — a build ignores `server` and
 * proxy resolution would otherwise fail-fast on a cloud route with no sourced env.
 *
 * @example
 * // vite.config.ts — the whole `server` field is the helper's output
 * import { infraKitDev } from 'infra-kit/vite'
 * export default defineConfig(async ({ command }) => ({ server: await infraKitDev({ command }) }))
 */
export const infraKitDev = async (
  options: InfraKitDevOptions = {},
): Promise<{
  port?: number
  host?: string | boolean
  strictPort?: boolean
  ws?: InfraKitViteWs
  proxy: InfraKitViteProxy
}> => {
  const cwd = options.cwd ?? process.cwd()

  // A build ignores `server`; skip the port + proxy work (proxy resolution would fail-fast on a
  // cloud route with no sourced env).
  if (options.command === 'build') return { proxy: {} }

  // Port precedence: explicit `options.port` > the runner-assigned Layer-B port (bound `strictPort` so
  // vite lands on exactly the aliased port) > a fresh free port (today's default; the portless-off path).
  const managed = options.port == null ? resolveManagedUi(cwd) : null
  const port = options.port ?? managed?.port ?? (await getFreePort())
  const strictPort = managed != null
  const host = options.host ?? LOOPBACK_V4

  // Override the HMR websocket ONLY when the runner handed us the alias it registered. A bare `vite dev`
  // (no runner) has no alias, and a computable hostname is not a registered one — pointing the HMR client
  // at a hostname nothing resolves would break hot reload on a path that works today.
  const ws: InfraKitViteWs | undefined =
    managed?.alias == null ? undefined : { protocol: 'wss', host: managed.alias, clientPort: HTTPS_PORT }
  const server = { port, host, ...(strictPort ? { strictPort } : {}), ...(ws ? { ws } : {}) }
  const dev = await loadDev(cwd)

  if (!dev?.proxy) return { ...server, proxy: {} }

  const { packages: localSet, info: localInfo } = readLocalContext(cwd)
  const env = process.env[INFRA_KIT_ENV]
  const authHeader = buildBasicAuthHeader(process.env, options.basicAuth)
  const getRelease = once(() => {
    // Mirrors the dev-server's `readAppRelease`: outside a git repo both sides must land on the SAME
    // label, or this target names a host the runner never aliased.
    try {
      return slugifyRelease(readGitBranch(cwd)) || DEFAULT_RELEASE_SLUG
    } catch {
      return DEFAULT_RELEASE_SLUG
    }
  })

  return {
    ...server,
    proxy: resolveProxyConfig({ proxy: dev.proxy, localSet, env, getRelease, authHeader, localInfo }),
  }
}

/**
 * Convenience wrapper returning just the proxy map (for spreading into
 * `server.proxy` directly). Equivalent to `(await infraKitDev(options)).proxy`.
 */
export const infraKitProxy = async (options: InfraKitDevOptions = {}): Promise<InfraKitViteProxy> => {
  return (await infraKitDev(options)).proxy
}
