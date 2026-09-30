import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { createE2eWorkspace } from '../../../test-utils/e2e-workspace'
import type { E2eWorkspace } from '../../../test-utils/e2e-workspace'
import { e2ePageObjectMemberOrder } from '../e2e-page-object-member-order'

describe('e2e-page-object-member-order', () => {
  let workspace: E2eWorkspace
  let linter: Linter

  const config: Linter.Config = {
    files: ['**/*.ts'],
    plugins: { '@wl': { rules: { 'e2e-page-object-member-order': e2ePageObjectMemberOrder } } },
    languageOptions: { parser: tsParser },
    rules: { '@wl/e2e-page-object-member-order': 'error' },
  }

  const lint = (source: string, file = 'pages/cart.page.ts', packageDir?: string): string[] => {
    return linter.verify(source, config, { filename: workspace.fileIn(file, packageDir) }).map((message) => {
      return message.message
    })
  }

  beforeAll(() => {
    workspace = createE2eWorkspace('e2e-page-object-member-order-')
    linter = new Linter({ cwd: workspace.root })
  })

  afterAll(() => {
    workspace.dispose()
  })

  it('accepts fields → constructor → getters → public methods → private methods', () => {
    const source = dedent`
      export class CartPage {
        readonly total: Locator
        private readonly load = () => {}
        constructor(readonly page: Page) {}
        get isEmpty() { return true }
        open() {}
        private waitForCart() {}
      }
    `

    expect(lint(source)).toEqual([])
  })

  it('names the member and the one it must precede', () => {
    const source = dedent`
      export class CartPage {
        constructor(readonly page: Page) {}
        private waitForCart() {}
        open() {}
      }
    `

    expect(lint(source)).toEqual([
      'The public method `open` comes after the private method `waitForCart` in class `CartPage`. Order a page object: fields, constructor, getters, public methods, private methods.',
    ])
  })

  it('reorders the class body in one pass, keeping each member’s comments', () => {
    const source = dedent`
      export class CartComponent {
        open() {}

        /** Settles once the cart API answers. */
        private waitForCart() {}

        get total() { return 1 }

        readonly heading = 'Cart'

        constructor(readonly page: Page) {}
      }
    `

    expect(linter.verifyAndFix(source, config, { filename: workspace.fileIn('pages/cart.component.ts') }).output).toBe(
      dedent`
        export class CartComponent {
          readonly heading = 'Cart'

          constructor(readonly page: Page) {}

          get total() { return 1 }

          open() {}

          /** Settles once the cart API answers. */
          private waitForCart() {}
        }
      `,
    )
  })

  it('skips other files and other package types', () => {
    const source = 'export class CartPage { open() {}\n readonly a = 1 }\n'

    expect(lint(source, 'lib/cart.ts')).toEqual([])
    expect(lint(source, 'pages/cart.page.ts', 'apps/shop/ui')).toEqual([])
  })
})
