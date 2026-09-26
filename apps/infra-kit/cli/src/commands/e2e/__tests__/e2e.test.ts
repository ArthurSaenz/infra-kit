import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import type { ProtectedEnvAccess } from 'src/lib/workflow-envs'

import { e2e } from '../e2e'
import type { E2eDeps } from '../e2e'
import type { E2eTarget } from '../e2e-target'

// Everything here is real except Playwright itself: a git worktree on disk, the consumer configs, the
// dev-context fragments, portless's routes.json, and loopback servers that answer the way vite and a
// backend do. The probe under test is the dev panel's own, so a fake cannot agree with a wrong probe.

const RELEASE = 'feat-x'
const UI_HOST = `${RELEASE}.hulyo-client-ui.localhost`
const API_ORIGIN = `https://${RELEASE}.backend-api.localhost`

const servers: http.Server[] = []
let root: string
let stateDir: string

const listen = async (handler: http.RequestListener): Promise<number> => {
  const server = http.createServer(handler)

  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  return (server.address() as AddressInfo).port
}

const viteServer = () => {
  return listen((req, res) => {
    res.statusCode = req.headers.accept === 'text/x-vite-ping' ? 204 : 200
    res.end()
  })
}

const backendServer = () => {
  return listen((_req, res) => {
    res.statusCode = 200
    res.end('ok')
  })
}

const write = (relative: string, content: string) => {
  const file = path.join(root, relative)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const writeConfig = (relative: string, config: unknown) => {
  write(relative, `export default ${JSON.stringify(config)}\n`)
}

const E2E_CLIENT = { target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL', cloud: 'https://<env>.hulyo.co.il' }

const seedRepo = () => {
  writeConfig('apps/client/tests/infra-kit.config.ts', { e2e: E2E_CLIENT })
  write('apps/client/ui/package.json', JSON.stringify({ name: '@hulyo/client-ui' }))
  writeConfig('apps/client/ui/infra-kit.config.ts', {
    dev: {
      proxy: {
        templates: { local: 'https://<release>.<packageName>.localhost', cloud: 'https://<env>.hulyo.co.il' },
        routes: {
          '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
          '/media': { packageName: 'backend-api', from: ['cloud'] },
        },
      },
    },
  })
  const git = (...args: string[]) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root })
  }

  git('init', '-q', '-b', RELEASE)
  // `rev-parse --abbrev-ref HEAD` has no branch to name until HEAD points at a commit.
  git('commit', '-q', '--allow-empty', '-m', 'init')
}

const registerUi = (port: number) => {
  fs.writeFileSync(path.join(stateDir, 'routes.json'), JSON.stringify([{ hostname: UI_HOST, port }]))
}

const writeBackendFragment = (port: number) => {
  write(
    '.infra-kit/dev-context/client.json',
    JSON.stringify({
      v: 2,
      package: 'backend-api',
      port,
      pid: process.pid,
      writtenAt: Date.now(),
      release: RELEASE,
      alias: `${RELEASE}.backend-api.localhost`,
      origin: API_ORIGIN,
    }),
  )
}

const allowed: ProtectedEnvAccess = { allowed: true, reason: 'allowed' }
const denied: ProtectedEnvAccess = { allowed: false, reason: 'disallow' }

const deps = (env: Record<string, string>, extra: Partial<E2eDeps> = {}): E2eDeps => {
  return {
    cwd: root,
    projectRoot: root,
    env,
    protectedEnvAccess: async () => {
      return denied
    },
    ...extra,
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-e2e-')))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-e2e-portless-'))
  vi.stubEnv('PORTLESS_STATE_DIR', stateDir)
  seedRepo()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  agentMode.source = null
  process.exitCode = undefined
  await Promise.all(
    servers.splice(0).map((server) => {
      return new Promise((resolve) => {
        server.close(resolve)
      })
    }),
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe('e2e — local', () => {
  it('runs against the worktree UI and reports the proxy split, local backend probed', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer())

    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[]) => {
      return 0
    })
    const result = await e2e(
      { playwrightArgs: ['--project=chromium'] },
      deps({ INFRA_KIT_ENV: 'dev' }, { runPlaywright }),
    )

    expect(result.structuredContent).toMatchObject({
      app: 'client',
      mode: 'local',
      baseUrl: `https://${UI_HOST}`,
      baseUrlEnv: 'E2E_CLIENT_BASE_URL',
      release: RELEASE,
      ran: true,
      exitCode: 0,
      routes: [
        { path: '/media', source: 'cloud', target: 'https://dev.hulyo.co.il', live: null },
        { path: '/api', source: 'local', target: API_ORIGIN, live: true },
      ],
    })
    expect(runPlaywright.mock.calls[0]?.[1]).toEqual(['--project=chromium'])
  })

  it('does not call a port that answers plain HTML a live UI', async () => {
    registerUi(
      await listen((_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html')
        res.end('<html></html>')
      }),
    )

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))

    expect(result.structuredContent.mode).toBe('cloud')
  })

  it('refuses when a route is held local but its backend is not serving', async () => {
    registerUi(await viteServer())
    // A boot-failed backend's held fragment: the route stays local, and nothing is bound.
    writeBackendFragment(0)

    await expect(e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(/\/api \(backend-api\)/)
  })

  it('runs without asking even for an agent — a local run touches only this machine', async () => {
    agentMode.source = 'flag'
    registerUi(await viteServer())

    const runPlaywright = vi.fn(async () => {
      return 0
    })
    const result = await e2e({}, deps({}, { runPlaywright }))

    expect(result.structuredContent.mode).toBe('local')
    expect(runPlaywright).toHaveBeenCalledOnce()
  })
})

describe('e2e — cloud', () => {
  it('falls to the cloud template at INFRA_KIT_ENV when nothing serves the target', async () => {
    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'oriana' }))

    expect(result.structuredContent).toMatchObject({
      mode: 'cloud',
      baseUrl: 'https://oriana.hulyo.co.il',
      env: 'oriana',
      localUrl: `https://${UI_HOST}`,
      routes: [],
      ran: false,
    })
  })

  it('asks an agent to confirm before running against a shared env', async () => {
    agentMode.source = 'flag'

    const runPlaywright = vi.fn(async () => {
      return 0
    })
    const error = await e2e({}, deps({ INFRA_KIT_ENV: 'dev' }, { runPlaywright })).catch((caught: unknown) => {
      return caught
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent.status).toBe('confirmation_required')
    expect(runPlaywright).not.toHaveBeenCalled()
  })

  it('runs a cloud target with --yes and hands Playwright the resolved URL', async () => {
    agentMode.source = 'flag'

    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[]) => {
      return 1
    })
    const result = await e2e({ yes: true }, deps({ INFRA_KIT_ENV: 'dev' }, { runPlaywright }))

    expect(runPlaywright.mock.calls[0]?.[0].baseUrl).toBe('https://dev.hulyo.co.il')
    expect(result.structuredContent.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })

  it('refuses a protected env unless the project allows it', async () => {
    await expect(e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'prod' }))).rejects.toThrow(/protected environment/)

    const result = await e2e(
      { dryRun: true },
      deps(
        { INFRA_KIT_ENV: 'prod' },
        {
          protectedEnvAccess: async () => {
            return allowed
          },
        },
      ),
    )

    expect(result.structuredContent.baseUrl).toBe('https://prod.hulyo.co.il')
  })

  it('names both ways out when there is no dev server and no env', async () => {
    await expect(e2e({ dryRun: true }, deps({}))).rejects.toThrow(/INFRA_KIT_ENV is not set/)
  })

  it('uses the env-loaded base URL when the package declares no cloud template', async () => {
    writeConfig('apps/client/tests/infra-kit.config.ts', {
      e2e: { target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL' },
    })

    const result = await e2e(
      { dryRun: true },
      deps({ INFRA_KIT_ENV: 'dev', E2E_CLIENT_BASE_URL: 'https://dev.hulyo.co.il' }),
    )

    expect(result.structuredContent).toMatchObject({ mode: 'cloud', baseUrl: 'https://dev.hulyo.co.il' })
  })

  it('refuses the env-loaded base URL when INFRA_KIT_ENV does not name its env', async () => {
    writeConfig('apps/client/tests/infra-kit.config.ts', {
      e2e: { target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL' },
    })

    await expect(e2e({ dryRun: true }, deps({ E2E_CLIENT_BASE_URL: 'https://dev.hulyo.co.il' }))).rejects.toThrow(
      /INFRA_KIT_ENV is not set/,
    )
  })

  it('refuses cloud when neither a template nor the env-loaded variable names it', async () => {
    writeConfig('apps/client/tests/infra-kit.config.ts', {
      e2e: { target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL' },
    })

    await expect(e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /E2E_CLIENT_BASE_URL is not set/,
    )
  })
})

describe('e2e — picking the package', () => {
  beforeEach(() => {
    writeConfig('apps/backoffice/tests/infra-kit.config.ts', {
      e2e: {
        target: 'backoffice/ui',
        baseUrlEnv: 'E2E_BACKOFFICE_BASE_URL',
        cloud: 'https://backoffice.<env>.hulyo.co.il',
      },
    })
    write('apps/backoffice/ui/package.json', JSON.stringify({ name: '@hulyo/backoffice-ui' }))
  })

  it('refuses with the e2e apps as choices when it cannot tell which one', async () => {
    const error = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' })).catch((caught: unknown) => {
      return caught
    })

    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'argument_required',
      argument: 'app',
      choices: { properties: { app: { enum: ['backoffice', 'client'] } } },
    })
  })

  it('infers the app from a cwd inside apps/<app>/', async () => {
    const result = await e2e(
      { dryRun: true },
      { ...deps({ INFRA_KIT_ENV: 'dev' }), cwd: path.join(root, 'apps/backoffice/tests') },
    )

    expect(result.structuredContent).toMatchObject({
      app: 'backoffice',
      baseUrl: 'https://backoffice.dev.hulyo.co.il',
      baseUrlEnv: 'E2E_BACKOFFICE_BASE_URL',
    })
  })

  it('takes --app over the cwd', async () => {
    const result = await e2e(
      { app: 'client', dryRun: true },
      { ...deps({ INFRA_KIT_ENV: 'dev' }), cwd: path.join(root, 'apps/backoffice/tests') },
    )

    expect(result.structuredContent.app).toBe('client')
  })
})
