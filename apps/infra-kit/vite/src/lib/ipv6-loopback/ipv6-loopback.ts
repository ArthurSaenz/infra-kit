import net from 'node:net'
import type { Server } from 'node:net'

const IPV4_LOOPBACK = '127.0.0.1'
const IPV6_LOOPBACK = '::1'

/**
 * Once `server` is listening on `127.0.0.1`, also accept on `[::1]` at the same port and hand every socket
 * to `server`. Any other bind address is left alone. `onError` gets a failed `::1` bind (no IPv6, port
 * taken); the IPv4 listener keeps serving either way.
 */
// portless dials a route as `localhost` over 127.0.0.1 then ::1 (happy eyeballs) and opens a fresh TCP
// connection per proxied request. Under an e2e burst the IPv4 ephemeral ports pile up in TIME_WAIT, the
// 127.0.0.1 dial fails with EADDRNOTAVAIL, the ::1 fallback is refused, and portless answers 502. A ::1
// listener gives the fallback a second, independent port space. Still loopback-only.
export const mirrorOnIpv6Loopback = (server: Server, onError: (err: NodeJS.ErrnoException) => void): void => {
  const start = (): void => {
    const address = server.address()

    if (address === null || typeof address === 'string' || address.address !== IPV4_LOOPBACK) return

    const mirror = net.createServer((socket) => {
      server.emit('connection', socket)
    })

    mirror.once('error', onError)
    mirror.listen(address.port, IPV6_LOOPBACK)
    server.once('close', () => {
      mirror.close()
    })
  }

  if (server.listening) start()
  else server.once('listening', start)
}
