import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { mirrorOnIpv6Loopback } from '../ipv6-loopback'

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

const track = <T extends net.Server>(server: T): T => {
  servers.push(server)

  return server
}

const startHttp = async (host: string, onError: (err: NodeJS.ErrnoException) => void = () => {}) => {
  const server = track(
    http.createServer((_req, res) => {
      res.end('ok')
    }),
  )

  mirrorOnIpv6Loopback(server, onError)
  server.listen(0, host)
  await once(server, 'listening')

  return { server, port: (server.address() as AddressInfo).port }
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

/** Resolves on the next tick the `::1` mirror could have bound by, so assertions don't race its `listen`. */
const settle = (): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, 20)
  })
}

describe('mirrorOnIpv6Loopback', () => {
  it('serves the same handler on [::1] when the server is bound to 127.0.0.1', async () => {
    const { port } = await startHttp('127.0.0.1')

    await settle()

    expect(await get('127.0.0.1', port)).toBe('ok')
    expect(await get('::1', port)).toBe('ok')
  })

  it('releases [::1] when the server closes', async () => {
    const { server, port } = await startHttp('127.0.0.1')

    await settle()
    servers.splice(servers.indexOf(server), 1)
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    await settle()

    expect(await isListening('::1', port)).toBe(false)
  })

  it('leaves a non-loopback bind alone', async () => {
    const { port } = await startHttp('0.0.0.0')

    await settle()

    // `0.0.0.0` is IPv4-only, so anything answering on ::1 here would be the mirror.
    expect(await isListening('::1', port)).toBe(false)
  })

  it('reports a [::1] port that is already taken, and keeps serving IPv4', async () => {
    const squatter = track(net.createServer())

    squatter.listen(0, '::1')
    await once(squatter, 'listening')

    const { port: taken } = squatter.address() as AddressInfo
    const errors: string[] = []
    const server = track(
      http.createServer((_req, res) => {
        res.end('ok')
      }),
    )

    mirrorOnIpv6Loopback(server, (err) => {
      errors.push(err.code ?? err.message)
    })
    server.listen(taken, '127.0.0.1')
    await once(server, 'listening')
    await settle()

    expect(errors).toEqual(['EADDRINUSE'])
    expect(await get('127.0.0.1', taken)).toBe('ok')
  })
})
