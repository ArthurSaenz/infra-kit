/**
 * Shared test fixtures for the dev-server suites.
 *
 * Everything here is hermetic: temp dirs are created under the OS tmp dir and
 * returned to the caller (register them with a {@link createTempTracker} so an
 * `afterEach` can remove them). No module-level side effects — importing this
 * file never touches the filesystem, cwd, or env.
 */
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { vi } from 'vitest'

import type { PortlessDriver } from 'src/dev/proxy/portless-driver'
import { ServerlessLocalRun } from 'src/dev/serverless-local-run'

/** Default URL prefix the fixtures serve routes under (matches the runner default). */
export const PREFIX = '/api/v1'

/** serverless.yml exposing ping (GET), echo (POST) and item (GET {id}) routes. */
const SERVERLESS_YML = [
  'service: testapp',
  'functions:',
  '  ping:',
  '    handler: dist/handler.ping',
  '    events:',
  '      - http:',
  '          method: get',
  '          path: ping',
  '  echo:',
  '    handler: dist/handler.echo',
  '    events:',
  '      - http:',
  '          method: post',
  '          path: echo',
  '  item:',
  '    handler: dist/handler.item',
  '    events:',
  '      - http:',
  '          method: get',
  '          path: item/{id}',
  '',
].join('\n')

/** serverless.yml with a single ping (GET) route — used for monorepo app fixtures. */
const MONOREPO_SERVERLESS_YML = [
  'service: svc',
  'functions:',
  '  ping:',
  '    handler: dist/handler.ping',
  '    events:',
  '      - http:',
  '          method: get',
  '          path: ping',
  '',
].join('\n')

/**
 * Compiled ESM handler written straight to `dist/*.js` (no build step). Each handler
 * echoes the Lambda event back as its JSON body so the HTTP->Lambda transform can be
 * asserted from the response. `version` lets a reload test tell v1 from v2 apart.
 */
export function handlerSource(version = 1): string {
  return [
    `const version = ${version}`,
    'const reply = (event, extra) => ({',
    '  statusCode: 200,',
    "  headers: { 'content-type': 'application/json', 'x-handler-version': String(version) },",
    '  body: JSON.stringify({ version, event, ...extra }),',
    '})',
    'export const ping = async (event) => reply(event, { route: "ping" })',
    'export const echo = async (event) => reply(event, { route: "echo" })',
    'export const item = async (event) => reply(event, { route: "item" })',
    '',
  ].join('\n')
}

/** Create an `apps/testapp/api`-shaped fixture with serverless.yml + a compiled dist handler. */
export function makeApiFixture(handlerVersion = 1): string {
  const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-sls-run-'))

  fs.writeFileSync(path.join(apiDir, 'serverless.yml'), SERVERLESS_YML)
  // type:module so Node loads the plain dist/*.js as ESM (named exports available).
  fs.writeFileSync(path.join(apiDir, 'package.json'), JSON.stringify({ name: 'testapp-api', type: 'module' }))
  fs.mkdirSync(path.join(apiDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(handlerVersion))

  return apiDir
}

/** One app inside a monorepo fixture. */
export interface AppSpec {
  /** App folder name (e.g. client, backoffice). */
  name: string
  /** package.json `name`. Omit to leave package.json out (discovery falls back to the folder name). */
  packageName?: string
  /** Set false to create the app folder WITHOUT serverless.yml (should be ignored by discovery). */
  api?: boolean
  /** Also write package.json (type:module) + a real dist/handler.js so the app can actually boot. */
  withHandler?: boolean
  /**
   * Also scaffold `apps/<name>/ui/package.json`. `dev` (default true) controls whether it declares a
   * `scripts.dev` — a UI without one must be ignored by {@link discoverUiApps}. `viteConfig` (default
   * true) writes a `vite.config.ts` wiring `infra-kit/vite`, which is what marks the UI's port as
   * runner-managed; set it false to model a framework that picks its own port.
   */
  ui?: { packageName?: string; dev?: boolean; viteConfig?: boolean }
}

/** Build a hermetic monorepo: pnpm-workspace.yaml + `apps/<app>/api/serverless.yml` per spec. */
export function makeMonorepo(apps: AppSpec[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-monorepo-'))

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  fs.mkdirSync(path.join(root, 'apps'), { recursive: true })

  for (const app of apps) {
    const apiDir = path.join(root, 'apps', app.name, 'api')

    fs.mkdirSync(apiDir, { recursive: true })
    if (app.api !== false) {
      fs.writeFileSync(path.join(apiDir, 'serverless.yml'), MONOREPO_SERVERLESS_YML)
    }
    if (app.packageName != null || app.withHandler) {
      fs.writeFileSync(
        path.join(apiDir, 'package.json'),
        JSON.stringify({ name: app.packageName ?? `${app.name}-api`, type: 'module' }),
      )
    }
    if (app.withHandler) {
      fs.mkdirSync(path.join(apiDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(apiDir, 'dist', 'handler.js'), handlerSource(1))
    }
    if (app.ui) {
      const uiDir = path.join(root, 'apps', app.name, 'ui')

      fs.mkdirSync(uiDir, { recursive: true })
      const pkg: { name: string; scripts?: Record<string, string> } = {
        name: app.ui.packageName ?? `${app.name}-ui`,
      }

      if (app.ui.dev !== false) pkg.scripts = { dev: 'vite' }
      fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify(pkg))
      if (app.ui.viteConfig !== false) {
        fs.writeFileSync(
          path.join(uiDir, 'vite.config.ts'),
          [
            "import { infraKitDev } from 'infra-kit/vite'",
            "import { defineConfig } from 'vite'",
            '',
            'export default defineConfig(async ({ command }) => ({ server: await infraKitDev({ command }) }))',
            '',
          ].join('\n'),
        )
      }
    }
  }

  return root
}

/** Ask the OS for a currently-free TCP port on localhost, then release it. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()

    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr != null ? addr.port : 0

      srv.close(() => {
        return resolve(port)
      })
    })
  })
}

/** True if a fresh listener can bind `port` — i.e. the previous server released it. */
export async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()

    srv.once('error', () => {
      return resolve(false)
    })
    srv.listen(port, '127.0.0.1', () => {
      return srv.close(() => {
        return resolve(true)
      })
    })
  })
}

/**
 * Boot a server against `apiDir` on `port`. No `chdir`: `ServerlessLocalRun` reads
 * `serverless.yml` and imports the handler from `controllersPath` (absolute), so booting
 * is cwd-independent. The caller owns the returned server's lifecycle (call `close()` in teardown).
 */
export async function boot(
  apiDir: string,
  port: number,
  appName = 'testapp',
  prefixUrl = PREFIX,
): Promise<ServerlessLocalRun> {
  const server = new ServerlessLocalRun({ controllersPath: apiDir, prefixUrl, port, appName })

  await server.start()

  return server
}

/** A registry of temp dirs so an `afterEach` can remove everything created in a test. */
export interface TempTracker {
  /** Register a dir for cleanup and return it (so calls can be inlined). */
  register: (dir: string) => string
  /** Remove every registered dir and clear the registry. */
  cleanup: () => void
}

export function createTempTracker(): TempTracker {
  const dirs: string[] = []

  return {
    register: (dir: string): string => {
      dirs.push(dir)

      return dir
    },
    cleanup: (): void => {
      for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/** Snapshot `process.env` so tests can restore it after mutating per-app port vars. */
export function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

/** Restore a `process.env` snapshot taken by {@link snapshotEnv}. */
export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  process.env = { ...snapshot }
}

/** Snapshot the current working directory (fixtures chdir for serverless.yml resolution). */
export function snapshotCwd(): string {
  return process.cwd()
}

/** Restore a cwd snapshot taken by {@link snapshotCwd}. */
export function restoreCwd(dir: string): void {
  process.chdir(dir)
}

/**
 * Spy `process.stdout.write`, pushing every written chunk into `sink`. The caller owns
 * the returned spy's lifecycle (`spy.mockRestore()` in a `finally`). Used by the dev-server
 * table / route-dump / request-log tests to assert on captured startup + request output.
 */
export function spyStdoutWrite(sink: string[]): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
    sink.push(String(chunk))

    return true
  }) as never)
}

/** Records what a {@link makeFakeProxy} driver was asked to do, for assertions. */
export interface FakeProxy {
  driver: PortlessDriver
  registered: Array<[string, number]>
  removed: string[]
  /** Ports `ensureDaemon` was asked to bring up — proves the resolved proxy port reaches the daemon. */
  ensuredPorts: number[]
}

/** A `daemonOk` that refuses every port — portless is installed, but no daemon ever comes up. */
export const daemonNeverStarts = (): boolean => {
  return false
}

/**
 * A fake portless driver that records register/remove/ensure calls; `available` gates the whole feature.
 * `daemonOk` decides per-port whether the daemon comes up — the real driver refuses a privileged port it
 * cannot bind, which is exactly what drives the unprivileged fallback. Defaults to `available` for every
 * port (the historical all-or-nothing fake).
 *
 * `events` is an optional ORDERED sink shared with other fakes (e.g. a fake `turboWatch.kill`). `removed`
 * alone proves only THAT an alias was deregistered, never WHEN — so an ordering regression in `shutdown()`
 * would pass unnoticed. Push into a shared `events` array from every fake to assert relative order.
 */
/**
 * The `dist/cli.js` the fake driver claims to run. The **space is deliberate**: a checkout under
 * `~/My Projects` is not exotic, and it is the only way a caller that renders a remediation gets its shell
 * quoting exercised end-to-end. A shell-safe path here would let an unquoted rendering pass.
 */
export const FAKE_PORTLESS_BIN = '/Users/dev/My Projects/repo/node_modules/portless/dist/cli.js'

export const makeFakeProxy = (
  available: boolean,
  daemonOk: (port: number) => boolean = () => {
    return available
  },
  events?: string[],
): FakeProxy => {
  const registered: Array<[string, number]> = []
  const removed: string[] = []
  const ensuredPorts: number[] = []
  const driver: PortlessDriver = {
    binPath: () => {
      return available ? FAKE_PORTLESS_BIN : null
    },
    isAvailable: () => {
      return Promise.resolve(available)
    },
    isProxyServing: (port) => {
      ensuredPorts.push(port)

      return Promise.resolve(available && daemonOk(port))
    },
    registerAlias: (name, port) => {
      registered.push([name, port])

      return Promise.resolve(true)
    },
    removeAlias: (name) => {
      removed.push(name)
      events?.push('removeAlias')

      return Promise.resolve()
    },
  }

  return { driver, registered, removed, ensuredPorts }
}

/**
 * A working portless driver (its daemon comes up on every port). EVERY test that reaches
 * `DevServerRunner.start()` must inject this (8th ctor arg): without it the runner builds the REAL
 * driver, and `start()` then depends on a portless daemon happening to run on the host — a green that
 * survives only on the author's machine, and which spawns an unreaped daemon plus mutates the
 * machine-global `~/.portless/routes.json` everywhere else.
 */
export const workingProxy = (): PortlessDriver => {
  return makeFakeProxy(true).driver
}
