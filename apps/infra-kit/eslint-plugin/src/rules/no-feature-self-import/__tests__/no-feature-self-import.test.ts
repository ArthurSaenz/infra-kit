import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { noFeatureSelfImport } from '../no-feature-self-import'

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

const component = '/virtual/app/src/features/coupons/components/dialog-component.tsx'

ruleTester.run('no-feature-self-import', noFeatureSelfImport, {
  valid: [
    { code: "import { couponsService } from '../services'", filename: component },
    { code: "import { userService } from '#root/features/user'", filename: component },
    {
      code: "import { couponsService } from '#root/features/coupons'",
      filename: '/virtual/app/src/pages/coupons/page.tsx',
    },
    {
      code: "import { couponsService } from '#root/features/coupons'",
      filename: '/virtual/app/src/features/coupons/__tests__/coupons.test.ts',
    },
    {
      code: "import { CouponsContainer } from '..'",
      filename: '/virtual/app/src/features/coupons/__stories__/coupons.stories.tsx',
    },
    { code: "import { x } from '#root/features/coupons/services'", filename: component },
    {
      code: "import { x } from '#root/features/coupons'",
      filename: component,
      options: [{ ignore: ['**/components/**'] }],
    },
  ],
  invalid: [
    {
      code: "import type { CouponRow } from '#root/features/coupons'",
      filename: component,
      errors: [
        {
          message:
            '`#root/features/coupons` reads types of feature `coupons` through its own public API from inside it. Import them from the module that defines them with a relative path; the public API is for code outside the feature.',
        },
      ],
    },
    {
      code: "import { couponsService } from '#root/features/coupons'",
      filename: component,
      errors: [
        {
          message:
            '`#root/features/coupons` imports feature `coupons` through its own public API from inside it, which makes an import cycle via `index.ts`. Import the module that defines it with a relative path instead.',
        },
      ],
    },
    {
      code: "import { couponsService } from '..'",
      filename: component,
      errors: [{ messageId: 'selfImport', data: { specifier: '..', feature: 'coupons' } }],
    },
    {
      code: "import { couponsService } from '../index'",
      filename: component,
      errors: [{ messageId: 'selfImport' }],
    },
    {
      code: "import { x } from '~/features/coupons'",
      filename: component,
      options: [{ rootAlias: '~' }],
      errors: [{ messageId: 'selfImport' }],
    },
  ],
})
