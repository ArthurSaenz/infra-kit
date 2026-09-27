import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { e2eTestTags } from '../e2e-test-tags'

// The rule is gated on the package type, which is read from disk.
describe('e2e-test-tags', () => {
  let root: string
  let linter: Linter

  const lint = (source: string, packageDir = 'apps/shop/tests', options: unknown[] = []): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'e2e-test-tags': e2eTestTags } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/e2e-test-tags': ['error', ...options] as Linter.RuleEntry },
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
    root = mkdtempSync(path.join(tmpdir(), 'e2e-test-tags-'))
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
    "test.describe('Checkout', { tag: '@mocked' }, () => {})",
    "test.describe.serial('Checkout', { tag: ['@smoke', '@readonly'] }, () => {})",
    "test('applies a coupon', { tag: ['@slow'] }, async () => {})",
    "test.skip('applies a coupon', { annotation: { type: 'issue' } }, async () => {})",
    "test('applies a coupon', async () => {})",
    "test('applies a coupon', { tag: SHARED_TAGS }, async () => {})",
    "test.step('Pay', { tag: '@whatever' }, async () => {})",
  ])('accepts %s', (source) => {
    expect(lint(source)).toEqual([])
  })

  it('names the unknown tag and the allowed ones', () => {
    expect(lint("test.describe('Checkout', { tag: '@mocking' }, () => {})")[0]?.message).toBe(
      'Tag `@mocking` is not an allowed e2e tag. Use one of `@smoke`, `@readonly`, `@mocked`, `@slow`; browsers, devices and environments are Playwright projects, not tags.',
    )
  })

  it('reports each unknown tag in an array', () => {
    const messages = lint("test.only('pays', { tag: ['@smoke', '@chromium', '@flaky'] }, async () => {})")

    expect(
      messages.map((message) => {
        return message.message.split(' ')[1]
      }),
    ).toEqual(['`@chromium`', '`@flaky`'])
  })

  it('honours a custom `allowed` list', () => {
    expect(
      lint("test('pays', { tag: '@mobile' }, async () => {})", 'apps/shop/tests', [{ allowed: ['@mobile'] }]),
    ).toEqual([])
  })

  it('skips packages of another type', () => {
    expect(lint("test('pays', { tag: '@anything' }, async () => {})", 'apps/shop/ui')).toEqual([])
  })
})
