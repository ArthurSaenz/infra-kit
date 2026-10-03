import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { MirrorHandlers } from '../ipv6-loopback'
import { mirrorOnIpv6Loopback } from '../ipv6-loopback'

// Probed at module load, not in `beforeAll`: `it.skipIf` reads its condition while tests are collected.
const hasIpv6 = await new Promise<boolean>((resolve) => {
  const probe = net.createServer()

  probe.once('error', () => {
    resolve(false)
  })
  probe.listen(0, '::1', () => {
    probe.close(() => {
      resolve(true)
    })
  })
})

const servers: net.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }),
  )
})

const recorder = () => {
  const bindErrors: string[] = []
  const errors: string[] = []
  const handlers: MirrorHandlers = {
    onBindError: (err) => {
      bindErrors.push(err.code ?? err.message)
    },
    onError: (err) => {
      errors.push(err.code ?? err.message)
    },
  }

  return { bindErrors, errors, handlers }
}

const startHttp = async (host: string, handlers: MirrorHandlers, port = 0) => {
  const server = http.createServer((_req, res) => {
    res.end('ok')
  })

  servers.push(server)

  const mirrored = mirrorOnIpv6Loopback(server, handlers)

  server.listen(port, host)
  await once(server, 'listening')

  return { server, port: (server.address() as AddressInfo).port, mirror: await mirrored }
}

const get = (host: string, port: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: '/', agent: false }, (res) => {
        let body = ''

        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          resolve(body)
        })
      })
      .on('error', reject)
  })
}

const isListening = (host: string, port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })

    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

describe('mirrorOnIpv6Loopback', () => {
  it.skipIf(!hasIpv6)('serves the same handler on [::1] when the server is bound to 127.0.0.1', async () => {
    const { bindErrors, errors, handlers } = recorder()
    const { port } = await startHttp('127.0.0.1', handlers)

    expect(await get('127.0.0.1', port)).toBe('ok')
    expect(await get('::1', port)).toBe('ok')
    expect(bindErrors).toEqual([])
    expect(errors).toEqual([])
  })

  it.skipIf(!hasIpv6)('releases [::1] as soon as close() is called', async () => {
    const { server, port, mirror } = await startHttp('127.0.0.1', recorder().handlers)

    servers.splice(servers.indexOf(server), 1)
    server.close()

    expect(mirror?.listening).toBe(false)
    expect(await isListening('::1', port)).toBe(false)
  })

  it('leaves a non-loopback bind alone', async () => {
    const { port, mirror } = await startHttp('0.0.0.0', recorder().handlers)

    expect(mirror).toBeUndefined()
    // `0.0.0.0` is IPv4-only, so anything answering on ::1 here would be the mirror.
    expect(await isListening('::1', port)).toBe(false)
  })

  it.skipIf(!hasIpv6)('reports a taken [::1] port as a bind error, and keeps serving IPv4', async () => {
    const squatter = net.createServer()

    servers.push(squatter)
    squatter.listen(0, '::1')
    await once(squatter, 'listening')

    const { port: taken } = squatter.address() as AddressInfo
    const { bindErrors, errors, handlers } = recorder()
    const { mirror } = await startHttp('127.0.0.1', handlers, taken)

    expect(mirror).toBeUndefined()
    expect(bindErrors).toEqual(['EADDRINUSE'])
    expect(errors).toEqual([])
    expect(await get('127.0.0.1', taken)).toBe('ok')
  })

  it.skipIf(!hasIpv6)('reports an error after listening without throwing', async () => {
    const { bindErrors, errors, handlers } = recorder()
    const { port, mirror } = await startHttp('127.0.0.1', handlers)

    mirror?.emit('error', Object.assign(new Error('boom'), { code: 'EMFILE' }))

    expect(errors).toEqual(['EMFILE'])
    expect(bindErrors).toEqual([])
    expect(await get('::1', port)).toBe('ok')
  })
})
