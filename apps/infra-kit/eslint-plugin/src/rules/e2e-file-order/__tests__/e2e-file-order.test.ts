import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { e2eFileOrder } from '../e2e-file-order'

// The rule is gated on the package type, which is read from disk.
describe('e2e-file-order', () => {
  let root: string
  let linter: Linter

  const config: Linter.Config = {
    files: ['**/*.ts'],
    plugins: { '@wl': { rules: { 'e2e-file-order': e2eFileOrder } } },
    languageOptions: { parser: tsParser },
    rules: { '@wl/e2e-file-order': 'error' },
  }

  const fileIn = (file: string, packageDir = 'apps/shop/tests'): string => {
    return path.join(root, packageDir, 'src/tests/checkout', file)
  }

  const lint = (source: string, file: string, packageDir?: string): Linter.LintMessage[] => {
    return linter.verify(source, config, { filename: fileIn(file, packageDir) })
  }

  const fix = (source: string, file: string): string => {
    return linter.verifyAndFix(source, config, { filename: fileIn(file) }).output
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-file-order-'))
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

  describe('page objects', () => {
    it('accepts imports → class → constants', () => {
      const source = dedent`
        import type { Page } from '@playwright/test'

        export class CartPage {
          constructor(private readonly page: Page) {}
          open() { return this.page.goto(CART_URL) }
        }

        const CART_URL = '/cart'
      `

      expect(lint(source, 'pages/cart.page.ts')).toEqual([])
    })

    it('names the constant and the class it must follow', () => {
      const source = dedent`
        import type { Page } from '@playwright/test'

        const CART_URL = '/cart'

        export class CartPage {
          constructor(private readonly page: Page) {}
          open() { return this.page.goto(CART_URL) }
        }
      `

      expect(
        lint(source, 'pages/cart.page.ts').map((message) => {
          return message.message
        }),
      ).toEqual([
        '`CART_URL` sits between the imports and class `CartPage`. Move it below class `CartPage`: a page object file opens with its imports, then the class. The autofix moves it to the end of the file.',
      ])
    })

    it('moves every stray to the end of the file, in order, with its comments', () => {
      const source = dedent`
        import type { Page } from '@playwright/test'

        /** Seeded by the cart mock. */
        const CART_URL = '/cart' // trailing why

        export type Tab = 'items' | 'summary'

        export class CartComponent {
          constructor(private readonly page: Page) {}
          open(tab: Tab) { return this.page.goto(\`\${CART_URL}#\${tab}\`) }
        }
      `

      expect(fix(source, 'pages/cart.component.ts').trimEnd()).toBe(dedent`
        import type { Page } from '@playwright/test'

        export class CartComponent {
          constructor(private readonly page: Page) {}
          open(tab: Tab) { return this.page.goto(\`\${CART_URL}#\${tab}\`) }
        }

        /** Seeded by the cart mock. */
        const CART_URL = '/cart' // trailing why

        export type Tab = 'items' | 'summary'
      `)
    })

    it('keeps a constant a static field reads while the class is defined', () => {
      const source = dedent`
        const ROUTE = '/cart'

        export class CartPage {
          static readonly route = ROUTE
          readonly heading = HEADING
        }

        const HEADING = 'Cart'
      `

      expect(lint(source, 'pages/cart.page.ts')).toEqual([])
    })
  })

  describe('fixtures', () => {
    it('accepts imports → fixtures type → extend → re-export', () => {
      const source = dedent`
        import { test as base } from '#root/fixtures/base.fixture'

        interface CartFixtures {
          cartPage: CartPage
        }

        export const test = base.extend<CartFixtures>({
          cartPage: async ({ page }, use) => { await use(new CartPage(page, KEY)) },
        })

        export { expect } from '#root/fixtures/base.fixture'

        const KEY = 'cart'
      `

      expect(lint(source, 'fixtures/cart.fixture.ts')).toEqual([])
    })

    it('reports a constant above the extend call but not the fixtures type', () => {
      const source = dedent`
        import { test as base } from '#root/fixtures/base.fixture'

        const KEY = 'cart'

        interface CartFixtures {
          cartPage: CartPage
        }

        export const test = base.extend<CartFixtures>({
          cartPage: async ({ page }, use) => { await use(new CartPage(page, KEY)) },
        })
      `

      expect(
        lint(source, 'fixtures/cart.fixture.ts').map((message) => {
          return message.message
        }),
      ).toEqual([
        '`KEY` sits between the imports and fixture `test`. Move it below fixture `test`: a fixture file opens with its imports, then the fixtures type and the `extend` call. The autofix moves it to the end of the file.',
      ])
    })

    it('keeps an option default the extend call reads eagerly', () => {
      const source = dedent`
        import { test as base } from '#root/fixtures/base.fixture'

        const DEFAULT_LOCALE = 'he'

        export const test = base.extend<{ locale: string }>({
          locale: [DEFAULT_LOCALE, { option: true }],
        })
      `

      expect(lint(source, 'fixtures/cart.fixture.ts')).toEqual([])
    })
  })

  describe('specs', () => {
    it('accepts imports → describe → constants read inside tests', () => {
      const source = dedent`
        import { expect, test } from '../fixtures/cart.fixture'

        test.describe('Cart', () => {
          test('shows the total', async ({ cartPage }) => {
            await expect(cartPage.total).toHaveText(TOTAL)
          })
        })

        const TOTAL = '₪100'
      `

      expect(lint(source, 'cart.spec.ts')).toEqual([])
    })

    it('reports a constant only a test body reads', () => {
      const source = dedent`
        import { expect, test } from '../fixtures/cart.fixture'

        const TOTAL = '₪100'

        test.describe('Cart', () => {
          test.beforeEach(async ({ cartPage }) => { await cartPage.open(TOTAL) })
        })
      `

      expect(lint(source, 'cart.spec.ts')).toHaveLength(1)
    })

    it.each([
      ['a describe title', 'test.describe(TITLE, () => {})'],
      ['test.use', 'test.use({ locale: TITLE })'],
      ['a loop inside describe', "test.describe('Cart', () => { for (const x of [TITLE]) test(x, async () => {}) })"],
      ['a forEach callback', '[TITLE].forEach((x) => { test(x, async () => {}) })'],
    ])('keeps a constant read by %s while the module loads', (_, usage) => {
      expect(
        lint(`import { test } from '@playwright/test'\n\nconst TITLE = 'Cart'\n\n${usage}\n`, 'cart.spec.ts'),
      ).toEqual([])
    })

    it('keeps what a kept helper closes over', () => {
      const source = dedent`
        import { test } from '@playwright/test'

        const BASE = 'Cart'
        const title = (suffix: string) => \`\${BASE} \${suffix}\`

        test.describe(title('totals'), () => {})
      `

      expect(lint(source, 'cart.spec.ts')).toEqual([])
    })
  })

  describe('mocks', () => {
    it('reports payload constants above the exported mock function and moves them below it', () => {
      const source = dedent`
        import type { Page } from '@playwright/test'

        export const CART = { total: 100 }

        export const mockCart = async (page: Page) => {
          await page.route('**/cart', (route) => route.fulfill({ json: CART }))
        }
      `

      expect(
        lint(source, 'mocks/cart.mock.ts').map((message) => {
          return message.message
        }),
      ).toEqual([
        '`CART` sits between the imports and mock `mockCart`. Move it below mock `mockCart`: a mock file opens with its imports, then the exported mock function. The autofix moves it to the end of the file.',
      ])
      expect(fix(source, 'mocks/cart.mock.ts').trimEnd()).toBe(dedent`
        import type { Page } from '@playwright/test'

        export const mockCart = async (page: Page) => {
          await page.route('**/cart', (route) => route.fulfill({ json: CART }))
        }

        export const CART = { total: 100 }
      `)
    })
  })

  describe('lib files', () => {
    it('reports a private helper above an export, counting `export { … }` lists as exports', () => {
      const source = dedent`
        const pad = (value: number) => String(value).padStart(2, '0')

        const toKey = (date: Date) => \`\${date.getFullYear()}-\${pad(date.getMonth() + 1)}\`

        export { toKey }
      `

      expect(
        lint(source, 'lib/month-keys.ts').map((message) => {
          return message.message
        }),
      ).toEqual([
        '`pad` sits between the imports and the exports. Move it below the exports: a lib file opens with its imports, then its exports. The autofix moves it to the end of the file.',
      ])
    })

    it('keeps a helper an export calls while the module loads', () => {
      const source = dedent`
        const build = (name: string) => ({ name })

        export const DEFAULT_USER = build('guest')
      `

      expect(lint(source, 'lib/users.ts')).toEqual([])
    })

    it('leaves a detached overview comment in place', () => {
      const source = dedent`
        /** Month keys, as the datepicker renders them. */

        const pad = (value: number) => String(value).padStart(2, '0')

        export const toKey = (month: number) => pad(month)
      `

      expect(fix(source, 'lib/month-keys.ts').trimEnd()).toBe(dedent`
        /** Month keys, as the datepicker renders them. */

        export const toKey = (month: number) => pad(month)

        const pad = (value: number) => String(value).padStart(2, '0')
      `)
    })
  })

  it('skips files without an anchor, other suffixes and other package types', () => {
    const constantFirst = 'const A = 1\n\nexport class CartPage { a = A }\n'

    expect(lint('const A = 1\n\nexport const b = A\n', 'pages/cart.page.ts')).toEqual([])
    expect(lint(constantFirst, 'data/cart.data.ts')).toEqual([])
    expect(lint(constantFirst, 'pages/cart.page.ts', 'apps/shop/ui')).toEqual([])
  })
})
