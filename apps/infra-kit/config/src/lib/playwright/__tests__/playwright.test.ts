import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEV_SERVING_MARKER, infraKitE2e } from '../playwright'

let root: string
let testsDir: string

const write = (relative: string, content: string) => {
  const file = path.join(root, relative)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const writeE2e = (e2e: Record<string, string>) => {
  write('apps/client/tests/infra-kit.config.ts', `export default { e2e: ${JSON.stringify(e2e)} }\n`)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-playwright-')))
  testsDir = path.join(root, 'apps/client/tests')
  write('pnpm-workspace.yaml', 'packages: []\n')
  write('apps/client/ui/package.json', JSON.stringify({ name: '@hulyo/client-ui' }))
  writeE2e({ target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL', cloud: 'https://<env>.hulyo.co.il' })
  const git = (...args: string[]) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root })
  }

  git('init', '-q', '-b', 'feature/HUL-7')
  // `rev-parse --abbrev-ref HEAD` has no branch to name until HEAD points at a commit.
  git('commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('infraKitE2e — local', () => {
  it('points at this worktree’s alias and serves it with `infra-kit dev <app> --reuse`', async () => {
    const env: NodeJS.ProcessEnv = { E2E_CLIENT_BASE_URL: 'https://dev.hulyo.co.il' }
    const setup = await infraKitE2e({ dir: testsDir, env })

    expect(setup).toMatchObject({
      mode: 'local',
      baseURL: 'https://hul-7.hulyo-client-ui.localhost',
      ignoreHTTPSErrors: true,
      webServer: {
        command: 'infra-kit dev client --no-watch --reuse',
        cwd: root,
        gracefulShutdown: { signal: 'SIGTERM' },
      },
    })
    expect(setup.webServer?.wait.stdout.test(`${DEV_SERVING_MARKER} client`)).toBe(true)
    // The Doppler-loaded cloud URL must not leak into a local run's workers.
    expect(env.E2E_CLIENT_BASE_URL).toBe('https://hul-7.hulyo-client-ui.localhost')
  })

  it('stays local when a cloud env is loaded, unless the run asks for cloud', async () => {
    const setup = await infraKitE2e({ dir: testsDir, env: { INFRA_KIT_ENV: 'dev' } })

    expect(setup.mode).toBe('local')
  })
})

describe('infraKitE2e — cloud', () => {
  it('uses the cloud template at INFRA_KIT_ENV and starts nothing', async () => {
    const setup = await infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud', INFRA_KIT_ENV: 'oriana' } })

    expect(setup).toEqual({
      mode: 'cloud',
      baseURL: 'https://oriana.hulyo.co.il',
      ignoreHTTPSErrors: false,
      webServer: undefined,
    })
  })

  it('defaults to cloud on CI, where no dev server can run', async () => {
    const setup = await infraKitE2e({ dir: testsDir, env: { CI: 'true', INFRA_KIT_ENV: 'dev' } })

    expect(setup.mode).toBe('cloud')
  })

  it('uses the env-loaded base URL when the package declares no cloud template', async () => {
    writeE2e({ target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL' })

    const setup = await infraKitE2e({
      dir: testsDir,
      env: { INFRA_KIT_E2E: 'cloud', E2E_CLIENT_BASE_URL: 'https://dev.hulyo.co.il' },
    })

    expect(setup.baseURL).toBe('https://dev.hulyo.co.il')
  })

  it('names the missing variable when the cloud side cannot be resolved', async () => {
    await expect(infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud' } })).rejects.toThrow(
      /INFRA_KIT_ENV is not set/,
    )
  })
})

describe('infraKitE2e — config errors', () => {
  it('refuses an unknown mode', async () => {
    await expect(infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'staging' } })).rejects.toThrow(
      /expected "local" or "cloud"/,
    )
  })

  it('refuses a package with no e2e block', async () => {
    write('apps/client/tests/infra-kit.config.ts', 'export default {}\n')

    await expect(infraKitE2e({ dir: testsDir, env: {} })).rejects.toThrow(/declares no `e2e` block/)
  })
})
