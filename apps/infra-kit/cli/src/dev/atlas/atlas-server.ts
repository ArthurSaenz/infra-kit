import type { AtlasEndpoint } from '@slip-stream-kit/config/internal'
import {
  ATLAS_PATH,
  ATLAS_SERVED_ROUTES_HEADER,
  ATLAS_SITE_HEADER,
  ATLAS_TOKEN_HEADER,
} from '@slip-stream-kit/config/internal'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { readAtlasAsset } from './atlas-asset.js'
import type { AtlasAssetName, AtlasAssetReader } from './atlas-asset.js'
import type { AtlasSnapshot } from './atlas-contract.js'
import type { AtlasOpenResult } from './atlas-open.js'
import { parseServedRoutes } from './atlas-snapshot.js'
import type { ServedRoutes } from './atlas-snapshot.js'

export interface AtlasSnapshotRequest {
  siteId: string | null
  served: ServedRoutes | null
}

export interface AtlasServerOptions {
  snapshot: (request: AtlasSnapshotRequest) => AtlasSnapshot
  readAsset?: AtlasAssetReader
  /** Absent in a server that only serves the page; the open route then answers 404. */
  open?: (id: string) => Promise<AtlasOpenResult>
}

export interface AtlasServerHandle {
  endpoint: AtlasEndpoint
  port: number
  close: () => Promise<void>
}

const LOOPBACK = '127.0.0.1'
const STATE_PATH = `${ATLAS_PATH}/state.json`
const OPEN_PATH = `${ATLAS_PATH}/open`
const OPEN_BODY_MAX_BYTES = 1024
const OPEN_STATUS: Readonly<Record<AtlasOpenResult, number>> = { opened: 204, unknown: 404, unavailable: 501 }

const ASSETS: Readonly<Record<string, { name: AtlasAssetName; type: string }>> = {
  [ATLAS_PATH]: { name: 'index.html', type: 'text/html; charset=utf-8' },
  [`${ATLAS_PATH}/`]: { name: 'index.html', type: 'text/html; charset=utf-8' },
  [`${ATLAS_PATH}/app.js`]: { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  [`${ATLAS_PATH}/app.css`]: { name: 'app.css', type: 'text/css; charset=utf-8' },
}

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The atlas page is not built</title>
</head>
<body>
<h1>The atlas page is not built</h1>
<p>atlas page not built — run <code>pnpm --filter infra-kit run build</code></p>
</body>
</html>
`

const pathnameOf = (url: string): string => {
  return url.split('?')[0] ?? url
}

const tokenMatches = (presented: string | string[] | undefined, token: Buffer): boolean => {
  if (typeof presented !== 'string') return false

  const candidate = Buffer.from(presented)

  return candidate.length === token.length && timingSafeEqual(candidate, token)
}

const headerValue = (value: string | string[] | undefined): string | undefined => {
  return typeof value === 'string' ? value : undefined
}

const send = (
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string | null,
  body: string | Buffer = '',
): void => {
  res.statusCode = status
  if (type !== null) res.setHeader('Content-Type', type)
  res.end(req.method === 'HEAD' ? undefined : body)
}

const serveState = (req: IncomingMessage, res: ServerResponse, options: AtlasServerOptions): void => {
  const snapshot = options.snapshot({
    siteId: headerValue(req.headers[ATLAS_SITE_HEADER]) ?? null,
    served: parseServedRoutes(headerValue(req.headers[ATLAS_SERVED_ROUTES_HEADER])),
  })

  const etag = `"${snapshot.revision}"`

  res.setHeader('ETag', etag)
  if (req.headers['if-none-match'] === etag) {
    send(req, res, 304, null)

    return
  }

  send(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot))
}

const serveAsset = (req: IncomingMessage, res: ServerResponse, pathname: string, read: AtlasAssetReader): void => {
  const asset = ASSETS[pathname]!
  const body = read(asset.name)

  if (body !== null) {
    send(req, res, 200, asset.type, body)

    return
  }

  if (asset.name === 'index.html') send(req, res, 200, asset.type, NOT_BUILT_PAGE)
  else send(req, res, 404, null)
}

const readOpenId = async (req: IncomingMessage): Promise<string | null> => {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > OPEN_BODY_MAX_BYTES) return null
    chunks.push(chunk as Buffer)
  }

  try {
    const id = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown } | null)?.id

    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

const serveOpen = async (req: IncomingMessage, res: ServerResponse, options: AtlasServerOptions): Promise<void> => {
  const id = await readOpenId(req)

  if (id === null) {
    send(req, res, 400, null)

    return
  }

  send(req, res, options.open === undefined ? 404 : OPEN_STATUS[await options.open(id)], null)
}

const handle = (
  req: IncomingMessage,
  res: ServerResponse,
  options: AtlasServerOptions,
  auth: { host: string; token: Buffer; tokenHex: string },
): void => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', "default-src 'self'")
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // DNS rebinding: a page that rebinds its own name to 127.0.0.1 still sends its own name as the Host.
  // Neither refusal carries the token header, so the token is never told to a caller that lacks it.
  if (req.headers.host !== auth.host || !tokenMatches(req.headers[ATLAS_TOKEN_HEADER], auth.token)) {
    send(req, res, 403, null)

    return
  }

  // The forwarder verifies this before relaying: a reused port held by another process cannot echo it.
  res.setHeader(ATLAS_TOKEN_HEADER, auth.tokenHex)

  const pathname = pathnameOf(req.url ?? '/')

  // The one route that acts: it opens a window for the viewer and changes nothing in the run.
  if (pathname === OPEN_PATH && req.method === 'POST') {
    serveOpen(req, res, options).catch(() => {
      if (!res.headersSent) send(req, res, 500, null)
    })

    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    send(req, res, 405, null)

    return
  }

  if (pathname === STATE_PATH) serveState(req, res, options)
  else if (Object.hasOwn(ASSETS, pathname)) serveAsset(req, res, pathname, options.readAsset ?? readAtlasAsset)
  else send(req, res, 404, null)
}

/**
 * The runner's loopback atlas server: the page, its assets and the live snapshot, reachable only through
 * the vite forwarder that holds the token. The listener and every accepted socket are `unref`'d, so neither
 * the server nor an idle keep-alive connection from vite can hold the runner open on its own.
 */
export const startAtlasServer = async (options: AtlasServerOptions): Promise<AtlasServerHandle> => {
  const token = randomBytes(32)
  const tokenHex = token.toString('hex')
  const auth = { host: '', token: Buffer.from(tokenHex), tokenHex }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, options, auth)
    } catch {
      // A snapshot that throws must not take the runner down; the page shows "disconnected" and retries.
      if (!res.headersSent) res.removeHeader(ATLAS_TOKEN_HEADER)
      send(req, res, 500, null)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.unref()
  // `server.unref()` covers the listener only; each accepted socket is its own ref'd handle.
  server.on('connection', (socket) => {
    socket.unref()
  })

  const { port } = server.address() as AddressInfo

  auth.host = `${LOOPBACK}:${port}`

  return {
    endpoint: { url: `http://${LOOPBACK}:${port}`, token: tokenHex },
    port,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
}
