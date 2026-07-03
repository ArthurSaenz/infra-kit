import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ServerlessLocalRun } from 'src/dev/serverless-local-run'

import { PREFIX, boot, canBind, getFreePort, handlerSource, makeApiFixture, spyStdoutWrite } from './fixtures'

/** Overwrite the compiled handler in an api fixture with custom source. */
const writeHandler = (apiDir: string, source: string): void => {
  fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), source)
}

/** Overwrite serverless.yml in an api fixture (for the error-path specs). */
const writeServerless = (apiDir: string, yml: string): void => {
  fs.writeFileSync(path.join(apiDir, 'serverless.yml'), yml)
}

const ORIGINAL_CWD = process.cwd()
const tmpDirs: string[] = []
const running: ServerlessLocalRun[] = []

let apiDir: string
let port: number

beforeEach(async () => {
  apiDir = makeApiFixture(1)
  tmpDirs.push(apiDir)
  port = await getFreePort()
})

afterEach(async () => {
  process.chdir(ORIGINAL_CWD)
  for (const server of running.splice(0)) {
    try {
      await server.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('serverlessLocalRun — boot + HTTP->Lambda transform', () => {
  it('serves a GET route with 200 and echoes query params into the Lambda event', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping?foo=bar&n=2`)

    expect(res.status).toBe(200)

    const body = (await res.json()) as { route: string; event: { queryStringParameters: Record<string, string> } }

    expect(body.route).toBe('ping')
    expect(body.event.queryStringParameters).toEqual({ foo: 'bar', n: '2' })
  })

  it('echoes a POST JSON body back as the Lambda event.body string', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace': 'abc123' },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(res.status).toBe(200)

    const body = (await res.json()) as { event: { body: string; headers: Record<string, string> } }

    // The transform stringifies the parsed request body onto event.body.
    expect(JSON.parse(body.event.body)).toEqual({ hello: 'world' })
    // Request headers flow through to event.headers.
    expect(body.event.headers['x-trace']).toBe('abc123')
  })

  it('maps a path parameter ({id}) into event.pathParameters', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/item/42`)
    const body = (await res.json()) as { event: { pathParameters: Record<string, string> } }

    expect(body.event.pathParameters).toEqual({ id: '42' })
  })

  it('populates event.httpMethod and event.path from the request', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)
    const body = (await res.json()) as {
      event: { httpMethod: string; path: string; requestContext: { httpMethod: string; resourcePath: string } }
    }

    expect(body.event.httpMethod).toBe('GET')
    expect(body.event.path).toBe(`${PREFIX}/ping`)
    expect(body.event.requestContext.httpMethod).toBe('GET')
    expect(body.event.requestContext.resourcePath).toBe(`${PREFIX}/ping`)
  })
})

describe('serverlessLocalRun — CORS + health', () => {
  it('answers an OPTIONS preflight with 204 and CORS headers', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`, { method: 'OPTIONS' })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS')
  })

  it('serves GET /__health with 200 {status:"ok"} carrying the app name', async () => {
    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}/__health`)

    expect(res.status).toBe(200)

    const body = (await res.json()) as { status: string; app: string; port: number }

    expect(body.status).toBe('ok')
    expect(body.app).toBe('testapp')
    expect(body.port).toBe(port)
  })

  it('reports app:null on /__health when the appName is omitted', async () => {
    // No chdir needed: the runner reads serverless.yml + the handler from controllersPath.
    const server = new ServerlessLocalRun({ controllersPath: apiDir, prefixUrl: PREFIX, port })

    running.push(server)
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/__health`)

    expect(res.status).toBe(200)

    const body = (await res.json()) as { app: string | null }

    expect(body.app).toBeNull()
  })
})

describe('serverlessLocalRun — Lambda context', () => {
  it('provides a functional getContext(): bounded remaining time, local ids, no-op callbacks', async () => {
    writeHandler(
      apiDir,
      [
        'export const ping = async (event, ctx) => ({',
        '  statusCode: 200,',
        "  headers: { 'content-type': 'application/json' },",
        '  body: JSON.stringify({',
        '    remaining: ctx.getRemainingTimeInMillis(),',
        '    arn: ctx.invokedFunctionArn,',
        '    reqId: ctx.awsRequestId,',
        "    noops: [ctx.done(), ctx.fail('e'), ctx.succeed('s')].every((r) => r === undefined),",
        '  }),',
        '})',
        '',
      ].join('\n'),
    )

    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)
    const body = (await res.json()) as { remaining: number; arn: string; reqId: string; noops: boolean }

    expect(res.status).toBe(200)
    // getRemainingTimeInMillis is positive and bounded by the 30s budget.
    expect(body.remaining).toBeGreaterThan(0)
    expect(body.remaining).toBeLessThanOrEqual(30000)
    expect(body.arn).toContain('lambda:local:')
    expect(body.reqId).toMatch(/^local-\d+$/)
    // done / fail / succeed are no-ops that return undefined without throwing.
    expect(body.noops).toBe(true)
  })

  it('returns 500 when a handler throws', async () => {
    writeHandler(apiDir, 'export const ping = async () => { throw new Error("boom") }\n')

    running.push(await boot(apiDir, port))

    const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)

    expect(res.status).toBe(500)
  })
})

describe('serverlessLocalRun — start() error paths', () => {
  it('rejects when a handler string points at a missing controller file', async () => {
    writeServerless(
      apiDir,
      [
        'service: t',
        'functions:',
        '  bad:',
        '    handler: dist/does-not-exist.ping',
        '    events:',
        '      - http:',
        '          method: get',
        '          path: bad',
        '',
      ].join('\n'),
    )

    await expect(boot(apiDir, port)).rejects.toThrow()
  })

  it('rejects with a clear error on an invalid HTTP method', async () => {
    writeServerless(
      apiDir,
      [
        'service: t',
        'functions:',
        '  ping:',
        '    handler: dist/handler.ping',
        '    events:',
        '      - http:',
        '          method: FOOBAR',
        '          path: ping',
        '',
      ].join('\n'),
    )

    await expect(boot(apiDir, port)).rejects.toThrow(/Invalid HTTP method/)
  })
})

describe('serverlessLocalRun — close releases the port', () => {
  it('frees the bound port after close() so a new listener can bind it', async () => {
    const server = await boot(apiDir, port)

    running.push(server)

    // Port is in use while running.
    expect(await canBind(port)).toBe(false)

    await server.close()
    running.splice(running.indexOf(server), 1)

    expect(await canBind(port)).toBe(true)
  })
})

describe('serverlessLocalRun — reload picks up a changed handler on a fresh instance', () => {
  // The reload mechanism is per-INSTANCE ESM cache-busting: each ServerlessLocalRun
  // sets a `?v=<timestamp>` query on the handler import, so a NEW instance loads the
  // rewritten dist file while the OLD instance keeps its already-imported module.
  it('serves v2 from a new instance after the dist handler is overwritten, while the old instance still serves v1', async () => {
    const original = await boot(apiDir, port)

    running.push(original)

    const v1 = (await (await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)).json()) as { version: number }

    expect(v1.version).toBe(1)

    // Overwrite the compiled handler in place (simulates a rebuild writing new dist output).
    writeHandler(apiDir, handlerSource(2))

    // Poll: boot a fresh instance (new cache-bust) until it serves v2, bounded to 3s.
    // The served response is the assertion — no fixed sleep stands in for it.
    const deadline = Date.now() + 3000
    let sawV2 = false

    while (Date.now() < deadline && !sawV2) {
      const reloadPort = await getFreePort()
      const reloaded = await boot(apiDir, reloadPort)

      const body = (await (await fetch(`http://127.0.0.1:${reloadPort}${PREFIX}/ping`)).json()) as { version: number }

      await reloaded.close()

      if (body.version === 2) {
        sawV2 = true
        break
      }
      await new Promise((r) => {
        return setTimeout(r, 50)
      })
    }

    expect(sawV2).toBe(true)

    // The original instance imported v1 once at start() and does NOT hot-reload.
    const stillV1 = (await (await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)).json()) as { version: number }

    expect(stillV1.version).toBe(1)
  })
})

describe('serverlessLocalRun — route key includes the HTTP method', () => {
  it('routes GET and POST on the same path to their OWN handlers (no method collision)', async () => {
    writeServerless(
      apiDir,
      [
        'service: t',
        'functions:',
        '  getThing:',
        '    handler: dist/handler.getThing',
        '    events:',
        '      - http:',
        '          method: get',
        '          path: thing',
        '  postThing:',
        '    handler: dist/handler.postThing',
        '    events:',
        '      - http:',
        '          method: post',
        '          path: thing',
        '',
      ].join('\n'),
    )
    writeHandler(
      apiDir,
      [
        'const ok = (route) => ({ statusCode: 200, headers: {}, body: JSON.stringify({ route }) })',
        'export const getThing = async () => ok("get-thing")',
        'export const postThing = async () => ok("post-thing")',
        '',
      ].join('\n'),
    )

    running.push(await boot(apiDir, port))

    const getBody = (await (await fetch(`http://127.0.0.1:${port}${PREFIX}/thing`)).json()) as { route: string }
    const postBody = (await (await fetch(`http://127.0.0.1:${port}${PREFIX}/thing`, { method: 'POST' })).json()) as {
      route: string
    }

    // Before the fix, both would resolve to whichever route registered last.
    expect(getBody.route).toBe('get-thing')
    expect(postBody.route).toBe('post-thing')
  })

  it('throws on a genuinely duplicate method+path route', async () => {
    writeServerless(
      apiDir,
      [
        'service: t',
        'functions:',
        '  a:',
        '    handler: dist/handler.ping',
        '    events:',
        '      - http:',
        '          method: get',
        '          path: dup',
        '  b:',
        '    handler: dist/handler.ping',
        '    events:',
        '      - http:',
        '          method: get',
        '          path: dup',
        '',
      ].join('\n'),
    )

    await expect(boot(apiDir, port)).rejects.toThrow(/Duplicate route/)
  })
})

describe('serverlessLocalRun — injected handler logger (real Powertools)', () => {
  it('lets a handler call info/debug/warn/error + createChild().info() without throwing, emitting output', async () => {
    const prevDev = process.env.POWERTOOLS_DEV

    process.env.POWERTOOLS_DEV = 'true'

    writeHandler(
      apiDir,
      [
        'export const ping = async (event, ctx, log) => {',
        "  log.info('info-mark')",
        "  log.debug('debug-mark')",
        "  log.warn('warn-mark')",
        "  log.error('error-mark')",
        "  log.createChild({ serviceName: 'child' }).info('child-mark')",
        '  return { statusCode: 200, headers: {}, body: JSON.stringify({ ok: true }) }',
        '}',
        '',
      ].join('\n'),
    )

    // Powertools DEV routes through the global console (info/debug -> stdout, warn/error -> stderr).
    // Spy the console methods directly — Node's Console dispatches writes through internal symbols
    // that a process.stdout.write spy would miss.
    const captured: string[] = []
    const collect = (...args: unknown[]): void => {
      captured.push(
        args
          .map((a) => {
            return String(a)
          })
          .join(' '),
      )
    }
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((method) => {
      return vi.spyOn(console, method).mockImplementation(collect as never)
    })

    try {
      running.push(await boot(apiDir, port))

      const res = await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)

      // A 200 means every log.* / createChild call returned without throwing (functional-break check).
      expect(res.status).toBe(200)
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
      if (prevDev == null) {
        delete process.env.POWERTOOLS_DEV
      } else {
        process.env.POWERTOOLS_DEV = prevDev
      }
    }

    const all = captured.join('')

    expect(all).toContain('info-mark')
    expect(all).toContain('debug-mark')
    expect(all).toContain('warn-mark')
    expect(all).toContain('error-mark')
    expect(all).toContain('child-mark')
  })
})

describe('serverlessLocalRun — getRegisteredRoutes', () => {
  it('returns the registered METHOD /path keys (sorted) and excludes /__health', async () => {
    const server = await boot(apiDir, port)

    running.push(server)

    // The api fixture declares ping (GET), echo (POST) and item/{id} (GET); {id} -> :id.
    expect(server.getRegisteredRoutes()).toEqual([
      `GET ${PREFIX}/item/:id`,
      `GET ${PREFIX}/ping`,
      `POST ${PREFIX}/echo`,
    ])
    // The internal liveness route is registered outside defineRoute and must not appear.
    expect(
      server.getRegisteredRoutes().some((r) => {
        return r.includes('__health')
      }),
    ).toBe(false)
  })
})

describe('serverlessLocalRun — opt-in request logging (DEV_SERVER_REQUEST_LOG)', () => {
  it('emits one "<method> <url> → <status> <ms>ms" line per request when set to 1', async () => {
    process.env.DEV_SERVER_REQUEST_LOG = '1'
    const writes: string[] = []
    const spy = spyStdoutWrite(writes)

    try {
      // The hook is wired in the constructor from the env, so boot AFTER setting it.
      running.push(await boot(apiDir, port))
      await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)
      // onResponse fires just after the response is sent; give it a beat.
      await new Promise((r) => {
        return setTimeout(r, 50)
      })
    } finally {
      spy.mockRestore()
      delete process.env.DEV_SERVER_REQUEST_LOG
    }

    // The request line is the only output using the ' → ' arrow (Powertools JSON never does).
    const reqLines = writes.filter((w) => {
      return w.includes('→')
    })

    expect(reqLines.length).toBeGreaterThanOrEqual(1)

    const joined = reqLines.join('')

    expect(joined).toContain('GET')
    expect(joined).toContain(`${PREFIX}/ping`)
    expect(joined).toContain('200')
  })

  it('writes no request line when the env var is unset', async () => {
    delete process.env.DEV_SERVER_REQUEST_LOG
    const writes: string[] = []
    const spy = spyStdoutWrite(writes)

    try {
      running.push(await boot(apiDir, port))
      await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)
      await new Promise((r) => {
        return setTimeout(r, 50)
      })
    } finally {
      spy.mockRestore()
    }

    expect(
      writes.filter((w) => {
        return w.includes('→')
      }),
    ).toHaveLength(0)
  })
})

describe('serverlessLocalRun — cwd independence (no chdir)', () => {
  it('imports the handler at the runner cwd, not the app dir (process.chdir removed)', async () => {
    writeHandler(
      apiDir,
      [
        // Captured at module-eval time, i.e. when the runner `import()`s the handler.
        'const cwdAtImport = process.cwd()',
        'export const ping = async () => ({',
        '  statusCode: 200,',
        '  headers: {},',
        '  body: JSON.stringify({ cwdAtImport }),',
        '})',
        '',
      ].join('\n'),
    )

    const bootCwd = process.cwd()

    running.push(await boot(apiDir, port))

    const body = (await (await fetch(`http://127.0.0.1:${port}${PREFIX}/ping`)).json()) as { cwdAtImport: string }

    // The handler module imported under the runner's cwd — NOT after a chdir into the app dir.
    expect(body.cwdAtImport).toBe(bootCwd)
    expect(body.cwdAtImport).not.toBe(apiDir)
  })
})
