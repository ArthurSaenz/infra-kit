import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { e2eTestTitle } from '../e2e-test-title'

// The rule is gated on the package type, which is read from disk.
describe('e2e-test-title', () => {
  let root: string
  let linter: Linter

  const lint = (source: string, packageDir = 'apps/shop/tests'): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'e2e-test-title': e2eTestTitle } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/e2e-test-title': 'warn' },
    }

    return linter.verify(source, config, {
      filename: path.join(root, packageDir, 'src/tests/checkout/apply-coupon.spec.ts'),
    })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-test-title-'))
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
    "test('applies a valid coupon and updates the total', async () => {})",
    "test.describe('Should-list', () => {})",
    "test.step('should never be judged', async () => {})",
    'test(`rejects an expired card`, async () => {})',
    'test(title, async () => {})',
  ])('accepts %s', (source) => {
    expect(lint(source)).toEqual([])
  })

  it('suggests the title without `should`', () => {
    expect(lint("test('should reject an expired card', async () => {})")[0]?.message).toBe(
      'Test title "should reject an expired card" starts with `should`. State the behaviour and its observable outcome directly: "reject an expired card".',
    )
  })

  it('checks modified and template-literal titles', () => {
    expect(lint('test.fixme(`Should show the total`, async () => {})')).toHaveLength(1)
  })

  it('skips packages of another type', () => {
    expect(lint("test('should render', async () => {})", 'apps/shop/ui')).toEqual([])
  })
})
