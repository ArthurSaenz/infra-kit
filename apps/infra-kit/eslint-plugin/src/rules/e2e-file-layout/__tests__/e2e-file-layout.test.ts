import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { e2eFileLayout } from '../e2e-file-layout'

const code = 'export const a = 1\n'

// The rule reads the package type from `infra-kit.config.ts`, so every case needs a real package.
describe('e2e-file-layout', () => {
  let root: string
  let linter: Linter

  const lint = (packageDir: string, relPath: string, options: unknown[] = []): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'e2e-file-layout': e2eFileLayout } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/e2e-file-layout': ['error', ...options] as Linter.RuleEntry },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, relPath) })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-file-layout-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage('apps/shop/tests', 'e2e')
    makePackage('apps/shop/ui', 'frontend')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it.each([
    'src/tests/checkout/apply-coupon.spec.ts',
    'src/tests/orders/orders.api.spec.ts',
    'src/tests/checkout/pages/checkout.page.ts',
    'src/tests/checkout/fixtures/checkout.fixture.ts',
    'src/tests/checkout/lib/supplier-handoff.ts',
    'src/visual/checkout/checkout.visual.spec.ts',
    'src/setup/auth.setup.ts',
    'src/pages/flights.page.ts',
    'src/constants.ts',
    'playwright.config.ts',
  ])('accepts %s', (relPath) => {
    expect(lint('apps/shop/tests', relPath)).toEqual([])
  })

  it('asks for `.spec` instead of `.test`', () => {
    expect(lint('apps/shop/tests', 'src/tests/routing/edge-redirects.test.ts')[0]?.message).toBe(
      '`edge-redirects.test.ts` uses `.test`. Rename it to `edge-redirects.spec.ts` — every Playwright spec in an e2e package is `*.spec.ts`.',
    )
  })

  it('rejects a spec nested below its domain', () => {
    expect(lint('apps/shop/tests', 'src/tests/ui/auth/login.spec.ts')[0]?.message).toBe(
      '`src/tests/ui/auth/login.spec.ts` nests a spec below its domain folder. Move it to `src/tests/ui/login.spec.ts`, or split the domain into two sibling domains if it holds too many specs.',
    )
  })

  it.each(['src/tests/login.spec.ts', 'src/login.spec.ts', 'src/lib/login.spec.ts'])(
    'rejects a spec outside a domain folder: %s',
    (relPath) => {
      expect(lint('apps/shop/tests', relPath)[0]?.messageId).toBe('specOutsideDomain')
    },
  )

  it.each([
    ['checkout.page.ts', 'pages'],
    ['coupon.component.ts', 'pages'],
    ['checkout.fixture.ts', 'fixtures'],
    ['checkout.mock.ts', 'mocks'],
    ['checkout.data.ts', 'data'],
    ['supplier-handoff.ts', 'lib'],
  ])('moves %s from the domain root into %s/', (basename, subfolder) => {
    expect(lint('apps/shop/tests', `src/tests/checkout/${basename}`)[0]?.message).toBe(
      `\`${basename}\` sits in the root of domain \`checkout\`, which holds only \`*.spec.ts\`. Move it to \`src/tests/checkout/${subfolder}/${basename}\`.`,
    )
  })

  it('skips packages of another type', () => {
    expect(lint('apps/shop/ui', 'src/tests/checkout/checkout.page.ts')).toEqual([])
  })

  it('skips files matching `ignore`', () => {
    expect(lint('apps/shop/tests', 'src/tests/_dev/probe.test.ts', [{ ignore: ['**/_dev/**'] }])).toEqual([])
  })
})
