import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { createE2eWorkspace } from '../../../test-utils/e2e-workspace'
import type { E2eWorkspace } from '../../../test-utils/e2e-workspace'
import { e2eDescribeOrder } from '../e2e-describe-order'

describe('e2e-describe-order', () => {
  let workspace: E2eWorkspace
  let linter: Linter

  const lint = (source: string, packageDir?: string): string[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'e2e-describe-order': e2eDescribeOrder } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/e2e-describe-order': 'error' },
    }

    return linter.verify(source, config, { filename: workspace.fileIn('cart.spec.ts', packageDir) }).map((message) => {
      return message.message
    })
  }

  beforeAll(() => {
    workspace = createE2eWorkspace('e2e-describe-order-')
    linter = new Linter({ cwd: workspace.root })
  })

  afterAll(() => {
    workspace.dispose()
  })

  it('accepts setup, annotations, ordered hooks, then tests', () => {
    const source = dedent`
      test.describe('Cart', { tag: '@mocked' }, () => {
        test.describe.configure({ mode: 'serial' })
        test.skip(({ browserName }) => browserName === 'webkit', 'No clock on webkit')
        test.use({ locale: 'he' })
        const SEED = 1
        test.beforeAll(async () => {})
        test.beforeEach(async () => {})
        test.afterEach(async () => {})
        test.afterAll(async () => {})
        test('shows the total', async () => {})
        test.skip('shows the discount', async () => {})
        test.describe('Empty cart', () => {
          test.use({ locale: 'en' })
          test('shows the empty state', async () => {})
        })
      })
    `

    expect(lint(source)).toEqual([])
  })

  it('reports setup and hooks that follow a test, in nested describes too', () => {
    const source = dedent`
      test.describe('Cart', () => {
        test('shows the total', async () => {})
        test.use({ locale: 'he' })
        test.describe('Empty cart', () => {
          test.afterEach(async () => {})
          test.beforeEach(async () => {})
        })
      })
    `

    expect(lint(source)).toEqual([
      "`test.use` (setup) comes after `test('shows the total')` (test) in describe 'Cart'. Order a describe body: `test.use` / `test.describe.configure` / annotations, then hooks beforeAll → beforeEach → afterEach → afterAll, then tests and nested describes.",
      "`test.beforeEach` (beforeEach hook) comes after `test.afterEach` (afterEach hook) in describe 'Empty cart'. Order a describe body: `test.use` / `test.describe.configure` / annotations, then hooks beforeAll → beforeEach → afterEach → afterAll, then tests and nested describes.",
    ])
  })

  it('skips other package types', () => {
    expect(
      lint("test.describe('Cart', () => {\n  test('a', async () => {})\n  test.use({})\n})\n", 'apps/shop/ui'),
    ).toEqual([])
  })
})
