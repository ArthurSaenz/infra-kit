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

const writeTargetConfig = (config: Record<string, string>) => {
  write('apps/client/ui/infra-kit.config.ts', `export default ${JSON.stringify(config)}\n`)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-playwright-')))
  testsDir = path.join(root, 'apps/client/tests')
  write('pnpm-workspace.yaml', 'packages: []\n')
  write('apps/client/ui/package.json', JSON.stringify({ name: '@hulyo/client-ui' }))
  writeTargetConfig({ deployedUrlEnv: 'CLIENT_URL' })
  writeE2e({ target: 'client/ui' })
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
    const setup = await infraKitE2e({ dir: testsDir, env: {} })

    expect(setup).toMatchObject({
      mode: 'local',
      baseURL: 'https://hul-7.hulyo-client-ui.localhost',
      deployedUrlEnv: 'CLIENT_URL',
      ignoreHTTPSErrors: true,
      webServer: {
        command: 'infra-kit dev client --no-watch --reuse',
        cwd: root,
        gracefulShutdown: { signal: 'SIGTERM' },
      },
    })
    expect(setup.webServer?.wait.stdout.test(`${DEV_SERVING_MARKER} client`)).toBe(true)
  })

  it('leaves the deployed URL in env, where the dev server it starts proxies cloud routes to it', async () => {
    const env: NodeJS.ProcessEnv = { CLIENT_URL: 'https://dev.hulyo.co.il' }

    await infraKitE2e({ dir: testsDir, env })

    expect(env).toEqual({ CLIENT_URL: 'https://dev.hulyo.co.il' })
  })

  it('stays local when a deployed URL is loaded, unless the run asks for cloud', async () => {
    const setup = await infraKitE2e({
      dir: testsDir,
      env: { INFRA_KIT_ENV: 'dev', CLIENT_URL: 'https://dev.hulyo.co.il' },
    })

    expect(setup.mode).toBe('local')
  })
})

describe('infraKitE2e — cloud', () => {
  it('uses the target’s deployedUrlEnv verbatim and starts nothing', async () => {
    const env: NodeJS.ProcessEnv = { INFRA_KIT_E2E: 'cloud', CLIENT_URL: 'https://www.hulyo.co.il' }
    const setup = await infraKitE2e({ dir: testsDir, env })

    expect(setup).toEqual({
      mode: 'cloud',
      baseURL: 'https://www.hulyo.co.il',
      deployedUrlEnv: 'CLIENT_URL',
      ignoreHTTPSErrors: false,
      webServer: undefined,
    })
    expect(env).toEqual({ INFRA_KIT_E2E: 'cloud', CLIENT_URL: 'https://www.hulyo.co.il' })
  })

  it('never builds the URL from INFRA_KIT_ENV', async () => {
    await expect(
      infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud', INFRA_KIT_ENV: 'oriana' } }),
    ).rejects.toThrow(/needs CLIENT_URL, and it is not set/)
  })

  it('defaults to cloud on CI, where no dev server can run', async () => {
    const setup = await infraKitE2e({ dir: testsDir, env: { CI: 'true', CLIENT_URL: 'https://dev.hulyo.co.il' } })

    expect(setup).toMatchObject({ mode: 'cloud', baseURL: 'https://dev.hulyo.co.il' })
  })

  it('names the target’s deployedUrlEnv when it is unset', async () => {
    await expect(infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud' } })).rejects.toThrow(
      /client\/ui needs CLIENT_URL, and it is not set/,
    )
  })

  it('treats an empty deployedUrlEnv value as unset', async () => {
    await expect(infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud', CLIENT_URL: '' } })).rejects.toThrow(
      /needs CLIENT_URL/,
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

  it('runs locally without a deployedUrlEnv — only a cloud run needs one', async () => {
    writeTargetConfig({})

    const setup = await infraKitE2e({ dir: testsDir, env: {} })

    expect(setup).toMatchObject({ mode: 'local', deployedUrlEnv: undefined })
    await expect(
      infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud', CLIENT_URL: 'https://dev.hulyo.co.il' } }),
    ).rejects.toThrow(/a cloud run needs .*client\/ui\/infra-kit\.config\.ts to declare `deployedUrlEnv`/)
  })

  it('runs locally for a target with no infra-kit.config.ts at all', async () => {
    fs.rmSync(path.join(root, 'apps/client/ui/infra-kit.config.ts'))

    expect((await infraKitE2e({ dir: testsDir, env: {} })).mode).toBe('local')
    await expect(infraKitE2e({ dir: testsDir, env: { INFRA_KIT_E2E: 'cloud' } })).rejects.toThrow(
      /to declare `deployedUrlEnv`/,
    )
  })

  it('refuses the retired e2e.baseUrlEnv, pointing at deployedUrlEnv', async () => {
    writeE2e({ target: 'client/ui', baseUrlEnv: 'E2E_CLIENT_BASE_URL' })

    await expect(infraKitE2e({ dir: testsDir, env: {} })).rejects.toThrow(/deployedUrlEnv/)
  })
})
