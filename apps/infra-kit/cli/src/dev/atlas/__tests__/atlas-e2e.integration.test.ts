import { DEV_CONTEXT_WIRE_VERSION } from '@slip-stream-kit/config/internal'
import { infraKit } from '@slip-stream-kit/vite'
import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import process from 'node:process'
import type { ViteDevServer } from 'vite'
import { createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtlasSite, AtlasSnapshot } from 'src/dev/atlas/atlas-contract'
import { DevServerRunner } from 'src/dev/dev-server'
import type { DevUi } from 'src/dev/dev-ui'
import type { ProbeOutcome } from 'src/dev/health-probe'
import type { UiDevOptions } from 'src/dev/ui-dev'

import {
  createTempTracker,
  makeMonorepo,
  restoreCwd,
  restoreEnv,
  snapshotCwd,
  snapshotEnv,
  workingProxy,
} from '../../__tests__/fixtures'

const TIMEOUT_MS = 60_000
const UIS = ['shop-ui', 'admin-ui'] as const

/** `/api` is served by this run's backend; `/other` by nobody until a second runner's fragment appears. */
const ROUTES = {
  '/api': { packageName: 'shop-api', from: ['local', 'cloud'], default: 'cloud' },
  '/other': { packageName: 'other-api', from: ['local', 'cloud'], default: 'cloud' },
} satisfies Record<string, { packageName: string; from: ('local' | 'cloud')[]; default: 'cloud' }>

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

const get = (port: number, urlPath: string): Promise<Reply> => {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      let body = ''

      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
      })
    })

    req.on('error', reject)
    req.end()
  })
}

const readState = async (port: number): Promise<AtlasSnapshot> => {
  const reply = await get(port, '/__atlas/state.json')

  expect(reply.status).toBe(200)

  return JSON.parse(reply.body) as AtlasSnapshot
}

const siteOf = (snapshot: AtlasSnapshot, id: string): AtlasSite => {
  const site = snapshot.sites.find((s) => {
    return s.id === id
  })

  expect(site, `site ${id} in the snapshot`).toBeDefined()

  return site!
}

const reasonOf = (site: AtlasSite, routePath: string): string | undefined => {
  return site.routes.find((r) => {
    return r.path === routePath
  })?.reason
}

const silentRenderer = (): DevUi => {
  const noop = (): void => {}

  return { narrate: noop, log: noop, logFn: noop, bootStep: noop, ready: noop, dispose: noop }
}

const noopTurboChild = (): { kill: () => Promise<void> } => {
  return {
    kill: () => {
      return Promise.resolve()
    },
  }
}

const temp = createTempTracker()
let envSnapshot: NodeJS.ProcessEnv
let cwdSnapshot: string
let runner: DevServerRunner | null = null
let root = ''
const vites = new Map<string, ViteDevServer>()

const portOf = (pkg: (typeof UIS)[number]): number => {
  return (vites.get(pkg)!.httpServer!.address() as AddressInfo).port
}

const otherFragment = (): string => {
  return path.join(root, '.infra-kit', 'dev-context', 'other.json')
}

/** Another runner's backend: `pid: process.pid` keeps it past the dead-writer filter `readFragmentDir` applies. */
const writeOtherRunnerFragment = (): void => {
  fs.writeFileSync(
    otherFragment(),
    JSON.stringify({
      v: DEV_CONTEXT_WIRE_VERSION,
      package: 'other-api',
      port: 4999,
      pid: process.pid,
      origin: 'https://main.other-api.elsewhere.localhost',
    }),
  )
}

const bootVite = async (uiDir: string): Promise<ViteDevServer> => {
  // `configFile: false`: the fixture's own vite.config.ts imports the plugin by name, which the temp repo cannot
  // resolve. The watcher restart is off because the route flip under test is the runner's read, not vite's.
  const server = await createServer({
    configFile: false,
    root: uiDir,
    logLevel: 'silent',
    appType: 'spa',
    plugins: [infraKit({ cwd: uiDir, restartOnDevContextChange: false })],
  })

  await server.listen()

  return server
}

beforeEach(async () => {
  envSnapshot = snapshotEnv()
  cwdSnapshot = snapshotCwd()
  root = temp.register(
    makeMonorepo([
      {
        name: 'shop',
        packageName: 'shop-api',
        withHandler: true,
        ui: { packageName: 'shop-ui', proxy: { routes: ROUTES } },
      },
      { name: 'admin', api: false, ui: { packageName: 'admin-ui', proxy: { routes: ROUTES } } },
    ]),
  )
  // Both UIs' `deployedUrlEnv`, so `/other` falls back to a real cloud target rather than `cloud-unset`.
  process.env.SHOP_URL = 'https://shop.example.com'
  process.env.ADMIN_URL = 'https://admin.example.com'
  process.chdir(root)

  let uiOpts: UiDevOptions | undefined

  runner = new DevServerRunner(
    { livenessIntervalMs: 60_000 },
    async () => {},
    noopTurboChild,
    (opts: UiDevOptions) => {
      uiOpts = opts

      return noopTurboChild()
    },
    undefined,
    silentRenderer(),
    (): Promise<ProbeOutcome> => {
      return Promise.resolve('ok')
    },
    workingProxy(),
  )
  await runner.start()

  // Both vites run in this process and `infraKit()` applies `dev.env` to `process.env`: give them the env the
  // runner handed its UI child, as a real `turbo run dev` would.
  Object.assign(process.env, uiOpts?.env)

  for (const pkg of UIS) {
    vites.set(pkg, await bootVite(path.join(root, 'apps', pkg.replace('-ui', ''), 'ui')))
  }
}, TIMEOUT_MS)

afterEach(async () => {
  try {
    for (const server of vites.values()) await server.close()
    await runner?.shutdown()
  } finally {
    vites.clear()
    runner = null
    restoreCwd(cwdSnapshot)
    restoreEnv(envSnapshot)
    temp.cleanup()
  }
}, TIMEOUT_MS)

describe('the atlas end to end: runner, real vite and the forwarder', () => {
  it(
    'serves the page and a snapshot of both sites through each vite, the viewer naming that vite’s own site',
    async () => {
      for (const pkg of UIS) {
        const page = await get(portOf(pkg), '/__atlas')

        // `dist/atlas` is not built under vitest, so the runner answers with its "not built" page; that it got
        // here at all, with the token stripped, is the forwarder relaying the runner.
        expect(page.status).toBe(200)
        expect(page.headers['content-type']).toMatch(/^text\/html/)
        expect(page.headers['x-infra-kit-atlas-token']).toBeUndefined()
        expect(page.body).toContain('The atlas page is not built')

        const snapshot = await readState(portOf(pkg))

        expect(
          snapshot.sites
            .map((s) => {
              return s.id
            })
            .toSorted(),
        ).toEqual(['admin-ui', 'shop-ui'])
        expect(snapshot.viewer.siteId).toBe(pkg)

        const viewerRoutes = siteOf(snapshot, pkg).routes

        expect(
          viewerRoutes
            .map((r) => {
              return r.path
            })
            .toSorted(),
        ).toEqual(['/api', '/other'])
        for (const route of viewerRoutes) expect(route.served, `${pkg} ${route.path}`).toBe('match')
        expect(reasonOf(siteOf(snapshot, pkg), '/api')).toBe('local')
      }
    },
    TIMEOUT_MS,
  )

  it(
    'flips /other to local while a second runner’s backend fragment exists, and back once it is gone',
    async () => {
      const port = portOf('shop-ui')

      expect(reasonOf(siteOf(await readState(port), 'shop-ui'), '/other')).toBe('not-running')

      writeOtherRunnerFragment()
      await vi.waitFor(
        async () => {
          const snapshot = await readState(port)

          expect(reasonOf(siteOf(snapshot, 'shop-ui'), '/other')).toBe('local')
          expect(reasonOf(siteOf(snapshot, 'admin-ui'), '/other')).toBe('local')
        },
        { timeout: 5000, interval: 100 },
      )

      fs.rmSync(otherFragment())
      await vi.waitFor(
        async () => {
          expect(reasonOf(siteOf(await readState(port), 'shop-ui'), '/other')).toBe('not-running')
        },
        { timeout: 5000, interval: 100 },
      )
    },
    TIMEOUT_MS,
  )

  it(
    'serves the "runner is not running" page once the runner has shut down',
    async () => {
      await runner!.shutdown()

      const page = await get(portOf('admin-ui'), '/__atlas')

      expect(page.status).toBe(503)
      expect(page.headers['content-type']).toMatch(/^text\/html/)
      expect(page.body).toContain('runner is not running')
      // The endpoint is still in the env, so this is the unreachable-runner page, not the "no endpoint" one.
      expect(page.body).not.toContain('older runners')
    },
    TIMEOUT_MS,
  )
})
