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

/** The target UI's `deployedUrlEnv`: env-load puts the deployed URL there, per environment. */
const CLIENT_URL = 'CLIENT_URL'

const CLIENT_PROXY = {
  templates: { local: 'https://<release>.<packageName>.localhost' },
  routes: {
    '/api': { packageName: 'backend-api', from: ['local', 'cloud'], default: 'cloud' },
    '/media': { packageName: 'backend-api', from: ['cloud'] },
  },
}

const seedRepo = () => {
  writeConfig('apps/client/tests/infra-kit.config.ts', { e2e: { target: 'client/ui' } })
  write('apps/client/ui/package.json', JSON.stringify({ name: '@hulyo/client-ui' }))
  writeConfig('apps/client/ui/infra-kit.config.ts', { deployedUrlEnv: CLIENT_URL, dev: { proxy: CLIENT_PROXY } })
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

const writeBackendFragment = (port: number, env?: string) => {
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
      ...(env === undefined ? {} : { env }),
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

describe('e2e — local (the default)', () => {
  const usesHelper = () => {
    write('apps/client/tests/playwright.config.ts', 'const e2e = await infraKitE2e({ dir: import.meta.dirname })\n')
  }

  it('runs against the served worktree UI and reports the proxy split, local backend probed', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer())

    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[]) => {
      return 0
    })
    const result = await e2e(
      { playwrightArgs: ['--project=chromium'] },
      deps({ INFRA_KIT_ENV: 'dev', [CLIENT_URL]: 'https://dev.hulyo.co.il' }, { runPlaywright }),
    )

    expect(result.structuredContent).toMatchObject({
      app: 'client',
      mode: 'local',
      baseUrl: `https://${UI_HOST}`,
      deployedUrlEnv: CLIENT_URL,
      release: RELEASE,
      served: true,
      devCommand: null,
      ran: true,
      exitCode: 0,
      routes: [
        { path: '/media', source: 'cloud', target: 'https://dev.hulyo.co.il', live: null },
        { path: '/api', source: 'local', target: API_ORIGIN, live: true },
      ],
    })
    expect(runPlaywright.mock.calls[0]?.[1]).toEqual(['--project=chromium'])
  })

  it('reports a cloud-only route with no target when the deployed URL is not loaded', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer())

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))
    const media = result.structuredContent.routes.find((route) => {
      return route.path === '/media'
    })

    // The env name alone names no host: without CLIENT_URL there is nothing to report as the target.
    expect(media).toMatchObject({ source: 'cloud', live: null })
    expect(media?.target ?? null).toBeNull()
  })

  it('stays local with a cloud env loaded, handing the start to the Playwright config', async () => {
    usesHelper()

    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[]) => {
      return 0
    })
    const result = await e2e({}, deps({ INFRA_KIT_ENV: 'dev' }, { runPlaywright }))

    expect(result.structuredContent).toMatchObject({
      mode: 'local',
      baseUrl: `https://${UI_HOST}`,
      served: false,
      devCommand: 'infra-kit dev client --no-watch --reuse',
      routes: [],
    })
    expect(runPlaywright.mock.calls[0]?.[0].mode).toBe('local')
  })

  it('refuses when nothing serves the target and the Playwright config would not start it', async () => {
    await expect(e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /Playwright config does not start it/,
    )
  })

  it('does not call a port that answers plain HTML a served UI', async () => {
    usesHelper()
    registerUi(
      await listen((_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html')
        res.end('<html></html>')
      }),
    )

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))

    expect(result.structuredContent).toMatchObject({ mode: 'local', served: false })
  })

  it('reports the env the served dev session recorded when it matches this shell', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer(), 'dev')

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))

    expect(result.structuredContent).toMatchObject({ served: true, env: 'dev', servedEnv: 'dev' })
  })

  it('refuses when the served dev session runs with another env than this shell', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer(), 'stage')

    await expect(e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /runs with env "stage", this shell with "dev"/,
    )
  })

  it('trusts a fragment that recorded no env, as an older CLI writes it', async () => {
    registerUi(await viteServer())
    writeBackendFragment(await backendServer())

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))

    expect(result.structuredContent).toMatchObject({ served: true, servedEnv: null })
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

describe('e2e — per-test results for a machine reader', () => {
  const REPORT = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/playwright-report.json'), 'utf8')

  beforeEach(() => {
    agentMode.source = 'flag'
  })

  it('injects the JSON reporter, points it at a temp file, and returns its failures', async () => {
    registerUi(await viteServer())

    let reportFile = ''
    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[], env: Record<string, string>) => {
      reportFile = env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? ''
      fs.writeFileSync(reportFile, REPORT)

      return 1
    })
    const result = await e2e({ playwrightArgs: ['src/tests/checkout'] }, deps({}, { runPlaywright }))

    expect(runPlaywright.mock.calls[0]?.[1]).toEqual(['--reporter=line,json', 'src/tests/checkout'])
    expect(runPlaywright.mock.calls[0]?.[2]).toEqual({
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
    })
    expect(result.structuredContent).toMatchObject({
      exitCode: 1,
      report: 'collected',
      summary: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
    })
    expect(
      result.structuredContent.failures.map((failure) => {
        return failure.tracePath
      }),
    ).toEqual([
      '/repo/apps/client/tests/test-results/coupon/trace.zip',
      '/repo/apps/client/tests/test-results/apply/trace.zip',
    ])
    expect(fs.existsSync(reportFile)).toBe(false)
  })

  it('leaves a caller-chosen reporter alone and says no report was collected', async () => {
    registerUi(await viteServer())

    const runPlaywright = vi.fn(async () => {
      return 0
    })
    const result = await e2e({ playwrightArgs: ['--reporter=dot'] }, deps({}, { runPlaywright }))

    expect(runPlaywright.mock.calls[0]).toEqual([expect.anything(), ['--reporter=dot'], {}])
    expect(result.structuredContent).toMatchObject({ report: 'caller-reporter', summary: null, failures: [] })
  })

  it('reports the results unavailable when Playwright wrote no report, without failing the call', async () => {
    registerUi(await viteServer())

    const runPlaywright = vi.fn(async () => {
      return 1
    })
    const result = await e2e({}, deps({}, { runPlaywright }))

    expect(result.structuredContent).toMatchObject({ exitCode: 1, report: 'unavailable', summary: null, failures: [] })
  })

  it('injects nothing for a human at a terminal', async () => {
    agentMode.source = null
    registerUi(await viteServer())

    const runPlaywright = vi.fn(async () => {
      return 0
    })
    const result = await e2e({ playwrightArgs: ['src/tests/checkout'] }, deps({}, { runPlaywright }))

    expect(runPlaywright.mock.calls[0]).toEqual([expect.anything(), ['src/tests/checkout'], {}])
    expect(result.structuredContent.report).toBe('off')
  })
})

describe('e2e — --cloud', () => {
  it('uses the loaded CLIENT_URL at INFRA_KIT_ENV, even when this worktree serves the target', async () => {
    registerUi(await viteServer())

    const result = await e2e(
      { cloud: true, dryRun: true },
      deps({ INFRA_KIT_ENV: 'oriana', [CLIENT_URL]: 'https://oriana.hulyo.co.il' }),
    )

    expect(result.structuredContent).toMatchObject({
      mode: 'cloud',
      baseUrl: 'https://oriana.hulyo.co.il',
      deployedUrlEnv: CLIENT_URL,
      env: 'oriana',
      localUrl: `https://${UI_HOST}`,
      devCommand: null,
      routes: [],
      ran: false,
    })
  })

  it('asks an agent to confirm before running against a shared env', async () => {
    agentMode.source = 'flag'

    const runPlaywright = vi.fn(async () => {
      return 0
    })
    const error = await e2e(
      { cloud: true },
      deps({ INFRA_KIT_ENV: 'dev', [CLIENT_URL]: 'https://dev.hulyo.co.il' }, { runPlaywright }),
    ).catch((caught: unknown) => {
      return caught
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent.status).toBe('confirmation_required')
    expect(runPlaywright).not.toHaveBeenCalled()
  })

  it('runs a cloud target with --yes and hands Playwright the loaded URL', async () => {
    agentMode.source = 'flag'

    const runPlaywright = vi.fn(async (_target: E2eTarget, _args: string[]) => {
      return 1
    })
    const result = await e2e(
      { cloud: true, yes: true },
      deps({ INFRA_KIT_ENV: 'dev', [CLIENT_URL]: 'https://dev.hulyo.co.il' }, { runPlaywright }),
    )

    expect(runPlaywright.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: 'https://dev.hulyo.co.il',
      deployedUrlEnv: CLIENT_URL,
    })
    expect(result.structuredContent.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })

  it('refuses a protected env unless the project allows it, then uses its URL verbatim', async () => {
    // prod is not `<env>`-shaped — exactly why the URL is loaded, not derived from the env name.
    const prod = { INFRA_KIT_ENV: 'prod', [CLIENT_URL]: 'https://www.hulyo.co.il' }

    await expect(e2e({ cloud: true, dryRun: true }, deps(prod))).rejects.toThrow(/protected environment/)

    const result = await e2e(
      { cloud: true, dryRun: true },
      deps(prod, {
        protectedEnvAccess: async () => {
          return allowed
        },
      }),
    )

    expect(result.structuredContent.baseUrl).toBe('https://www.hulyo.co.il')
  })

  it('names the missing env when none is loaded, even with a URL left in the shell', async () => {
    await expect(e2e({ cloud: true, dryRun: true }, deps({ [CLIENT_URL]: 'https://dev.hulyo.co.il' }))).rejects.toThrow(
      /INFRA_KIT_ENV is not set/,
    )
  })

  it('refuses cloud when the deployed URL is not loaded, naming the variable', async () => {
    await expect(e2e({ cloud: true, dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /CLIENT_URL is not set/,
    )
  })
})

describe('e2e — the target declares its deployed URL variable', () => {
  it('runs locally without a deployedUrlEnv, and refuses only a cloud run for want of one', async () => {
    writeConfig('apps/client/ui/infra-kit.config.ts', {
      dev: { proxy: { ...CLIENT_PROXY, routes: { '/api': { packageName: 'backend-api', from: ['local'] } } } },
    })
    registerUi(await viteServer())
    writeBackendFragment(await backendServer())

    const result = await e2e({ dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))

    expect(result.structuredContent).toMatchObject({ mode: 'local', deployedUrlEnv: null })
    await expect(e2e({ cloud: true, dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /client\/ui names no variable holding its deployed URL/,
    )
  })

  it('refuses a target config still carrying templates.cloud, naming the replacement', async () => {
    writeConfig('apps/client/ui/infra-kit.config.ts', {
      deployedUrlEnv: CLIENT_URL,
      dev: { proxy: { ...CLIENT_PROXY, templates: { ...CLIENT_PROXY.templates, cloud: 'https://<env>.hulyo.co.il' } } },
    })

    await expect(
      e2e({ cloud: true, dryRun: true }, deps({ INFRA_KIT_ENV: 'dev', [CLIENT_URL]: 'https://dev.hulyo.co.il' })),
    ).rejects.toThrow(/`templates\.cloud` was replaced by `deployedUrlEnv`/)
  })
})

describe('e2e — picking the package', () => {
  beforeEach(() => {
    writeConfig('apps/backoffice/tests/infra-kit.config.ts', { e2e: { target: 'backoffice/ui' } })
    write('apps/backoffice/ui/package.json', JSON.stringify({ name: '@hulyo/backoffice-ui' }))
    writeConfig('apps/backoffice/ui/infra-kit.config.ts', { deployedUrlEnv: 'BACKOFFICE_URL' })
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
      { cloud: true, dryRun: true },
      {
        ...deps({ INFRA_KIT_ENV: 'dev', BACKOFFICE_URL: 'https://backoffice.dev.hulyo.co.il' }),
        cwd: path.join(root, 'apps/backoffice/tests'),
      },
    )

    // Each target reads its OWN variable — the picked app decides which URL the run gets.
    expect(result.structuredContent).toMatchObject({
      app: 'backoffice',
      baseUrl: 'https://backoffice.dev.hulyo.co.il',
      deployedUrlEnv: 'BACKOFFICE_URL',
    })
  })

  it('surfaces a tests config the schema refuses, rather than dropping the package', async () => {
    writeConfig('apps/backoffice/tests/infra-kit.config.ts', {
      e2e: { target: 'backoffice/ui', baseUrlEnv: 'E2E_BACKOFFICE_BASE_URL' },
    })

    await expect(e2e({ app: 'client', dryRun: true }, deps({ INFRA_KIT_ENV: 'dev' }))).rejects.toThrow(
      /`e2e.baseUrlEnv` was removed/,
    )
  })

  it('takes --app over the cwd', async () => {
    const result = await e2e(
      { app: 'client', cloud: true, dryRun: true },
      {
        ...deps({ INFRA_KIT_ENV: 'dev', [CLIENT_URL]: 'https://dev.hulyo.co.il' }),
        cwd: path.join(root, 'apps/backoffice/tests'),
      },
    )

    expect(result.structuredContent.app).toBe('client')
  })
})
