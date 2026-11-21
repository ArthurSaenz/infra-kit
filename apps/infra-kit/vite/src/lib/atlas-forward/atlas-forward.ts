import type { AtlasEndpoint } from '@slip-stream-kit/config/internal'
import {
  ATLAS_PATH,
  ATLAS_SERVED_ROUTES_HEADER,
  ATLAS_SITE_HEADER,
  ATLAS_TOKEN_HEADER,
  readAtlasEndpoint,
} from '@slip-stream-kit/config/internal'
import { Buffer } from 'node:buffer'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import http from 'node:http'
import process from 'node:process'

type Next = (err?: unknown) => void

export interface AtlasForwardOptions {
  /** This package's `package.json` name, sent to the runner so it knows which site the viewer opened. */
  site: string | null
  /** The dev server's final `server.proxy`, read per request so a restart's re-resolved proxy is what is reported. */
  proxy: () => Record<string, unknown> | undefined
  /** The proxy keys the plugin emitted itself; every other key was the consumer's own. */
  emittedKeys: () => ReadonlySet<string>
}

const STATE_PATH = `${ATLAS_PATH}/state.json`
const OPEN_PATH = `${ATLAS_PATH}/open`
const PAGE_PATHS = new Set([ATLAS_PATH, `${ATLAS_PATH}/`])
const FORWARD_TIMEOUT_MS = 1500
const SERVED_ROUTES_MAX_BYTES = 8 * 1024
const SAFE_FETCH_SITES = new Set(['same-origin', 'none'])

const DOWN_PAGE = (hint: string): string => {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The infra-kit dev runner is not running</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
  code { background: #eff1f3; padding: 0.1em 0.35em; border-radius: 4px; }
</style>
</head>
<body>
<h1>The <code>infra-kit dev</code> runner is not running</h1>
<p>This page is served by the runner that started this dev server, and it could not be reached.</p>
<p>Start the app from the repository root with <code>ik dev &lt;app&gt;</code>, then reload this page.</p>
${hint}</body>
</html>
`
}

// An absent endpoint is also what an old runner looks like, and an update is the only fix for that.
const UPDATE_HINT = '<p>Already running it? Update <code>infra-kit</code>: older runners do not serve this page.</p>\n'

const pathnameOf = (url: string): string => {
  return url.split('?')[0] ?? url
}

/**
 * A browser read from another origin is refused, because vite's `cors` accepts every `*.localhost` origin and
 * the forwarder supplies the token itself. A top-level navigation to the page cannot read the response, and
 * every alias is `*.localhost`, so a link from another app arrives as `same-site` and is let through.
 */
const isAllowedFetch = (req: IncomingMessage, pathname: string): boolean => {
  const site = req.headers['sec-fetch-site']

  // The open route acts on the viewer's machine, so only the atlas page itself may call it.
  if (req.method === 'POST') return site === 'same-origin'

  if (site === undefined || SAFE_FETCH_SITES.has(site)) return true

  return (
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document' &&
    PAGE_PATHS.has(pathname)
  )
}

const hostnameOf = (target: unknown): string | null => {
  if (typeof target !== 'string' && !(target instanceof URL)) return null

  try {
    return new URL(target).hostname
  } catch {
    return null
  }
}

/**
 * vite's `createProxyContextMatcher` rule, probed with the route key as the path. A regex key cannot be probed
 * with a path, so it only ever wins for itself; an invalid one matches nothing rather than throwing.
 */
const contextMatches = (candidate: string, key: string): boolean => {
  if (candidate === key) return true
  if (key.startsWith('^')) return false
  if (!candidate.startsWith('^')) return key.startsWith(candidate)

  try {
    return new RegExp(candidate).test(key)
  } catch {
    return false
  }
}

/** Hostname only: the runner compares hosts, and a full target could carry userinfo or a query. */
const servedRoutesHeader = (options: AtlasForwardOptions): string | null => {
  const emitted = options.emittedKeys()
  const routes: Record<string, { host: string | null; user: boolean }> = {}

  const entries = Object.entries(options.proxy() ?? {})

  for (const [key] of entries) {
    // vite's proxy serves a request from the first matching key in insertion order, and `mergeConfig` puts the
    // consumer's keys before ours, so a user `/` takes `/api` traffic: report the key that actually wins.
    const [winner, entry] = entries.find(([candidate, value]) => {
      return Boolean(value) && contextMatches(candidate, key)
    }) ?? [key, undefined]

    const target = typeof entry === 'object' && entry !== null ? (entry as { target?: unknown }).target : entry

    routes[key] = { host: hostnameOf(target), user: !emitted.has(winner) }
  }

  const value = encodeURIComponent(JSON.stringify(routes))

  return Buffer.byteLength(value) > SERVED_ROUTES_MAX_BYTES ? null : value
}

const without = <T extends object>(source: T, names: readonly string[]): T => {
  const copy = { ...source }

  for (const name of names) delete copy[name as keyof T]

  return copy
}

const forwardHeaders = (
  req: IncomingMessage,
  endpoint: AtlasEndpoint,
  options: AtlasForwardOptions,
): OutgoingHttpHeaders => {
  // The runner is another origin's server: the app's session cookie and credentials have no business there.
  const headers = without(req.headers, ['cookie', 'authorization', ATLAS_SITE_HEADER, ATLAS_SERVED_ROUTES_HEADER])
  const servedRoutes = servedRoutesHeader(options)

  return {
    ...headers,
    host: new URL(endpoint.url).host,
    [ATLAS_TOKEN_HEADER]: endpoint.token,
    ...(options.site === null ? {} : { [ATLAS_SITE_HEADER]: options.site }),
    ...(servedRoutes === null ? {} : { [ATLAS_SERVED_ROUTES_HEADER]: servedRoutes }),
  }
}

const serveDown = (req: IncomingMessage, res: ServerResponse, pathname: string, hint = ''): void => {
  const isState = pathname === STATE_PATH

  res.statusCode = 503
  res.setHeader('Content-Type', isState ? 'application/json' : 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const body = isState ? '{"runner":"down"}' : DOWN_PAGE(hint)

  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Relays the upstream response, or reports `false` when it is not the runner that holds the token. */
const relayResponse = (upstream: IncomingMessage, res: ServerResponse, token: string): boolean => {
  // A reused port held by another process answers without the token; it must not be shown as the atlas.
  if (upstream.headers[ATLAS_TOKEN_HEADER] !== token) {
    upstream.resume()

    return false
  }

  res.writeHead(
    upstream.statusCode ?? 502,
    without(upstream.headers, [ATLAS_TOKEN_HEADER, 'access-control-allow-origin']),
  )
  upstream.pipe(res)

  return true
}

const forward = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  endpoint: AtlasEndpoint,
  options: AtlasForwardOptions,
): void => {
  const target = new URL(endpoint.url)
  let settled = false

  const fail = (): void => {
    if (settled) return
    settled = true
    if (res.headersSent) res.destroy()
    else serveDown(req, res, pathname)
  }

  const upstreamReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, endpoint, options),
      timeout: FORWARD_TIMEOUT_MS,
    },
    (upstream) => {
      if (relayResponse(upstream, res, endpoint.token)) {
        settled = true

        return
      }
      fail()
    },
  )

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy()
  })
  upstreamReq.on('error', fail)
  res.on('close', () => {
    upstreamReq.destroy()
  })
  if (req.method === 'POST') req.pipe(upstreamReq)
  else upstreamReq.end()
}

/**
 * Connect middleware that relays `/__atlas` and everything under it to the `infra-kit dev` runner whose address
 * arrives in `INFRA_KIT_ATLAS`. Read per request, so a runner started after vite is still found. When the
 * runner cannot be reached it serves a "runner is not running" page (or `{"runner":"down"}` for the JSON).
 */
export const createAtlasForward = (options: AtlasForwardOptions) => {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const pathname = pathnameOf(req.url ?? '/')

    if (pathname !== ATLAS_PATH && !pathname.startsWith(`${ATLAS_PATH}/`)) {
      next()

      return
    }

    // vite's `cors` ran first and already allowed any `*.localhost` origin on `res`; no atlas response may carry it.
    res.removeHeader('access-control-allow-origin')
    res.removeHeader('access-control-allow-credentials')

    const isOpen = req.method === 'POST' && pathname === OPEN_PATH

    if (req.method !== 'GET' && req.method !== 'HEAD' && !isOpen) {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()

      return
    }

    if (!isAllowedFetch(req, pathname)) {
      res.statusCode = 403
      res.end()

      return
    }

    const endpoint = readAtlasEndpoint(process.env)

    if (endpoint === null) {
      serveDown(req, res, pathname, UPDATE_HINT)

      return
    }

    forward(req, res, pathname, endpoint, options)
  }
}
