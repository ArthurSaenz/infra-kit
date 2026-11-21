import { ATLAS_TOKEN_HEADER, readAtlasEndpoint } from '@slip-stream-kit/config/internal'
import type { AtlasEndpoint } from '@slip-stream-kit/config/internal'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtlasAssetReader } from 'src/dev/atlas/atlas-asset'
import type { AtlasSnapshot } from 'src/dev/atlas/atlas-contract'
import type { AtlasOpenResult, AtlasOpenTarget } from 'src/dev/atlas/atlas-open'
import { AtlasRuntime } from 'src/dev/atlas/atlas-state'
import { HealthLedger } from 'src/dev/health-ledger'

import { CLOUD_ENV, PLANNED, makeAtlasRepo, makeFacts } from './atlas-fixture'
import type { AtlasRepo } from './atlas-fixture'
import { atlasRequest } from './atlas-http'

let repo: AtlasRepo
let runtime: AtlasRuntime | null = null
let savedCloud: string | undefined

beforeEach(async () => {
  savedCloud = process.env[CLOUD_ENV]
  process.env[CLOUD_ENV] = 'https://dev.example.com'
  repo = await makeAtlasRepo()
})

afterEach(async () => {
  await runtime?.close()
  runtime = null
  if (savedCloud === undefined) delete process.env[CLOUD_ENV]
  else process.env[CLOUD_ENV] = savedCloud
  repo.cleanup()
})

type Opener = (target: AtlasOpenTarget) => Promise<AtlasOpenResult>

const start = async (
  options: { readAsset?: AtlasAssetReader; opener?: Opener } = {},
  ledger?: HealthLedger,
): Promise<AtlasEndpoint> => {
  runtime = new AtlasRuntime({
    planned: PLANNED,
    facts: () => {
      return makeFacts(
        repo.logDir,
        undefined,
        ledger
          ? {
              healthOf: (tag) => {
                return ledger.stateOf(tag)
              },
            }
          : {},
      )
    },
    readAsset: options.readAsset,
    // Never the real opener: a test must not open Finder or an Orca tab.
    opener:
      options.opener ??
      (async () => {
        return 'unavailable'
      }),
  })
  runtime.setUis([repo.ui])
  await runtime.start()

  return readAtlasEndpoint(runtime.endpointEnv())!
}

const revisionOf = async (endpoint: AtlasEndpoint): Promise<string> => {
  return (JSON.parse((await atlasRequest(endpoint)).body) as AtlasSnapshot).revision
}

describe('atlas server — access', () => {
  it('binds 127.0.0.1 and hands out a 64-hex token through the env', async () => {
    const endpoint = await start()

    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a foreign Host and a missing or wrong token, without telling the token', async () => {
    const endpoint = await start()

    const responses = await Promise.all([
      atlasRequest(endpoint, { headers: { host: 'evil.localhost' } }),
      atlasRequest(endpoint, { token: null }),
      atlasRequest(endpoint, { token: 'f'.repeat(64) }),
      atlasRequest(endpoint, { token: 'short' }),
    ])

    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(res.headers[ATLAS_TOKEN_HEADER]).toBeUndefined()
      expect(res.body).toBe('')
    }
  })

  it('answers 405 to any other method and 404 to any other path, carrying the token', async () => {
    const endpoint = await start()

    const post = await atlasRequest(endpoint, { method: 'POST' })

    const unknown = await Promise.all(
      ['/', '/__atlas/other.js', '/__atlasx', '/__atlas/state.json/x'].map((path) => {
        return atlasRequest(endpoint, { path })
      }),
    )

    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
    expect(post.headers[ATLAS_TOKEN_HEADER]).toBe(endpoint.token)
    for (const res of unknown) expect(res.status).toBe(404)
  })

  it('sends no-store and the CSP on every response', async () => {
    const endpoint = await start()

    for (const path of ['/__atlas', '/__atlas/state.json', '/nope']) {
      const res = await atlasRequest(endpoint, { path })

      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['content-security-policy']).toBe("default-src 'self'")
    }
  })
})

describe('atlas server — open', () => {
  const post = (endpoint: AtlasEndpoint, body: string) => {
    return atlasRequest(endpoint, { method: 'POST', path: '/__atlas/open', body })
  }

  const recordingOpener = () => {
    return vi.fn<Opener>(async () => {
      return 'opened'
    })
  }

  it('opens the run folder', async () => {
    const opener = recordingOpener()
    const endpoint = await start({ opener })

    expect((await post(endpoint, '{"id":"run-folder"}')).status).toBe(204)
    expect(opener).toHaveBeenCalledWith({ kind: 'folder', path: repo.logDir })
  })

  it('opens a log this run has written, by its service name', async () => {
    const opener = recordingOpener()
    const endpoint = await start({ opener })
    const snapshot = JSON.parse((await atlasRequest(endpoint)).body) as AtlasSnapshot
    const log = snapshot.logs[0]!

    fs.writeFileSync(log.path, 'line\n')

    expect((await post(endpoint, JSON.stringify({ id: log.service }))).status).toBe(204)
    expect(opener).toHaveBeenCalledWith({ kind: 'log', service: log.service, path: log.path })
  })

  it('answers 404 to a name that is not one of its logs, a path included', async () => {
    const opener = recordingOpener()
    const endpoint = await start({ opener })
    const outside = path.join(repo.logDir, '..', 'secret.txt')

    fs.writeFileSync(outside, 'x')

    for (const id of ['nope', outside, '/etc/passwd']) {
      expect((await post(endpoint, JSON.stringify({ id }))).status).toBe(404)
    }
    expect(opener).not.toHaveBeenCalled()
  })

  it('answers 400 to a body that is not {"id": string} or is too large', async () => {
    const opener = recordingOpener()
    const endpoint = await start({ opener })

    for (const body of ['', 'not json', '{"id":1}', 'null', JSON.stringify({ id: 'x'.repeat(2000) })]) {
      expect((await post(endpoint, body)).status).toBe(400)
    }
    expect(opener).not.toHaveBeenCalled()
  })

  it('answers 501 when nothing here can open it, so the page uses its own link', async () => {
    const endpoint = await start()

    expect((await post(endpoint, '{"id":"run-folder"}')).status).toBe(501)
  })

  it('needs the token like every other route', async () => {
    const opener = recordingOpener()
    const endpoint = await start({ opener })

    const res = await atlasRequest(endpoint, {
      method: 'POST',
      path: '/__atlas/open',
      body: '{"id":"run-folder"}',
      token: null,
    })

    expect(res.status).toBe(403)
    expect(opener).not.toHaveBeenCalled()
  })
})

describe('atlas server — state.json', () => {
  it('carries the revision as the ETag and answers 304 while it holds', async () => {
    const endpoint = await start()
    const first = await atlasRequest(endpoint)
    const snapshot = JSON.parse(first.body) as AtlasSnapshot

    expect(first.status).toBe(200)
    expect(first.headers.etag).toBe(`"${snapshot.revision}"`)

    const again = await atlasRequest(endpoint, { headers: { 'if-none-match': first.headers.etag! } })

    expect(again.status).toBe(304)
    expect(again.body).toBe('')
  })

  it('hEAD carries the headers and no body', async () => {
    const endpoint = await start()
    const res = await atlasRequest(endpoint, { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.etag).toBeDefined()
    expect(res.body).toBe('')
  })

  it("changes revision when another runner's fragment appears and again when it goes", async () => {
    const endpoint = await start()
    const before = await revisionOf(endpoint)

    repo.writeFragment('off-api')
    const appeared = await revisionOf(endpoint)

    repo.removeFragment('off-api')
    const gone = await revisionOf(endpoint)

    expect(appeared).not.toBe(before)
    expect(gone).toBe(before)
  })

  it('changes revision when a HealthLedger state flips', async () => {
    const ledger = new HealthLedger(() => {})

    ledger.track('mine/api', 'api')

    const endpoint = await start({}, ledger)
    const down = await revisionOf(endpoint)

    ledger.record({ tag: 'mine/api', kind: 'api', port: 1 }, 'ok')

    expect(ledger.stateOf('mine/api')).toBe('ok')
    expect(await revisionOf(endpoint)).not.toBe(down)
  })
})

describe('atlas server — the page', () => {
  it('serves a plain "not built" page when the reader has nothing', async () => {
    const endpoint = await start({
      readAsset: () => {
        return null
      },
    })

    const page = await atlasRequest(endpoint, { path: '/__atlas' })
    const script = await atlasRequest(endpoint, { path: '/__atlas/app.js' })

    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/^text\/html/)
    expect(page.body).toContain('atlas page not built — run <code>pnpm --filter infra-kit run build</code>')
    expect(script.status).toBe(404)
  })

  it('serves each built asset under its own type', async () => {
    const endpoint = await start({
      readAsset: (name) => {
        return Buffer.from(`asset:${name}`)
      },
    })

    const types: Record<string, [string, RegExp]> = {
      '/__atlas': ['asset:index.html', /^text\/html/],
      '/__atlas/': ['asset:index.html', /^text\/html/],
      '/__atlas/app.js': ['asset:app.js', /^text\/javascript/],
      '/__atlas/app.css': ['asset:app.css', /^text\/css/],
    }

    for (const [path, [body, type]] of Object.entries(types)) {
      const res = await atlasRequest(endpoint, { path })

      expect(res.body).toBe(body)
      expect(res.headers['content-type']).toMatch(type)
    }
  })
})

describe('atlas server — keep-alive', () => {
  const refedSockets = (): number => {
    return process.getActiveResourcesInfo().filter((name) => {
      return name === 'TCPSocketWrap'
    }).length
  }

  it('leaves an idle keep-alive connection unable to hold the process open', async () => {
    const endpoint = await start()
    const url = new URL(endpoint.url)
    const before = refedSockets()

    // A raw socket, because an http.Agent unrefs its own idle keep-alive sockets and would muddy the count.
    const client = net.connect(Number(url.port), url.hostname)

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('error', reject)
        client.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf-8').startsWith('HTTP/1.1 200')) resolve()
        })
        client.write(
          `GET /__atlas/state.json HTTP/1.1\r\nHost: ${url.host}\r\n${ATLAS_TOKEN_HEADER}: ${endpoint.token}\r\n` +
            'Connection: keep-alive\r\n\r\n',
        )
      })

      // The client socket is the only ref'd handle the connection adds; the server's end of it is not.
      expect(refedSockets() - before).toBe(1)
    } finally {
      client.destroy()
    }
  })
})

describe('atlas server — close', () => {
  it('refuses connections once closed, and stops handing out an endpoint', async () => {
    const endpoint = await start()

    expect((await atlasRequest(endpoint)).status).toBe(200)

    await runtime!.close()

    await expect(atlasRequest(endpoint)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(runtime!.endpointEnv()).toEqual({})
  })
})
