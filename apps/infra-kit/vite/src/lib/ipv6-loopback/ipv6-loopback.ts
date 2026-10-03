import net from 'node:net'
import type { Server } from 'node:net'

const IPV4_LOOPBACK = '127.0.0.1'
const IPV6_LOOPBACK = '::1'

export interface MirrorHandlers {
  /** The `::1` bind failed (no IPv6, port taken). The IPv4 listener keeps serving either way. */
  onBindError: (err: NodeJS.ErrnoException) => void
  /** An error on the `::1` listener after it bound. Reported, never thrown. */
  onError: (err: NodeJS.ErrnoException) => void
}

// portless dials a route as `localhost` over 127.0.0.1 then ::1 and opens a fresh TCP connection per
// request, so parallel e2e load exhausts the IPv4 ephemeral ports (TIME_WAIT) and the refused ::1
// fallback becomes a 502. A ::1 listener gives that fallback its own port space; still loopback-only.
/**
 * Once `server` listens on `127.0.0.1`, also accept on `[::1]` at the same port and hand every socket to
 * it; any other bind is left alone. Resolves to the `::1` listener once bound, `undefined` when skipped
 * or the bind failed. Closing `server` closes the listener.
 */
export const mirrorOnIpv6Loopback = (server: Server, handlers: MirrorHandlers): Promise<Server | undefined> => {
  return new Promise((resolve) => {
    const start = (): void => {
      const address = server.address()

      if (address === null || typeof address === 'string' || address.address !== IPV4_LOOPBACK) {
        resolve(undefined)

        return
      }

      const mirror = net.createServer((socket) => {
        server.emit('connection', socket)
      })

      mirror.on('error', (err: NodeJS.ErrnoException) => {
        if (mirror.listening) {
          handlers.onError(err)
        } else {
          handlers.onBindError(err)
          resolve(undefined)
        }
      })
      mirror.listen(address.port, IPV6_LOOPBACK, () => {
        resolve(mirror)
      })

      const close = server.close.bind(server)

      server.close = (callback) => {
        if (mirror.listening) mirror.close()

        return close(callback)
      }
    }

    if (server.listening) start()
    else server.once('listening', start)
  })
}
