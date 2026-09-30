import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { createE2eWorkspace } from '../../../test-utils/e2e-workspace'
import type { E2eWorkspace } from '../../../test-utils/e2e-workspace'
import { e2eTopLevelDescribe } from '../e2e-top-level-describe'

describe('e2e-top-level-describe', () => {
  let workspace: E2eWorkspace
  let linter: Linter

  const configFor = (options: Record<string, unknown> = {}): Linter.Config => {
    return {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'e2e-top-level-describe': e2eTopLevelDescribe } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/e2e-top-level-describe': ['error', options] },
    }
  }

  const lint = (source: string, options?: Record<string, unknown>, packageDir?: string): string[] => {
    return linter
      .verify(source, configFor(options), { filename: workspace.fileIn('cart.spec.ts', packageDir) })
      .map((message) => {
        return message.message
      })
  }

  const fix = (source: string): string => {
    return linter.verifyAndFix(source, configFor(), { filename: workspace.fileIn('cart.spec.ts') }).output
  }

  beforeAll(() => {
    workspace = createE2eWorkspace('e2e-top-level-describe-')
    linter = new Linter({ cwd: workspace.root })
  })

  afterAll(() => {
    workspace.dispose()
  })

  it('accepts a single describe holding everything', () => {
    expect(lint("test.describe('Cart', () => {\n  test.use({})\n  test('a', async () => {})\n})\n")).toEqual([])
  })

  it('reports a second top-level describe, up to the `max` option', () => {
    const source = "test.describe('Cart', () => {})\n\ntest.describe('Cart Mutations', () => {})\n"

    expect(lint(source)).toEqual([
      "`test.describe('Cart Mutations')` is top-level describe number 2 in this spec; the limit is 1. Move it to its own spec file, or nest it inside `test.describe('Cart')`.",
    ])
    expect(lint(source, { max: 2 })).toEqual([])
  })

  it('reports a top-level test without a fix', () => {
    const source = "test('shows the total', async () => {})\n"

    expect(lint(source)).toEqual([
      "Test 'shows the total' sits at the top level of the spec. Wrap the spec’s tests in a `test.describe` named after the feature they cover.",
    ])
    expect(fix(source)).toBe(source)
  })

  it('moves top-level setup and hooks into the single describe, in order, with their comments', () => {
    const source = dedent`
      import { test } from '@playwright/test'

      /** Freeze the zone the dates are rendered in. */
      test.use({ timezoneId: 'Asia/Jerusalem' })

      test.beforeEach(async ({ page }) => {
        await page.clock.install({ time: 0 })
      })

      test.describe('Cart', () => {
        test('shows the total', async () => {})
      })
    `

    expect(fix(source)).toBe(dedent`
      import { test } from '@playwright/test'

      test.describe('Cart', () => {
        /** Freeze the zone the dates are rendered in. */
        test.use({ timezoneId: 'Asia/Jerusalem' })

        test.beforeEach(async ({ page }) => {
          await page.clock.install({ time: 0 })
        })

        test('shows the total', async () => {})
      })
    `)
  })

  it('reports top-level setup without a fix when there are several describes', () => {
    const source = "test.use({})\n\ntest.describe('A', () => {})\n\ntest.describe('B', () => {})\n"

    expect(lint(source, { max: 2 })).toEqual([
      "`test.use` sits at the top level of the spec. Move it inside `test.describe('A')`: a spec holds one top-level describe, and its setup, hooks and tests live inside it.",
    ])
    expect(
      linter.verifyAndFix(source, configFor({ max: 2 }), { filename: workspace.fileIn('cart.spec.ts') }).output,
    ).toBe(source)
  })

  it('skips other package types', () => {
    expect(lint("test('a', async () => {})\n", undefined, 'apps/shop/ui')).toEqual([])
  })
})
