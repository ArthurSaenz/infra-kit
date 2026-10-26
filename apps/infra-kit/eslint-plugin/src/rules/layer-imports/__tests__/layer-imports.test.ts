import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { layerImports } from '../layer-imports'

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

// Virtual paths: no package exists on disk, so the innermost `src/` is the package's source root.
const feature = '/virtual/app/src/features/user/containers/user-container.tsx'

const order =
  'lib, components, shared, assets, styles, data → core, entities → features → pages, routes → app, renderer, mobile'

ruleTester.run('layer-imports', layerImports, {
  valid: [
    { code: "import { cn } from '#root/lib/utils'", filename: feature },
    { code: "import { Button } from '../../../components/button'", filename: feature },
    { code: "import { orderService } from '#root/features/order'", filename: feature },
    { code: "import { userService } from '#root/features/user'", filename: '/virtual/app/src/pages/user/page.tsx' },
    { code: "import { routes } from '#root/routes'", filename: '/virtual/app/src/pages/user/page.tsx' },
    { code: "import { App } from '#root/app/app'", filename: '/virtual/app/src/main.tsx' },
    { code: "import type { Paths } from '#root/pages/paths'", filename: feature },
    { code: "import { type Paths } from '#root/pages/paths'", filename: feature },
    { code: "export type { Paths } from '#root/pages/paths'", filename: feature },
    { code: "type Nav = typeof import('#root/app/navigation')", filename: feature },
    { code: "import React from 'react'", filename: '/virtual/app/src/lib/x.ts' },
    { code: "import { router } from '#travelist/router'", filename: '/virtual/app/src/lib/x.ts' },
    { code: "import data from '../../../../data/cities.json'", filename: '/virtual/app/src/lib/geo/cities.ts' },
    { code: "import { x } from '#root/unlisted/x'", filename: '/virtual/app/src/lib/x.ts' },
    { code: "import { x } from '#root/features/a'", filename: '/virtual/app/src/scripts/x.ts' },
    {
      code: "import { x } from '#root/features/a'",
      filename: '/virtual/app/src/lib/x.ts',
      options: [{ ignore: ['**/lib/**'] }],
    },
    {
      code: "import { x } from '~/features/a'",
      filename: '/virtual/app/src/lib/x.ts',
      options: [{ rootAlias: '#root' }],
    },
    { code: "import { x } from '#root/app/x'", filename: '<input>' },
    {
      code: "import '#root/app/styles/globals.css'",
      filename: '/virtual/app/src/features/form/__tests__/form.test.tsx',
    },
    { code: "import { paths } from '#root/pages/paths'", filename: '/virtual/app/src/lib/paths.test.ts' },
  ],
  invalid: [
    {
      code: "import { navigate } from '#root/app/navigation'",
      filename: feature,
      errors: [
        {
          message: `\`features\` cannot import \`#root/app/navigation\` from the higher layer \`app\`. Layers import only their own level or below: ${order}. Move the shared code down into a lower layer, or pass it in from above.`,
        },
      ],
    },
    {
      code: "import { paths } from '../../../pages/paths'",
      filename: feature,
      errors: [
        {
          messageId: 'upward',
          data: { fromLayer: 'features', toLayer: 'pages', specifier: '../../../pages/paths', order },
        },
      ],
    },
    {
      code: "import { Injected } from '#root/features/platform-injection'",
      filename: '/virtual/app/src/components/default/modal/modal.tsx',
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "import { products } from '#root/entities/products'",
      filename: '/virtual/app/src/components/card.tsx',
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "export { paths } from '#root/pages/paths'",
      filename: feature,
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "export * from '#root/pages/paths'",
      filename: feature,
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "const page = () => import('#root/pages/home')",
      filename: feature,
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "import { type Paths, paths } from '#root/pages/paths'",
      filename: feature,
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "import type { Paths } from '#root/pages/paths'",
      filename: feature,
      options: [{ allowTypeImports: false }],
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "import { x } from '~/features/a'",
      filename: '/virtual/app/src/lib/x.ts',
      options: [{ rootAlias: '~' }],
      errors: [{ messageId: 'upward' }],
    },
    {
      code: "import { x } from '#root/widgets/a'",
      filename: '/virtual/app/src/features/x/index.ts',
      options: [{ layers: [['features'], ['widgets']] }],
      errors: [
        {
          messageId: 'upward',
          data: {
            fromLayer: 'features',
            toLayer: 'widgets',
            specifier: '#root/widgets/a',
            order: 'features → widgets',
          },
        },
      ],
    },
  ],
})
