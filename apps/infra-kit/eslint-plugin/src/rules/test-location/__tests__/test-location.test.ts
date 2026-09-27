import tsParser from '@typescript-eslint/parser'
import { Linter, RuleTester } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { testLocation } from '../test-location'

// Wire ESLint's RuleTester into vitest's lifecycle so each case becomes a real test.
const ruleTesterHooks = RuleTester as unknown as {
  afterAll: typeof afterAll
  describe: typeof describe
  it: typeof it
  itOnly: typeof it.only
}

ruleTesterHooks.afterAll = afterAll
ruleTesterHooks.describe = describe
ruleTesterHooks.it = it
// eslint-disable-next-line test/no-only-tests -- RuleTester requires an `itOnly` hook reference.
ruleTesterHooks.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
})

const code = 'export const a = 1\n'

// Paths outside any package on disk: no package root is found, so no package type is read.
ruleTester.run('test-location', testLocation, {
  valid: [
    { code, filename: '/virtual/pkg/src/lib/__tests__/slugs.test.ts' },
    { code, filename: '/virtual/pkg/src/features/user/__tests__/deep/user.test.tsx' },
    { code, filename: '/virtual/pkg/src/features/user/__tests__/user-container.test.tsx' },
    { code, filename: '/virtual/features/pkg/src/lib/__tests__/slugs.test.ts' },
    { code, filename: '/virtual/pkg/src/lib/slugs.ts' },
    { code, filename: '/virtual/pkg/src/lib/test-utils.ts' },
    { code, filename: '/virtual/pkg/e2e/flow.e2e.test.ts', options: [{ ignore: ['**/*.e2e.test.*'] }] },
    { code, filename: '<input>' },
  ],
  invalid: [
    {
      code,
      filename: '/virtual/pkg/src/lib/slugs.test.ts',
      errors: [
        {
          message:
            '`slugs.test.ts` sits next to its source. Move it to `src/lib/__tests__/slugs.test.ts` — tests live in a `__tests__/` folder beside the code they test.',
        },
      ],
    },
    {
      code,
      filename: '/virtual/pkg/src/button.spec.tsx',
      errors: [{ messageId: 'outsideTestsDir' }, { messageId: 'specSuffix' }],
    },
    {
      code,
      filename: '/virtual/pkg/src/lib/__tests__/slugs.spec.ts',
      errors: [
        {
          message:
            '`slugs.spec.ts` uses `.spec`. Rename it to `slugs.test.ts` — unit tests are `*.test.*`; `.spec` belongs to Playwright specs in an e2e package.',
        },
      ],
    },
    {
      code,
      filename: '/virtual/pkg/src/features/checkout/services/sorting.test.ts',
      errors: [
        {
          message:
            '`sorting.test.ts` is a feature test outside the feature root. Move it to `src/features/checkout/__tests__/sorting.test.ts` — a feature keeps all its tests in one `__tests__/` at its root.',
        },
      ],
    },
    {
      code,
      filename: '/virtual/pkg/src/features/checkout/services/__tests__/sorting.test.ts',
      errors: [{ messageId: 'outsideFeatureTestsDir' }],
    },
    {
      code,
      filename: '/virtual/pkg/scripts/build.test.mjs',
      errors: [
        {
          message:
            '`build.test.mjs` sits next to its source. Move it to `scripts/__tests__/build.test.mjs` — tests live in a `__tests__/` folder beside the code they test.',
        },
      ],
    },
  ],
})

// The e2e exemption reads the package type from `infra-kit.config.ts`, so it needs a real package.
describe('e2e package exemption', () => {
  let root: string
  let linter: Linter

  const lint = (packageDir: string, relPath: string): number => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'test-location': testLocation } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/test-location': 'error' },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, relPath) }).length
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'test-location-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage('apps/e2e', 'e2e')
    makePackage('apps/ui', 'frontend')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it('skips specs in an e2e package', () => {
    expect(lint('apps/e2e', 'tests/login/login.spec.ts')).toBe(0)
  })

  it('still reports in a package of another type', () => {
    expect(lint('apps/ui', 'src/lib/slugs.test.ts')).toBe(1)
  })
})
