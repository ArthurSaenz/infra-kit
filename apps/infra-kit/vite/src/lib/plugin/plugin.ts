import type { InfraKitDevOptions } from '@slip-stream-kit/config/vite'
import { infraKitDev } from '@slip-stream-kit/config/vite'
import process from 'node:process'
import type { Plugin, ViteDevServer } from 'vite'

import type { RestartableServer } from '../dev-context/dev-context'
import { proxySignature, watchDevContext } from '../dev-context/dev-context'
import { hasPinnedPortConflict, mergeServerConfig } from '../server-config/server-config'

/**
 * Everything `infraKitDev()` accepts, minus `command` — the plugin knows vite's command without being
 * told (see {@link infraKit}), and accepting it would only let a consumer contradict it.
 */
export interface InfraKitPluginOptions extends Omit<InfraKitDevOptions, 'command'> {
  /**
   * Re-resolve the proxy and restart the dev server when the `.infra-kit/dev-context` fragments change,
   * so a backend started AFTER the frontend flips its route from `cloud` to `local` on its own. Default
   * `true`. Set `false` to freeze the proxy at whatever it resolved to when vite booted.
   */
  restartOnDevContextChange?: boolean
}

/** Adapt a real vite dev server to the narrow surface {@link watchDevContext} drives. */
const asRestartable = (server: ViteDevServer): RestartableServer => {
  return {
    watcher: {
      add: (target) => {
        server.watcher.add(target)
      },
      on: (event, listener) => {
        server.watcher.on(event, (file: string) => {
          listener(file)
        })
      },
    },
    restart: async () => {
      await server.restart()
    },
    warn: (message) => {
      server.config.logger.warn(message)
    },
  }
}

/**
 * The infra-kit vite plugin: a per-worktree dev port (or the one `infra-kit dev` assigned this UI),
 * HMR pointed at the portless HTTPS alias, and the `dev.proxy` map from the package's
 * `infra-kit.config.ts` — resolved live, and re-resolved whenever the local dev set changes.
 *
 * `apply: 'serve'` is load-bearing, not tidiness. Vite filters plugins by `apply` BEFORE it runs their
 * `config` hooks, so on `build` this plugin does not exist at all. The helper it wraps had to be told
 * (`infraKitDev({ command })`) and would otherwise fail-fast on a cloud route with no sourced env — a
 * failure whose only cause was a consumer forgetting to thread an argument. That class of bug is gone.
 *
 * @example
 * // vite.config.ts
 * import { infraKit } from '@slip-stream-kit/vite'
 * import { defineConfig } from 'vite'
 *
 * export default defineConfig({ plugins: [infraKit()] })
 */
export const infraKit = (options: InfraKitPluginOptions = {}): Plugin => {
  const cwd = options.cwd ?? process.cwd()

  let signature = proxySignature({})
  let pinnedPortConflict = false
  let dispose: () => void = () => {}

  return {
    name: 'infra-kit',
    apply: 'serve',

    config: async (userConfig) => {
      const resolved = await infraKitDev({ ...options, cwd, command: 'serve' })

      signature = proxySignature(resolved.proxy)
      pinnedPortConflict = hasPinnedPortConflict(resolved, userConfig.server)

      return { server: mergeServerConfig(resolved, userConfig.server) }
    },

    configureServer: (server) => {
      if (pinnedPortConflict) {
        server.config.logger.warn(
          '[infra-kit] server.port is pinned in this vite config, but `infra-kit dev` assigned this UI a ' +
            'different port and registered its portless alias against THAT one. The pin wins — and the ' +
            'hero URL will 502. Remove server.port to let the runner place it.',
        )
      }

      if (options.restartOnDevContextChange === false) return

      dispose = watchDevContext({ server: asRestartable(server), cwd, options, current: signature }).dispose
    },

    // The dev server calls this on close (including on the restart the watcher itself triggers), so the
    // pending debounce of a server that is going away never fires against the one replacing it.
    buildEnd: () => {
      dispose()
      dispose = () => {}
    },
  }
}
