import type { ConfigEnv, UserConfig } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupRepos, createRepo } from '../../__tests__/fixtures'
import type { InfraKitPluginOptions } from '../plugin'
import { infraKit } from '../plugin'

afterEach(() => {
  cleanupRepos()
  delete process.env.INFRA_KIT_ENV
})

const SERVE: ConfigEnv = { command: 'serve', mode: 'development' }
const LOCAL_ORIGIN = 'https://main.client-api.localhost'

/**
 * Call the plugin's `config` hook the way vite does. It is declared as a plain function (not the
 * `{ handler }` object form), so the cast narrows an `ObjectHook` union rather than inventing a shape.
 */
const runConfigHook = async (options: InfraKitPluginOptions, userConfig: UserConfig = {}): Promise<UserConfig> => {
  const hook = infraKit(options).config as (config: UserConfig, env: ConfigEnv) => Promise<UserConfig>

  return hook(userConfig, SERVE)
}

describe('infraKit', () => {
  it('is a serve-only plugin, so a build never reaches the proxy resolution at all', () => {
    // `apply` is what removes the `command` argument the helper needed: vite filters plugins by `apply`
    // BEFORE running config hooks, so on `build` this plugin does not exist. Forgetting to thread
    // `command` is no longer possible, because there is nothing to thread.
    expect(infraKit().apply).toBe('serve')
    expect(infraKit().name).toBe('infra-kit')
  })

  it('resolves a running backend to its registered origin', async () => {
    const repo = createRepo()

    repo.writeFragment('client-api', LOCAL_ORIGIN)

    const config = await runConfigHook({ cwd: repo.dir })

    expect(config.server?.proxy).toEqual({
      '/api': { target: LOCAL_ORIGIN, changeOrigin: true, secure: false },
      '/ws': { target: LOCAL_ORIGIN, changeOrigin: true, secure: false },
    })
  })

  it('falls back to the cloud target when no backend is running locally', async () => {
    const repo = createRepo()

    process.env.INFRA_KIT_ENV = 'dev'

    const config = await runConfigHook({ cwd: repo.dir })

    expect(config.server?.proxy?.['/api']).toMatchObject({ target: 'https://dev.example.test' })
  })

  it('binds an OS-assigned port on the IPv4 loopback so a portless alias can reach it', async () => {
    const repo = createRepo()

    repo.writeFragment('client-api', LOCAL_ORIGIN)

    const config = await runConfigHook({ cwd: repo.dir })

    expect(typeof config.server?.port).toBe('number')
    expect(config.server?.host).toBe('127.0.0.1')
  })

  it('leaves a consumer’s own server settings standing', async () => {
    const repo = createRepo()

    repo.writeFragment('client-api', LOCAL_ORIGIN)

    // Vite merges the hook's result OVER the user config, so anything returned here would WIN. The
    // consumer pinned a port and a route; the plugin must return neither.
    const config = await runConfigHook(
      { cwd: repo.dir },
      { server: { port: 4000, proxy: { '/api': 'http://somewhere-else.test' } } },
    )

    expect(config.server?.port).toBeUndefined()
    expect(config.server?.strictPort).toBeUndefined()
    expect(config.server?.proxy).toEqual({ '/ws': { target: LOCAL_ORIGIN, changeOrigin: true, secure: false } })
  })

  it('binds the runner-assigned port with strictPort, and points HMR at the alias', async () => {
    const repo = createRepo()

    repo.writeFragment('client-api', LOCAL_ORIGIN)
    process.env.INFRA_KIT_UI_PORTS = JSON.stringify({
      'client-ui': { port: 5399, alias: 'main.client-ui.localhost' },
    })

    try {
      const config = await runConfigHook({ cwd: repo.dir })

      expect(config.server?.port).toBe(5399)
      expect(config.server?.strictPort).toBe(true)
      expect(config.server?.hmr).toEqual({ protocol: 'wss', host: 'main.client-ui.localhost', clientPort: 443 })
    } finally {
      delete process.env.INFRA_KIT_UI_PORTS
    }
  })
})
