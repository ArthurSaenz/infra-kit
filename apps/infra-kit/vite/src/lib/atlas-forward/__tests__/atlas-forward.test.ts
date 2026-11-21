import { ATLAS_ENV, serializeAtlasEndpoint } from '@slip-stream-kit/config/internal'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtlasForwardOptions } from '../atlas-forward'
import { createAtlasForward } from '../atlas-forward'

const TOKEN = 'a'.repeat(64)

const SAME_SITE_NAVIGATION = {
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

interface Recorded {
  url: string
  method: string
  headers: http.IncomingHttpHeaders
  body: Promise<string>
}

const bodyOf = (req: http.IncomingMessage): Promise<string> => {
  return new Promise((resolve) => {
    let body = ''

    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      resolve(body)
    })
  })
}

type StubHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

const servers: net.Server[] = []
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ATLAS_ENV]
  delete process.env[ATLAS_ENV]
})

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ATLAS_ENV]
  else process.env[ATLAS_ENV] = savedEnv

  await Promise.all(
    servers.splice(0).map((server) => {
      return new Promise<void>((resolve) => {
        if (server instanceof http.Server) server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      })
    }),
  )
})

const listen = async (server: net.Server): Promise<number> => {
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  return (server.address() as AddressInfo).port
}

const pointAtlasAt = (port: number, token = TOKEN): void => {
  process.env[ATLAS_ENV] = serializeAtlasEndpoint({ url: `http://127.0.0.1:${port}`, token })
}

/** A runner stand-in that records what it was sent and answers with the real token unless told otherwise. */
const startRunner = async (handler?: StubHandler): Promise<Recorded[]> => {
  const received: Recorded[] = []

  const server = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: bodyOf(req) })
    if (handler) {
      handler(req, res)

      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-infra-kit-atlas-token': TOKEN,
      'access-control-allow-origin': '*',
      etag: '"v1"',
    })
    res.end('{"ok":true}')
  })

  pointAtlasAt(await listen(server))

  return received
}

const OPTIONS: AtlasForwardOptions = {
  site: 'client-ui',
  proxy: () => {
    return { '/api': { target: 'https://user:pw@dev.example.com:8443/x?q=1' }, '/raw': 'http://raw.test' }
  },
  emittedKeys: () => {
    return new Set(['/api'])
  },
}

interface Served {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  nextCalled: boolean
}

/** The middleware mounted alone on a real server, so the browser side sees exactly what it would. */
const request = async (
  path: string,
  headers: http.OutgoingHttpHeaders = {},
  options: AtlasForwardOptions = OPTIONS,
  send: { method: string; body?: string } = { method: 'GET' },
): Promise<Served> => {
  const middleware = createAtlasForward(options)
  let nextCalled = false

  const app = http.createServer((req, res) => {
    // Stands in for vite's `cors`, which runs first and allows any `*.localhost` origin on `res`.
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    middleware(req, res, () => {
      nextCalled = true
      res.statusCode = 404
      res.end('next')
    })
  })

  const port = await listen(app)

  return new Promise<Served>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method: send.method, agent: false }, (res) => {
      let body = ''

      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, nextCalled })
      })
    })

    req.on('error', reject)
    req.end(send.body)
  })
}

const expectDown = (served: Served, kind: 'page' | 'json'): void => {
  expect(served.status).toBe(503)
  if (kind === 'json') {
    expect(served.headers['content-type']).toBe('application/json')
    expect(JSON.parse(served.body)).toEqual({ runner: 'down' })
  } else {
    expect(served.headers['content-type']).toMatch(/^text\/html/)
    expect(served.body).toContain('runner is not running')
  }
}

describe('createAtlasForward', () => {
  it('serves the not-running page, with an update hint, when no runner address was handed over', async () => {
    const served = await request('/__atlas')

    expectDown(served, 'page')
    expect(served.body).toContain('Update <code>infra-kit</code>')
  })

  it('answers the JSON with {"runner":"down"} when no runner address was handed over', async () => {
    const served = await request('/__atlas/state.json')

    expectDown(served, 'json')
    expect(served.headers['cache-control']).toBe('no-store')
  })

  it('serves the not-running page when the runner port refuses the connection', async () => {
    const closed = net.createServer()
    const port = await listen(closed)

    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve()
      })
    })
    servers.splice(servers.indexOf(closed), 1)
    pointAtlasAt(port)

    const served = await request('/__atlas')

    expectDown(served, 'page')
    expect(served.body).not.toContain('Update <code>infra-kit</code>')
  })

  it('gives up on a runner that never answers within the timeout', async () => {
    await startRunner(() => {})

    const startedAt = Date.now()
    const served = await request('/__atlas/state.json')

    expectDown(served, 'json')
    expect(Date.now() - startedAt).toBeLessThanOrEqual(2000)
  })

  it('refuses a response without the token, as a reused port held by another process', async () => {
    await startRunner((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'x-infra-kit-atlas-token': 'b'.repeat(64) })
      res.end('<h1>someone else</h1>')
    })

    const served = await request('/__atlas')

    expectDown(served, 'page')
    expect(served.body).not.toContain('someone else')
  })

  it('passes a runner response through, with the token and the ACAO header stripped', async () => {
    await startRunner()

    const served = await request('/__atlas/state.json')

    expect(served.status).toBe(200)
    expect(served.body).toBe('{"ok":true}')
    expect(served.headers.etag).toBe('"v1"')
    expect(served.headers['x-infra-kit-atlas-token']).toBeUndefined()
    expect(served.headers['access-control-allow-origin']).toBeUndefined()
    expect(JSON.stringify(served.headers)).not.toContain(TOKEN)
  })

  it('relays If-None-Match and passes a 304 through', async () => {
    const received = await startRunner((req, res) => {
      res.writeHead(req.headers['if-none-match'] === '"v1"' ? 304 : 200, { 'x-infra-kit-atlas-token': TOKEN })
      res.end()
    })

    const served = await request('/__atlas/state.json', { 'if-none-match': '"v1"' })

    expect(served.status).toBe(304)
    expect(received[0]?.headers['if-none-match']).toBe('"v1"')
    expect(JSON.stringify(served.headers)).not.toContain(TOKEN)
  })

  it('sets the runner host, token, site and served routes, overwriting any client-sent copy', async () => {
    const received = await startRunner()

    await request('/__atlas/state.json', {
      'x-infra-kit-site': 'spoofed',
      'x-infra-kit-served-routes': 'spoofed',
      'x-infra-kit-atlas-token': 'spoofed',
    })

    const headers: http.IncomingHttpHeaders = received[0]?.headers ?? {}
    const { url } = JSON.parse(process.env[ATLAS_ENV] ?? '{}') as { url: string }

    expect(headers.host).toBe(new URL(url).host)
    expect(headers['x-infra-kit-atlas-token']).toBe(TOKEN)
    expect(headers['x-infra-kit-site']).toBe('client-ui')
    expect(JSON.parse(decodeURIComponent(headers['x-infra-kit-served-routes'] as string))).toEqual({
      '/api': { host: 'dev.example.com', user: false },
      '/raw': { host: 'raw.test', user: true },
    })
  })

  describe('served routes resolve each key to the one vite would serve it from', () => {
    const servedRoutesFor = async (proxy: Record<string, unknown>, emitted: string[]): Promise<unknown> => {
      const received = await startRunner()

      await request(
        '/__atlas/state.json',
        {},
        {
          site: 'client-ui',
          proxy: () => {
            return proxy
          },
          emittedKeys: () => {
            return new Set(emitted)
          },
        },
      )

      return JSON.parse(decodeURIComponent(received[0]?.headers['x-infra-kit-served-routes'] as string))
    }

    it('reports a plugin route shadowed by an earlier user `/` as the user’s', async () => {
      const routes = await servedRoutesFor({ '/': 'http://user.test', '/api': { target: 'https://dev.example.com' } }, [
        '/api',
      ])

      expect(routes).toEqual({ '/': { host: 'user.test', user: true }, '/api': { host: 'user.test', user: true } })
    })

    it('reports a plugin route with no earlier match as the plugin’s own', async () => {
      const routes = await servedRoutesFor(
        { '/other': 'http://user.test', '/api': { target: 'https://dev.example.com' } },
        ['/api'],
      )

      expect(routes).toMatchObject({ '/api': { host: 'dev.example.com', user: false } })
    })

    it('lets an earlier user regex key shadow a plugin route', async () => {
      const routes = await servedRoutesFor(
        { '^/.*': 'http://user.test', '/api': { target: 'https://dev.example.com' } },
        ['/api'],
      )

      expect(routes).toEqual({ '^/.*': { host: 'user.test', user: true }, '/api': { host: 'user.test', user: true } })
    })

    it('treats an invalid regex key as matching nothing instead of throwing', async () => {
      const routes = await servedRoutesFor(
        { '^/(': 'http://user.test', '/api': { target: 'https://dev.example.com' } },
        ['/api'],
      )

      expect(routes).toEqual({
        '^/(': { host: 'user.test', user: true },
        '/api': { host: 'dev.example.com', user: false },
      })
    })
  })

  it.each([
    ['relayed', true],
    ['down', false],
  ])('drops the CORS headers vite already set, on a %s response', async (_kind, runnerUp) => {
    if (runnerUp) await startRunner()

    const served = await request('/__atlas/state.json', { origin: 'https://other.localhost' })

    expect(served.status).toBe(runnerUp ? 200 : 503)
    expect(served.headers['access-control-allow-origin']).toBeUndefined()
    expect(served.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('drops the CORS headers vite already set, on a 403', async () => {
    const served = await request('/__atlas/app.js', {
      origin: 'https://other.localhost',
      'sec-fetch-site': 'same-site',
    })

    expect(served.status).toBe(403)
    expect(served.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('omits the served-routes header when it would exceed 8 KB', async () => {
    const received = await startRunner()

    const proxy = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => {
        return [`/route-${index}`, `https://host-${index}.example.com`]
      }),
    )

    await request(
      '/__atlas/state.json',
      {},
      {
        ...OPTIONS,
        proxy: () => {
          return proxy
        },
      },
    )

    expect(received[0]?.headers['x-infra-kit-served-routes']).toBeUndefined()
  })

  it('never forwards the browser’s cookie or authorization', async () => {
    const received = await startRunner()

    await request('/__atlas/state.json', { cookie: 'session=secret', authorization: 'Bearer secret' })

    expect(received[0]?.headers.cookie).toBeUndefined()
    expect(received[0]?.headers.authorization).toBeUndefined()
  })

  it('matches on the pathname alone, so a query string still reaches the runner', async () => {
    const received = await startRunner()

    const served = await request('/__atlas/state.json?x=1')

    expect(served.status).toBe(200)
    expect(received[0]?.url).toBe('/__atlas/state.json?x=1')
  })

  it('refuses a cross-site read of the JSON', async () => {
    const received = await startRunner()

    const served = await request('/__atlas/state.json', { 'sec-fetch-site': 'cross-site' })

    expect(served.status).toBe(403)
    expect(received).toHaveLength(0)
  })

  it('forwards a same-site top-level navigation to the page', async () => {
    const received = await startRunner()

    const served = await request('/__atlas', SAME_SITE_NAVIGATION)

    expect(served.status).toBe(200)
    expect(received).toHaveLength(1)
  })

  it.each(['/__atlas/state.json', '/__atlas/app.js'])(
    'refuses the same same-site navigation headers on %s',
    async (path) => {
      const received = await startRunner()

      const served = await request(path, SAME_SITE_NAVIGATION)

      expect(served.status).toBe(403)
      expect(received).toHaveLength(0)
    },
  )

  describe('the open route', () => {
    const BODY = '{"id":"run-folder"}'

    const post = (path: string, site: string | undefined) => {
      const headers = { 'content-type': 'application/json', ...(site === undefined ? {} : { 'sec-fetch-site': site }) }

      return request(path, headers, OPTIONS, { method: 'POST', body: BODY })
    }

    it('relays a POST from the atlas page itself, body included', async () => {
      const received = await startRunner()

      const served = await post('/__atlas/open', 'same-origin')

      expect(served.status).toBe(200)
      expect(received).toHaveLength(1)
      expect(received[0]!.method).toBe('POST')
      expect(await received[0]!.body).toBe(BODY)
      expect(received[0]!.headers['x-infra-kit-atlas-token']).toBe(TOKEN)
    })

    it.each(['same-site', 'cross-site', 'none', undefined])(
      'refuses a POST whose sec-fetch-site is %s',
      async (site) => {
        const received = await startRunner()

        const served = await post('/__atlas/open', site)

        expect(served.status).toBe(403)
        expect(received).toHaveLength(0)
      },
    )

    it('still answers 405 to a POST anywhere else under the atlas', async () => {
      const received = await startRunner()

      const served = await post('/__atlas/state.json', 'same-origin')

      expect(served.status).toBe(405)
      expect(received).toHaveLength(0)
    })
  })

  it('hands every other path to next() untouched', async () => {
    const received = await startRunner()
    const readSpy = vi.fn()

    const served = await request('/__atlasx', {}, { ...OPTIONS, proxy: readSpy })

    expect(served.nextCalled).toBe(true)
    expect(received).toHaveLength(0)
    expect(readSpy).not.toHaveBeenCalled()
  })
})
