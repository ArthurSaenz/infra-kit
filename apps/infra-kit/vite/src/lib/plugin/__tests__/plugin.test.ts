import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { ConfigEnv, UserConfig, ViteDevServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanupRepos, createRepo } from '../../__tests__/fixtures'
import type { InfraKitPluginOptions } from '../plugin'
import { infraKit } from '../plugin'

afterEach(() => {
  cleanupRepos()
  delete process.env.CLIENT_URL
})

const SERVE: ConfigEnv = { command: 'serve', mode: 'development' }
const LOCAL_ORIGIN = 'https://main.client-api.localhost'

/**
 * Call the plugin's `config` hook the way vite does. It is declared as a plain function (not the
 * `{ handler }` object form), so the cast narrows an `ObjectHook` union rather than inventing a shape.
 */
const runConfigHook = async (
  options: InfraKitPluginOptions,
  userConfig: UserConfig = {},
  env: ConfigEnv = SERVE,
): Promise<UserConfig> => {
  const hook = infraKit(options).config as (config: UserConfig, env: ConfigEnv) => Promise<UserConfig>

  return hook(userConfig, env)
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

    process.env.CLIENT_URL = 'https://dev.example.test'

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
      expect(config.server?.ws).toEqual({ protocol: 'wss', host: 'main.client-ui.localhost', clientPort: 443 })
    } finally {
      delete process.env.INFRA_KIT_UI_PORTS
    }
  })

  describe('loopback guard', () => {
    interface FakeServer {
      server: ViteDevServer
      middlewares: unknown[]
    }

    const fakeServer = (httpServer: net.Server | null): FakeServer => {
      const middlewares: unknown[] = []
      const logger = { info: vi.fn(), warn: vi.fn() }

      const server = {
        httpServer,
        middlewares: {
          use: (fn: unknown) => {
            return middlewares.push(fn)
          },
        },
        config: { logger },
        printUrls: vi.fn(),
        watcher: { add: vi.fn(), on: vi.fn() },
      } as unknown as ViteDevServer

      return { server, middlewares }
    }

    const boot = async (
      env: ConfigEnv,
      httpServer: net.Server | null = net.createServer(),
    ): Promise<FakeServer & { redirectOf: (host: string) => string | undefined }> => {
      const repo = createRepo()

      repo.writeFragment('client-api', LOCAL_ORIGIN)

      const plugin = infraKit({ cwd: repo.dir, restartOnDevContextChange: false })

      await (plugin.config as (config: UserConfig, env: ConfigEnv) => Promise<UserConfig>)({}, env)

      const fake = fakeServer(httpServer)

      ;(plugin.configureServer as (server: ViteDevServer) => void)(fake.server)

      const redirectOf = (host: string): string | undefined => {
        let location: string | undefined

        const res = {
          setHeader: (_name: string, value: string) => {
            location = value
          },
          end: vi.fn(),
        }

        ;(fake.middlewares[0] as (req: unknown, res: unknown, next: () => void) => void)(
          { url: '/orders', method: 'GET', headers: { host, accept: 'text/html' } },
          res,
          () => {},
        )

        return location
      }

      return { ...fake, redirectOf }
    }

    afterEach(() => {
      delete process.env.INFRA_KIT_UI_PORTS
    })

    it('sends a loopback page load to the alias the runner registered', async () => {
      process.env.INFRA_KIT_UI_PORTS = JSON.stringify({
        'client-ui': { port: 5399, alias: 'main.client-ui.localhost' },
      })

      const { middlewares, redirectOf } = await boot(SERVE)

      expect(middlewares).toHaveLength(1)
      expect(redirectOf('127.0.0.1:5399')).toBe('https://main.client-ui.localhost/orders')
    })

    it('guards a bare vite that nothing placed', async () => {
      const { middlewares } = await boot(SERVE)

      expect(middlewares).toHaveLength(1)
    })

    it('stays out of vitest and of middleware mode', async () => {
      expect((await boot({ command: 'serve', mode: 'test' })).middlewares).toHaveLength(0)
      expect((await boot(SERVE, null)).middlewares).toHaveLength(0)
    })
  })

  describe('dev.env', () => {
    const withDevEnv = (): string => {
      const repo = createRepo()
      const configFile = path.join(repo.dir, 'infra-kit.config.ts')

      fs.writeFileSync(
        configFile,
        fs.readFileSync(configFile, 'utf-8').replace('dev: {', "dev: {\n    env: { unset: ['IK_TEST_DEV_ENV'] },"),
      )

      return repo.dir
    }

    afterEach(() => {
      delete process.env.IK_TEST_DEV_ENV
    })

    it('applies the package dev.env when vite serves', async () => {
      const dir = withDevEnv()

      process.env.CLIENT_URL = 'https://dev.example.test'
      process.env.IK_TEST_DEV_ENV = 'set'
      await runConfigHook({ cwd: dir })

      expect(process.env.IK_TEST_DEV_ENV).toBeUndefined()
    })

    it('leaves the env alone under vitest (mode `test`)', async () => {
      const dir = withDevEnv()

      process.env.CLIENT_URL = 'https://dev.example.test'
      process.env.IK_TEST_DEV_ENV = 'set'
      await runConfigHook({ cwd: dir }, {}, { command: 'serve', mode: 'test' })

      expect(process.env.IK_TEST_DEV_ENV).toBe('set')
    })
  })
})
