import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_RULES, E2E_SCRIPTS, ROOT_DEFAULT_RULES } from 'src/lib/package-config'

import { discoverPackages, loadPackageConfig, validatePackage } from '../package-validator'

const tmpDirs: string[] = []

const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-validator-'))

  tmpDirs.push(dir)

  return dir
}

interface PackageFixture {
  packageJson?: Record<string, unknown>
  config?: string
  files?: Record<string, string>
}

const writePackage = (dir: string, fixture: PackageFixture): void => {
  const packageJson = fixture.packageJson ?? { name: '@x/pkg', type: 'module' }

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2))

  if (fixture.config !== undefined) {
    fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), fixture.config)
  }

  for (const [name, content] of Object.entries(fixture.files ?? {})) {
    fs.writeFileSync(path.join(dir, name), content)
  }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('loadPackageConfig', () => {
  it('throws when infra-kit.config.js is missing', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {})

    await expect(loadPackageConfig(dir)).rejects.toThrow(/not found/)
  })

  it('loads an object default export and merges defaults', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: 'export default { requiredScripts: [] }' })

    const rules = await loadPackageConfig(dir)

    expect(rules.requiredScripts).toEqual([])
    expect(rules.requiredFiles).toEqual(DEFAULT_RULES.requiredFiles)
  })

  it('resolves a factory (function) default export', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: "export default () => ({ requiredFiles: ['a.txt'] })" })

    const rules = await loadPackageConfig(dir)

    expect(rules.requiredFiles).toEqual(['a.txt'])
  })

  it('rejects an invalid config shape with a descriptive error', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: "export default { requiredScripts: 'build' }" })

    await expect(loadPackageConfig(dir)).rejects.toThrow(/Invalid/)
  })

  it('rejects an unknown key (typo protection)', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: 'export default { requiredScript: [] }' })

    await expect(loadPackageConfig(dir)).rejects.toThrow(/Invalid/)
  })
})

describe('validatePackage', () => {
  it('passes when config, required scripts, and required files are all satisfied', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: '@x/ok', type: 'module', scripts: { build: 'x' } },
      config: "export default { requiredScripts: ['build'], requiredFiles: ['tsconfig.json'] }",
      files: { 'tsconfig.json': '{}' },
    })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(true)
    expect(result.packageName).toBe('@x/ok')
  })

  it('applies the under-the-hood defaults when the config is empty', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: {
        name: '@x/std',
        type: 'module',
        scripts: { build: 'x', 'ts-check': 'x', 'eslint-check': 'x', 'prettier-check': 'x', test: 'x' },
      },
      config: 'export default {}',
      files: { 'tsconfig.json': '{}', 'eslint.config.js': '', 'readme.md': '' },
    })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(true)
  })

  it('fails when a required script is missing', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: '@x/no-script', type: 'module', scripts: { build: 'x' } },
      config: "export default { requiredScripts: ['build', 'ts-check'], requiredFiles: [] }",
    })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'script:ts-check', status: 'fail' }))
  })

  it('fails when a required file is missing', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: '@x/no-file', type: 'module', scripts: {} },
      config: "export default { requiredScripts: [], requiredFiles: ['tsconfig.json'] }",
    })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'file:tsconfig.json', status: 'fail' }))
  })

  it('skips the rule-based checks when infra-kit.config.ts is missing, keeping config and guidance', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { packageJson: { name: '@x/no-config', type: 'module' } })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(false)
    // The rules are unknown, so scripts/files/turbo are skipped — but `agent-guidance` reads
    // CLAUDE.md rather than the rules, so it sits outside that branch and still reports.
    expect(
      result.checks.map((check) => {
        return check.name
      }),
    ).toEqual(['infra-kit.config.ts', 'agent-guidance'])
    expect(result.checks[0]).toMatchObject({ name: 'infra-kit.config.ts', status: 'fail' })
  })
})

describe('validatePackage — agent-guidance wiring', () => {
  const WELL_FORMED_BLOCK = [
    '<!-- infra-kit:package:begin -->',
    '<!-- infra-kit:package:version 0.4.0 lib -->',
    '# @x/pkg',
    '<!-- infra-kit:package:end -->',
  ].join('\n')

  it('treats an absent adoption option as not adopted, so a missing CLAUDE.md still passes', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: 'export default { requiredScripts: [], requiredFiles: [] }' })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'agent-guidance',
        status: 'pass',
        message: 'not yet adopted — CLAUDE.md missing — run: infra-kit audit --fix',
      }),
    )
  })

  it('fails a missing CLAUDE.md once the adoption state says the workspace adopted', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { config: 'export default { requiredScripts: [], requiredFiles: [] }' })

    const result = await validatePackage(dir, DEFAULT_RULES, {
      adoption: { adopted: true, workspaceRoot: dir, evidencePath: path.join(dir, 'packages/lib-a/CLAUDE.md') },
    })

    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'agent-guidance', status: 'fail' }))
  })

  it('emits no agent-guidance check for the root, even in an adopted workspace', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: 'monorepo', type: 'module' },
      config: 'export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: [] } }',
      // The ROOT block, which the package-scoped check would classify as `foreign-block`.
      files: { 'CLAUDE.md': '<!-- infra-kit:begin -->\nroot guidance\n<!-- infra-kit:end -->' },
    })

    const result = await validatePackage(dir, ROOT_DEFAULT_RULES, {
      adoption: { adopted: true, workspaceRoot: dir, evidencePath: path.join(dir, 'packages/lib-a/CLAUDE.md') },
      isRoot: true,
    })

    expect(
      result.checks.map((check) => {
        return check.name
      }),
    ).not.toContain('agent-guidance')
    expect(result.passed).toBe(true)
  })

  it('passes a package carrying a well-formed block after adoption', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      config: 'export default { requiredScripts: [], requiredFiles: [] }',
      files: { 'CLAUDE.md': WELL_FORMED_BLOCK },
    })

    const result = await validatePackage(dir, DEFAULT_RULES, {
      adoption: { adopted: true, workspaceRoot: dir, evidencePath: path.join(dir, 'CLAUDE.md') },
    })

    expect(result.passed).toBe(true)
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'agent-guidance',
        status: 'pass',
        message: 'present (block from infra-kit 0.4.0, type lib)',
      }),
    )
  })
})

describe('validatePackage — e2e convention', () => {
  const E2E_CONFIG = `
const SLOW_MO = Number(process.env.E2E_SLOW_MO ?? 0)
export default defineConfig({
  timeout: 30_000 + SLOW_MO * 100,
  use: { launchOptions: { slowMo: SLOW_MO }, trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure' },
})
`

  const e2eNames = (checks: { name: string }[]): string[] => {
    return checks
      .map((check) => {
        return check.name
      })
      .filter((name) => {
        return name.startsWith('e2e-')
      })
  }

  it('adds the e2e checks to a package under apps/<app>/tests, even with requiredScripts emptied', async () => {
    const root = makeTmpDir()
    const dir = path.join(root, 'apps/client/tests')

    fs.mkdirSync(dir, { recursive: true })
    writePackage(dir, {
      packageJson: { name: 'e2e-client', type: 'module', scripts: { ...E2E_SCRIPTS } },
      config: 'export default { requiredScripts: [], requiredFiles: [] }',
      files: { 'playwright.config.ts': E2E_CONFIG },
    })

    const result = await validatePackage(dir, undefined, { repoRoot: root })

    expect(result.passed).toBe(true)
    expect(e2eNames(result.checks)).toHaveLength(Object.keys(E2E_SCRIPTS).length + 4)
  })

  it('fails the package when a shared script drifts or the config lacks slow motion', async () => {
    const root = makeTmpDir()
    const dir = path.join(root, 'apps/client/tests')

    fs.mkdirSync(dir, { recursive: true })
    writePackage(dir, {
      packageJson: {
        name: 'e2e-client',
        type: 'module',
        scripts: { ...E2E_SCRIPTS, 'e2e-test-ui-demo': 'pnpm exec playwright test --ui --headed' },
      },
      config: 'export default { requiredScripts: [], requiredFiles: [] }',
      files: { 'playwright.config.ts': "export default defineConfig({ use: { trace: 'on-first-retry' } })" },
    })

    const result = await validatePackage(dir, undefined, { repoRoot: root })
    const failed = result.checks.filter((check) => {
      return check.status === 'fail'
    })

    expect(result.passed).toBe(false)
    expect(
      failed.map((check) => {
        return check.name
      }),
    ).toEqual([
      'e2e-script:e2e-test-ui-demo',
      'e2e-config:slow-mo',
      'e2e-config:launch-options',
      'e2e-config:timeout-headroom',
      'e2e-config:trace',
    ])
  })

  it('reaches an e2e package through its declared type when the path says nothing', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: '@x/suite', type: 'module', scripts: { ...E2E_SCRIPTS } },
      config: "export default { type: 'e2e', requiredScripts: [], requiredFiles: [] }",
      files: { 'playwright.config.ts': E2E_CONFIG },
    })

    const result = await validatePackage(dir)

    expect(e2eNames(result.checks)).not.toHaveLength(0)
    expect(result.passed).toBe(true)
  })

  it('leaves a lib package alone', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: '@x/lib', type: 'module' },
      config: 'export default { requiredScripts: [], requiredFiles: [] }',
    })

    const result = await validatePackage(dir)

    expect(e2eNames(result.checks)).toEqual([])
  })
})

describe('validatePackage — root / turbo', () => {
  it('passes the root baseline when scripts, files, and turbo tasks are present', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: {
        name: 'monorepo',
        type: 'module',
        scripts: { build: 'x', dev: 'x', test: 'x', qa: 'x', 'infra-kit-check': 'x', fix: 'x' },
      },
      config: 'export default {}',
      files: {
        'pnpm-workspace.yaml': 'packages: []\n',
        'turbo.json': JSON.stringify({
          tasks: {
            build: {},
            test: {},
            'ts-check': {},
            'eslint-check': {},
            'prettier-check': {},
            'infra-kit-check': {},
          },
        }),
      },
    })

    const result = await validatePackage(dir, ROOT_DEFAULT_RULES)

    expect(result.passed).toBe(true)
  })

  it('fails when a required turbo task is missing from turbo.json', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: 'monorepo', type: 'module' },
      config: "export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: ['build', 'lint'] } }",
      files: { 'turbo.json': JSON.stringify({ tasks: { build: {} } }) },
    })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'turbo:lint', status: 'fail' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'turbo:build', status: 'pass' }))
  })

  it('accepts a root task keyed as //#name in turbo.json', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: { name: 'monorepo', type: 'module' },
      config: "export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: ['check-root'] } }",
      files: { 'turbo.json': JSON.stringify({ tasks: { '//#check-root': {} } }) },
    })

    const result = await validatePackage(dir)

    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'turbo:check-root', status: 'pass' }))
  })
})

describe('discoverPackages', () => {
  it('expands non-vendor globs and excludes vendor and negations', async () => {
    const root = makeTmpDir()

    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - apps/*/*\n  - packages/*\n  - vendor/packages/*\n  - "!**/test/**"\n',
    )

    const dirs = ['apps/infra-kit/cli', 'packages/p1', 'vendor/packages/v1']

    for (const dir of dirs) {
      const full = path.join(root, dir)

      fs.mkdirSync(full, { recursive: true })
      fs.writeFileSync(path.join(full, 'package.json'), '{}')
    }

    const found = await discoverPackages(root)

    expect(found).toContain(path.join(root, 'apps/infra-kit/cli'))
    expect(found).toContain(path.join(root, 'packages/p1'))
    expect(found).not.toContain(path.join(root, 'vendor/packages/v1'))
  })

  it('omits directories that lack a package.json', async () => {
    const root = makeTmpDir()

    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')

    fs.mkdirSync(path.join(root, 'packages/empty'), { recursive: true })

    const found = await discoverPackages(root)

    expect(found).not.toContain(path.join(root, 'packages/empty'))
  })
})
