import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { featurePublicApi } from '../feature-public-api'

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

const container = '/virtual/app/src/features/flights/containers/list-container.tsx'

ruleTester.run('feature-public-api', featurePublicApi, {
  valid: [
    { code: "import { userService } from '#root/features/user'", filename: container },
    { code: "import { userService } from '#root/features/user/index'", filename: container },
    { code: "import { userService } from '#root/features/user/index.ts'", filename: container },
    { code: "import { userService } from '../../user'", filename: container },
    { code: "import { ListComponent } from '../components/list-component'", filename: container },
    { code: "import { x } from '#root/features/flights/services'", filename: container },
    { code: "import { cn } from '#root/lib/utils'", filename: container },
    { code: "import { x } from '@pkg/ui-kit/src/x'", filename: container },
    {
      code: "import { x } from '#root/features/user/services'",
      filename: '/virtual/app/src/features/x.ts',
      options: [{ ignore: ['**/features/x.ts'] }],
    },
  ],
  invalid: [
    {
      code: "import { Picker } from '../../flights-result/components/picker-component'",
      filename: container,
      errors: [
        {
          message:
            '`../../flights-result/components/picker-component` reaches into the internals of feature `flights-result`. Import from its public API `#root/features/flights-result` instead, exporting what you need from `features/flights-result/index.ts`.',
        },
      ],
    },
    {
      code: "type Confirm = typeof import('#root/features/confirm-popup/services')",
      filename: container,
      errors: [
        {
          messageId: 'deepImport',
          data: {
            specifier: '#root/features/confirm-popup/services',
            feature: 'confirm-popup',
            publicApi: '#root/features/confirm-popup',
          },
        },
      ],
    },
    {
      code: "import type { User } from '#root/features/user/types'",
      filename: container,
      errors: [{ messageId: 'deepImport' }],
    },
    {
      code: "import { Icons } from '#root/features/layouts/components/icons-component'",
      filename: '/virtual/app/src/components/filters-search.tsx',
      errors: [{ messageId: 'deepImport' }],
    },
    {
      code: "import logo from '../../login/assets/logo.svg'",
      filename: container,
      errors: [{ messageId: 'deepImport' }],
    },
    {
      code: "export * from '#root/features/user/services'",
      filename: '/virtual/app/src/pages/user/page.tsx',
      errors: [{ messageId: 'deepImport' }],
    },
    {
      code: "const m = import('#root/features/user/containers/x')",
      filename: '/virtual/app/src/routes/user.tsx',
      errors: [{ messageId: 'deepImport' }],
    },
  ],
})
