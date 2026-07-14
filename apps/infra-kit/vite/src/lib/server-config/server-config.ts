import type { InfraKitViteProxy } from '@slip-stream-kit/config/vite'

/**
 * What `infraKitDev()` resolves: the ready-made vite `server` block. Re-declared structurally rather
 * than imported, because the helper types it inline on its return type and there is no named export
 * to reach for.
 */
export interface ResolvedDevServer {
  port?: number
  host?: string | boolean
  strictPort?: boolean
  hmr?: { protocol: 'wss'; host: string; clientPort: number }
  proxy: InfraKitViteProxy
}

/**
 * The subset of a consumer's `server` block this plugin can collide with. Structurally compatible with
 * vite's `ServerOptions`, so the plugin passes `config.server` straight in without a cast.
 */
export interface UserServerConfig {
  port?: number
  host?: string | boolean
  strictPort?: boolean
  hmr?: unknown
  proxy?: Record<string, unknown>
}

/** The `server` block this plugin contributes — every key optional, because every key is conditional. */
export interface InfraKitServerConfig {
  port?: number
  host?: string | boolean
  strictPort?: boolean
  hmr?: ResolvedDevServer['hmr']
  proxy?: InfraKitViteProxy
}

/** Drop every route the consumer declared themselves — an explicit route in their config outranks ours. */
const withoutUserRoutes = (
  proxy: InfraKitViteProxy,
  userProxy: Record<string, unknown> | undefined,
): InfraKitViteProxy => {
  if (!userProxy) return proxy

  const result: InfraKitViteProxy = {}

  for (const [routePath, entry] of Object.entries(proxy)) {
    if (routePath in userProxy) continue
    result[routePath] = entry
  }

  return result
}

/**
 * The `server` block to return from the `config` hook, given what `infraKitDev()` resolved and what the
 * consumer wrote themselves.
 *
 * This exists because of ONE fact about vite: a `config` hook's result is merged **over** the user config
 * (`mergeConfig(userConfig, pluginResult)`), so anything emitted here WINS against an explicit setting in
 * the consumer's own `vite.config.ts`. A plugin that just returns everything `infraKitDev()` produced
 * would therefore silently overrule a hand-pinned `server.port` — the exact opposite of what a plugin
 * should do, and worse than the `server: await infraKitDev()` spread it replaces (there, at least, the
 * consumer could see the assignment).
 *
 * So: emit only what the consumer left unset. `strictPort` rides with `port` — it is meaningless applied
 * to someone else's port, and forcing it onto a hand-pinned one would turn a soft collision into a hard
 * boot failure.
 */
export const mergeServerConfig = (
  resolved: ResolvedDevServer,
  user: UserServerConfig | undefined,
): InfraKitServerConfig => {
  const server: InfraKitServerConfig = {}

  if (user?.port == null) {
    if (resolved.port != null) server.port = resolved.port
    if (user?.strictPort == null && resolved.strictPort != null) server.strictPort = resolved.strictPort
  }

  if (user?.host == null && resolved.host != null) server.host = resolved.host
  if (user?.hmr == null && resolved.hmr != null) server.hmr = resolved.hmr

  const proxy = withoutUserRoutes(resolved.proxy, user?.proxy)

  if (Object.keys(proxy).length > 0) server.proxy = proxy

  return server
}

/**
 * True when the consumer pinned `server.port` while `infra-kit dev` had already ASSIGNED this UI a port
 * (`strictPort` on the resolved block is the runner's fingerprint — only the Layer-B path sets it).
 *
 * Honouring the pin is still right (it is explicit), but it is not free: the runner registered a portless
 * alias pointing at the port it assigned, and the UI is about to bind a different one. The hero URL then
 * 502s, and nothing in that failure names the pinned port as the cause. Worth one warning line.
 */
export const hasPinnedPortConflict = (resolved: ResolvedDevServer, user: UserServerConfig | undefined): boolean => {
  return user?.port != null && resolved.strictPort === true && user.port !== resolved.port
}
