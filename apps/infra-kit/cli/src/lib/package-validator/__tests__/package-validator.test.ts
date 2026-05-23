import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_RULES, ROOT_DEFAULT_RULES } from 'src/lib/package-config'

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

  it('fails with only the config check when infra-kit.config.ts is missing', async () => {
    const dir = makeTmpDir()

    writePackage(dir, { packageJson: { name: '@x/no-config', type: 'module' } })

    const result = await validatePackage(dir)

    expect(result.passed).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]).toMatchObject({ name: 'infra-kit.config.ts', status: 'fail' })
  })
})

describe('validatePackage — root / turbo', () => {
  it('passes the root baseline when scripts, files, and turbo tasks are present', async () => {
    const dir = makeTmpDir()

    writePackage(dir, {
      packageJson: {
        name: 'monorepo',
        type: 'module',
        scripts: { build: 'x', dev: 'x', test: 'x', qa: 'x', validate: 'x', fix: 'x' },
      },
      config: 'export default {}',
      files: {
        'pnpm-workspace.yaml': 'packages: []\n',
        'turbo.json': JSON.stringify({
          tasks: { build: {}, test: {}, 'ts-check': {}, 'eslint-check': {}, 'prettier-check': {}, validate: {} },
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
      config: "export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: ['validate-root'] } }",
      files: { 'turbo.json': JSON.stringify({ tasks: { '//#validate-root': {} } }) },
    })

    const result = await validatePackage(dir)

    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'turbo:validate-root', status: 'pass' }))
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
