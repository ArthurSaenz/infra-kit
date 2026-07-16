/**
 * The health probe, against a REAL `node:http` server standing in for vite's ping middleware.
 *
 * There is deliberately no `vite` here. Booting a real vite would put a heavy dependency into a PUBLISHED
 * package in order to re-assert a fact about vite (that it answers `accept: text/x-vite-ping` with a 204),
 * which is already established for 6.0.0 → 8.0.10. What these tests own is OUR code: the 204 verdict, the
 * html-fallback non-forgery, the base-relative redirect hop, the header re-send on that hop, and the
 * origins we refuse to follow.
 *
 * `defaultHealthProbe` is module-private, so it is reached through the seam the source already exposes: it
 * is the DEFAULT of {@link DevServerRunner}'s 7th constructor argument. Constructing a runner without a
 * probe and reading the field back is therefore the exact function production runs — no test-only export,
 * and no second implementation that could drift from it.
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import type { HealthProbe, ProbeOutcome, ProbeTarget } from 'src/dev/dev-server'

import { getFreePort } from './fixtures'

/** The private field the runner's 7th ctor arg lands in — `defaultHealthProbe` when nothing is injected. */
interface ProbeSeam {
  healthProbe: HealthProbe
}

let cached: HealthProbe | null = null

/** The REAL default probe, taken from an un-injected runner (its ctor default IS `defaultHealthProbe`). */
const probe = (target: ProbeTarget): Promise<ProbeOutcome> => {
  // `json: true` keeps the ctor off the terminal-owning path (no Ink, no output interception).
  cached ??= (new DevServerRunner({ json: true }) as unknown as ProbeSeam).healthProbe

  return cached(target)
}

/** The header vite's HMR client sends. A server that answers it with 204 IS a vite dev server. */
const isVitePing = (req: http.IncomingMessage): boolean => {
  return req.headers.accept === 'text/x-vite-ping'
}

interface TestServer {
  port: number
  /**
   * Every request this server actually received. Load-bearing for the cross-origin test: `foreign` is a
   * verdict AND a refusal to follow, and only a request counter on the second origin can prove the refusal.
   */
  requests: string[]
}

/** Open sockets are closed here, not just the listeners — a hung request would otherwise hold `close()`. */
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(
    closers.splice(0).map((close) => {
      return close()
    }),
  )
})

/** A real `node:http` server on an OS-assigned port on 127.0.0.1, closed in `afterEach`. */
const startServer = async (handler: http.RequestListener): Promise<TestServer> => {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    handler(req, res)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      return resolve()
    })
  })

  closers.push(() => {
    return new Promise<void>((resolve) => {
      // A test that deliberately hangs a request leaves a live socket; `close()` alone would wait for it.
      server.closeAllConnections()
      server.close(() => {
        return resolve()
      })
    })
  })

  return { port: (server.address() as AddressInfo).port, requests }
}

/** A vite stand-in: 204 on the ping header, `200 text/html` on anything else (vite's `htmlFallback`). */
const viteLike: http.RequestListener = (req, res) => {
  if (isVitePing(req)) {
    res.writeHead(204).end()

    return
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><div id="root"></div>')
}

const uiTarget = (port: number): ProbeTarget => {
  return { tag: 'shop/ui', port, kind: 'ui' }
}

const apiTarget = (port: number): ProbeTarget => {
  return { tag: 'shop/api', port, kind: 'api' }
}

describe('defaultHealthProbe — a frontend (vite’s HMR ping)', () => {
  it('calls a server that answers the ping header with 204 `ok`', async () => {
    const server = await startServer(viteLike)

    expect(await probe(uiTarget(server.port))).toBe('ok')
  })

  it('calls a `200 text/html` answer `foreign`, NEVER `ok` — the html-fallback false green', async () => {
    // This is the entire reason the probe is not a plain `GET /`. Vite's `htmlFallback` middleware answers
    // `/` with `200 index.html` even for a dev server whose entry module throws, so a naive GET reports a
    // broken app as healthy. It cannot forge a 204 — the ping sits AHEAD of it — and that is the whole
    // discriminator. A server that only ever serves html must never be called alive.
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>')
    })
    const outcome = await probe(uiTarget(server.port))

    expect(outcome).not.toBe('ok')
    // The verdict carries WHAT answered, because that is what makes the `◍ ?` warn actionable: `200 text/html`
    // is the signature of vite having dropped the ping (an infra-kit bug), and it must not read the same as
    // the 502 of a proxy shadowing the port or the 404 of a squatter.
    expect(outcome).toEqual({ kind: 'foreign', status: 200, contentType: 'text/html' })
  })

  it('calls nothing-listening `refused` (ECONNREFUSED is not a foreign answer)', async () => {
    // A free port with no listener: the connection is refused, which is proof of ABSENCE — distinct from
    // `foreign`, which is proof that something else is there.
    const port = await getFreePort()

    expect(await probe(uiTarget(port))).toBe('refused')
  })

  it('calls a server that hangs past the probe budget `refused`', async () => {
    // A wedged vite that accepts the socket and never answers must not stall the tick forever — the probe
    // carries its own 1500ms `AbortSignal.timeout`, and an aborted fetch is a refusal.
    const server = await startServer(() => {
      // Deliberately never responds: the request is accepted and left hanging.
    })
    const started = Date.now()

    expect(await probe(uiTarget(server.port))).toBe('refused')
    // It really was the timeout that decided this, not an instant transport error.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
  }, 10000)

  it('follows a RELATIVE `Location` hop and re-sends the ping header on it', async () => {
    // Two bugs in one assertion, both of which have bitten:
    //   1. Vite serves the ping from its `base`, so a UI on `base: '/app/'` answers `/` with a 3xx whose
    //      `Location` is RELATIVE (`/app/`). `new URL('/app/')` THROWS on its own — the hop must be
    //      resolved against the probe URL (`new URL(loc, base)`).
    //   2. The accept header must be RE-SENT on hop 2. This server answers `/app/` with a 204 ONLY when the
    //      ping header is present, and with `200 text/html` otherwise — exactly like vite's html fallback.
    //      A hop that dropped the header would therefore read `foreign`, and the dot would go dim on a
    //      perfectly healthy UI.
    const server = await startServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/app/' }).end()

        return
      }
      if (req.url === '/app/' && isVitePing(req)) {
        res.writeHead(204).end()

        return
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>')
    })

    expect(await probe(uiTarget(server.port))).toBe('ok')
    expect(server.requests).toEqual(['/', '/app/'])
  })

  it('refuses a CROSS-ORIGIN redirect — `foreign`, and the other origin is never even dialled', async () => {
    // A redirect off our loopback origin is somebody else's server, and its 204 would say nothing about
    // OUR vite. The verdict alone is not the invariant: the probe must not FOLLOW it. Only a request
    // counter on the second origin can prove that, so `other` is a real second `node:http` server.
    const other = await startServer(viteLike)
    const server = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}/` }).end()
    })

    // The 302 itself is what answered us, so that is what the verdict reports — not the 204 we refused to go
    // and fetch.
    expect(await probe(uiTarget(server.port))).toMatchObject({ kind: 'foreign', status: 302 })
    // The load-bearing half: zero requests reached the other origin.
    expect(other.requests).toEqual([])
    expect(server.requests).toEqual(['/'])
  })

  it('bounds the chase at ONE hop — a 2-hop redirect chain is `foreign`', async () => {
    // One hop is vite's `base`. A second is a loop we have no budget for inside the probe's single
    // 1500ms signal, so the chase stops and the row reports `foreign` rather than a hang.
    const server = await startServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/one/' }).end()

        return
      }
      if (req.url === '/one/') {
        res.writeHead(302, { location: '/two/' }).end()

        return
      }
      res.writeHead(204).end()
    })

    // Hop 2 answered another 302, and that is the answer the verdict carries.
    expect(await probe(uiTarget(server.port))).toMatchObject({ kind: 'foreign', status: 302 })
    // It stopped after the second hop: `/two/` — the 204 it would have called `ok` — was never requested.
    expect(server.requests).toEqual(['/', '/one/'])
  })
})

describe('defaultHealthProbe — a backend (`/__health`)', () => {
  it('calls a 2xx on `/__health` `ok`', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })

    expect(await probe(apiTarget(server.port))).toBe('ok')
    expect(server.requests).toEqual(['/__health'])
  })

  it('calls a 404 on `/__health` `foreign` — our own fastify answering non-2xx IS a failure', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(404).end()
    })

    expect(await probe(apiTarget(server.port))).toMatchObject({ kind: 'foreign', status: 404 })
  })
})
