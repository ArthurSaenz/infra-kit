import { ATLAS_ENV, serializeAtlasEndpoint } from '@slip-stream-kit/config/internal'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import process from 'node:process'
import type { ViteDevServer } from 'vite'
import { createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cleanupRepos, createRepo } from '../../__tests__/fixtures'
import { infraKit } from '../plugin'

const TOKEN = 'c'.repeat(64)

let savedEnv: NodeJS.ProcessEnv
const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  savedEnv = { ...process.env }
})

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  cleanupRepos()
  process.env = savedEnv
})

/** A server that records the path and headers of every request it gets, answering with `headers`. */
const startRecorder = async (headers: http.OutgoingHttpHeaders = {}) => {
  const received: { url: string; headers: http.IncomingHttpHeaders }[] = []

  const server = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain', ...headers })
    res.end('recorded')
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const urlsOf = (received: { url: string }[]): string[] => {
  return received.map((entry) => {
    return entry.url
  })
}

const getResponse = async (
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> => {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      res.resume()
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers })
      })
    })

    req.on('error', reject)
    req.end()
  })
}

const get = async (port: number, path: string): Promise<number> => {
  return (await getResponse(port, path)).status
}

/** A real vite on the fixture package, `/api` resolving to the cloud, with the atlas pointed at a stub runner. */
const bootVite = async (userProxy?: Record<string, { target: string }>) => {
  const repo = createRepo()
  const atlas = await startRecorder({ 'x-infra-kit-atlas-token': TOKEN })

  process.env.CLIENT_URL = 'https://dev.example.com'
  process.env[ATLAS_ENV] = serializeAtlasEndpoint({ url: atlas.url, token: TOKEN })

  const server: ViteDevServer = await createServer({
    configFile: false,
    root: repo.dir,
    logLevel: 'silent',
    appType: 'spa',
    base: '/app/',
    plugins: [infraKit({ cwd: repo.dir, restartOnDevContextChange: false })],
    server: userProxy ? { proxy: userProxy } : {},
  })

  closers.push(async () => {
    await server.close()
  })
  await server.listen()

  const { port } = server.httpServer?.address() as AddressInfo

  const servedRoutes = (): Record<string, unknown> => {
    const header = atlas.received[0]?.headers['x-infra-kit-served-routes']

    return JSON.parse(decodeURIComponent(header as string)) as Record<string, unknown>
  }

  return { atlas, port, servedRoutes }
}

describe('the atlas forwarder inside a real vite dev server', () => {
  it('sees /__atlas ahead of a catch-all proxy and reports the route that really serves /api', async () => {
    const upstream = await startRecorder()

    const { atlas, port, servedRoutes } = await bootVite({
      '/': { target: upstream.url },
      '^/.*': { target: upstream.url },
    })

    expect(await get(port, '/__atlas')).toBe(200)
    expect(urlsOf(atlas.received)).toEqual(['/__atlas'])

    expect(await get(port, '/orders/1')).toBe(200)
    // The header and the traffic must agree: the user's `/` takes `/api` too, so both say "user".
    expect(await get(port, '/api/x')).toBe(200)
    expect(urlsOf(upstream.received)).toEqual(['/orders/1', '/api/x'])

    const routes = servedRoutes()

    expect(routes['/']).toEqual({ host: '127.0.0.1', user: true })
    expect(routes['^/.*']).toEqual({ host: '127.0.0.1', user: true })
    expect(routes['/api']).toEqual({ host: '127.0.0.1', user: true })
    expect(atlas.received[0]?.headers['x-infra-kit-site']).toBe('client-ui')
  })

  it('reports /api as the plugin’s cloud route when no user key shadows it', async () => {
    const { port, servedRoutes } = await bootVite()

    expect(await get(port, '/__atlas')).toBe(200)
    expect(servedRoutes()['/api']).toEqual({ host: 'dev.example.com', user: false })
  })

  it('strips the CORS headers vite’s own cors set for another *.localhost origin, runner up or down', async () => {
    const { port } = await bootVite()
    const origin = { origin: 'https://other.localhost' }

    const up = await getResponse(port, '/__atlas/state.json', origin)

    expect(up.status).toBe(200)
    expect(up.headers['access-control-allow-origin']).toBeUndefined()

    delete process.env[ATLAS_ENV]

    const down = await getResponse(port, '/__atlas/state.json', origin)

    expect(down.status).toBe(503)
    expect(down.headers['access-control-allow-origin']).toBeUndefined()
    // Control: outside /__atlas vite's cors is untouched, so the header above was really there to strip.
    expect((await getResponse(port, '/app/', origin)).headers['access-control-allow-origin']).toBe(
      'https://other.localhost',
    )
  })
})
