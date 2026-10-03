import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { E2E_SCRIPTS } from 'src/lib/package-config'

import { checkE2e, checkE2eAuthIgnored, checkE2eBasicAuthNaming, checkE2eConfig, checkE2eScripts } from '../e2e-check'

const tmpDirs: string[] = []

const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-check-'))

  tmpDirs.push(dir)

  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()

    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** The shape every conforming suite's `playwright.config.ts` carries — the lines the check reads. */
const CONFORMING_CONFIG = `
const SLOW_MO = Number(process.env.E2E_SLOW_MO ?? 0)
const e2e = await infraKitE2e({ dir: import.meta.dirname })

export default defineConfig({
  timeout: 30_000 + SLOW_MO * 100,
  use: {
    launchOptions: { slowMo: SLOW_MO },
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
  },
})
`

const writeConfig = (dir: string, content: string): void => {
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), content)
}

const failures = (checks: { status: string; name: string }[]): string[] => {
  return checks
    .filter((check) => {
      return check.status === 'fail'
    })
    .map((check) => {
      return check.name
    })
}

describe('checkE2eScripts', () => {
  it('passes when every shared script is present with its exact value', () => {
    expect(failures(checkE2eScripts({ ...E2E_SCRIPTS }))).toEqual([])
  })

  it('reports one check per shared script, named after it', () => {
    const names = checkE2eScripts({}).map((check) => {
      return check.name
    })

    expect(names).toEqual(
      Object.keys(E2E_SCRIPTS).map((script) => {
        return `e2e-script:${script}`
      }),
    )
  })

  it('fails a missing script and names the expected value', () => {
    const rest = Object.fromEntries(
      Object.entries(E2E_SCRIPTS).filter(([script]) => {
        return script !== 'e2e-test-ui-demo'
      }),
    )
    const check = checkE2eScripts(rest).find((candidate) => {
      return candidate.name === 'e2e-script:e2e-test-ui-demo'
    })

    expect(check).toMatchObject({ status: 'fail' })
    expect(check?.message).toContain('missing')
    expect(check?.message).toContain(E2E_SCRIPTS['e2e-test-ui-demo'])
  })

  it('fails a script whose value drifts, even by a flag', () => {
    const scripts = { ...E2E_SCRIPTS, 'e2e-test-chrome': 'pnpm exec playwright test --project=chromium --headed' }
    const check = checkE2eScripts(scripts).find((candidate) => {
      return candidate.name === 'e2e-script:e2e-test-chrome'
    })

    expect(check).toMatchObject({ status: 'fail' })
    expect(check?.message).toContain('drifts')
  })

  it('ignores surrounding whitespace in the value', () => {
    expect(failures(checkE2eScripts({ ...E2E_SCRIPTS, 'e2e-test': '  pnpm exec playwright test ' }))).toEqual([])
  })

  it('does not object to extra scripts beside the shared ones', () => {
    expect(failures(checkE2eScripts({ ...E2E_SCRIPTS, 'serve-dist': 'node ./scripts/serve-dist.mjs' }))).toEqual([])
  })
})

describe('checkE2eConfig', () => {
  it('passes a config carrying the slow-mo env read, launch option, timeout headroom and local trace', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG)

    const checks = await checkE2eConfig(dir)

    expect(failures(checks)).toEqual([])
    expect(
      checks.map((check) => {
        return check.name
      }),
    ).toEqual([
      'e2e-config:slow-mo',
      'e2e-config:launch-options',
      'e2e-config:timeout-headroom',
      'e2e-config:trace',
      'e2e-config:infra-kit-e2e',
    ])
  })

  it('fails as a single check when playwright.config.ts is missing', async () => {
    const dir = makeTmpDir()

    const checks = await checkE2eConfig(dir)

    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'e2e-config:playwright.config.ts', status: 'fail' })
  })

  it('fails only the rule a config lacks, and says what was expected', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG.replace('timeout: 30_000 + SLOW_MO * 100', 'timeout: 30_000'))

    const checks = await checkE2eConfig(dir)

    expect(failures(checks)).toEqual(['e2e-config:timeout-headroom'])
    expect(checks[2]?.message).toContain('SLOW_MO * 100')
  })

  it('fails a config that reads the env but never feeds it to the browser', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG.replace('launchOptions: { slowMo: SLOW_MO },', ''))

    expect(failures(await checkE2eConfig(dir))).toEqual(['e2e-config:launch-options'])
  })

  it('fails the CI-only trace setting that leaves a local failure without a trace', async () => {
    const dir = makeTmpDir()

    writeConfig(
      dir,
      CONFORMING_CONFIG.replace(
        "trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure'",
        "trace: 'on-first-retry'",
      ),
    )

    expect(failures(await checkE2eConfig(dir))).toEqual(['e2e-config:trace'])
  })

  it('fails a config that never calls infraKitE2e, the source of baseURL and webServer', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG.replace('const e2e = await infraKitE2e({ dir: import.meta.dirname })', ''))

    const checks = await checkE2eConfig(dir)

    expect(failures(checks)).toEqual(['e2e-config:infra-kit-e2e'])
    expect(checks[4]?.message).toContain('infraKitE2e()')
  })

  it('accepts a larger base timeout as long as the headroom is there', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG.replace('30_000 + SLOW_MO * 100', '90_000 + SLOW_MO * 100'))

    expect(failures(await checkE2eConfig(dir))).toEqual([])
  })
})

describe('checkE2e', () => {
  it('concatenates the script checks and the config checks', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, CONFORMING_CONFIG)

    const checks = await checkE2e(dir, { ...E2E_SCRIPTS })

    expect(checks).toHaveLength(Object.keys(E2E_SCRIPTS).length + 7)
    expect(failures(checks)).toEqual([])
  })
})

describe('checkE2eAuthIgnored', () => {
  const gitRepo = (gitignore: string | null): string => {
    const dir = makeTmpDir()

    // eslint-disable-next-line sonarjs/no-os-command-from-path
    execFileSync('git', ['init', '-q'], { cwd: dir })
    if (gitignore !== null) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore)

    return dir
  }

  const writeSetup = (dir: string, content: string): void => {
    fs.mkdirSync(path.join(dir, 'src/setup'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/setup/auth.setup.ts'), content)
  }

  const AUTH_SETUP = "const STATE = path.join(import.meta.dirname, '../../.auth/user.json')\n"

  it('passes when src saves auth state under a gitignored .auth/', async () => {
    const dir = gitRepo('node_modules\n.auth/\n')

    writeSetup(dir, AUTH_SETUP)

    expect(await checkE2eAuthIgnored(dir)).toMatchObject({ name: 'e2e-auth:gitignored', status: 'pass' })
  })

  it('fails when src saves auth state under .auth/ and git would commit it', async () => {
    const dir = gitRepo('node_modules\n')

    writeSetup(dir, "await page.context().storageState({ path: join(root, '.auth', 'user.json') })\n")

    const check = await checkE2eAuthIgnored(dir)

    expect(check).toMatchObject({ status: 'fail' })
    expect(check.message).toContain('add `.auth/` to .gitignore')
  })

  it('fails when only playwright.config.ts names an un-ignored .auth/ storage state', async () => {
    const dir = gitRepo('node_modules\n')

    fs.writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      "export default { use: { storageState: '.auth/user.json' } }\n",
    )

    expect(await checkE2eAuthIgnored(dir)).toMatchObject({ name: 'e2e-auth:gitignored', status: 'fail' })
  })

  it('passes without asking git when nothing in src references .auth', async () => {
    const dir = makeTmpDir()

    writeSetup(dir, "const oauth = 'oauth/callback'\nconst file = 'user.auth.json'\n")

    expect(await checkE2eAuthIgnored(dir)).toMatchObject({ status: 'pass', message: 'no saved auth state referenced' })
  })

  it('passes a package with no src directory at all', async () => {
    expect(await checkE2eAuthIgnored(makeTmpDir())).toMatchObject({ status: 'pass' })
  })
})

describe('checkE2eBasicAuthNaming', () => {
  const writeEnvFile = (dir: string, content: string): void => {
    fs.mkdirSync(path.join(dir, 'src/config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/config/environment.ts'), content)
  }

  it('passes a suite that reads only the canonical pair', async () => {
    const dir = makeTmpDir()

    writeConfig(dir, 'username: process.env.E2E__BASIC_AUTH_USERNAME, password: process.env.E2E__BASIC_AUTH_PASSWORD')

    expect(await checkE2eBasicAuthNaming(dir)).toMatchObject({ name: 'e2e-env:basic-auth', status: 'pass' })
  })

  it('fails a per-app name in src, naming the file and the canonical name to rename to', async () => {
    const dir = makeTmpDir()

    writeEnvFile(
      dir,
      'const user = process.env.E2E_CLIENT_BASIC_AUTH_USERNAME\nconst pass = process.env.E2E_CLIENT_BASIC_AUTH_PASSWORD\n',
    )

    const check = await checkE2eBasicAuthNaming(dir)

    expect(check.status).toBe('fail')
    expect(check.message).toContain(
      `E2E_CLIENT_BASIC_AUTH_USERNAME → E2E__BASIC_AUTH_USERNAME (${path.join('src', 'config', 'environment.ts')})`,
    )
    expect(check.message).toContain('E2E_CLIENT_BASIC_AUTH_PASSWORD → E2E__BASIC_AUTH_PASSWORD')
  })

  it('fails a fallback to the old name even beside the canonical one', async () => {
    const dir = makeTmpDir()

    writeConfig(
      dir,
      'username: process.env.E2E__BASIC_AUTH_USERNAME || process.env.E2E_MULTIVENDOR_BASIC_AUTH_USERNAME',
    )

    const check = await checkE2eBasicAuthNaming(dir)

    expect(check.status).toBe('fail')
    expect(check.message).toContain(
      'E2E_MULTIVENDOR_BASIC_AUTH_USERNAME → E2E__BASIC_AUTH_USERNAME (playwright.config.ts)',
    )
    expect(check.message).not.toContain('E2E__BASIC_AUTH_USERNAME →')
  })

  it('fails the single-underscore spelling', async () => {
    const dir = makeTmpDir()

    writeEnvFile(dir, 'process.env.E2E_BASIC_AUTH_PASSWORD')

    expect((await checkE2eBasicAuthNaming(dir)).message).toContain('E2E_BASIC_AUTH_PASSWORD → E2E__BASIC_AUTH_PASSWORD')
  })

  it('ignores markdown, which documents names rather than reading them', async () => {
    const dir = makeTmpDir()

    fs.writeFileSync(path.join(dir, 'README.md'), 'formerly E2E_CLIENT_BASIC_AUTH_USERNAME')

    expect(await checkE2eBasicAuthNaming(dir)).toMatchObject({ status: 'pass' })
  })
})
