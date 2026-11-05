import tsParser from '@typescript-eslint/parser'
import { Linter, RuleTester } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { storyTitlePrefix } from '../story-title-prefix'

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

const story = (title: string): string => {
  return `const meta = {\n  title: ${title},\n} satisfies Meta\n\nexport default meta\n`
}

const FEATURE = '/virtual/pkg/src/features/checkout/__stories__/cart-component.stories.tsx'
const SHARED = '/virtual/pkg/src/components/default/button/button.stories.tsx'

// Paths outside any package on disk: no package root is found, so they are judged as frontend.
ruleTester.run('story-title-prefix', storyTitlePrefix, {
  valid: [
    { code: story("'features/checkout/cart-component'"), filename: FEATURE },
    { code: story('`features/checkout/cart/empty`'), filename: FEATURE },
    { code: story("'components/button'"), filename: SHARED },
    { code: story("'lib/motion'"), filename: '/virtual/pkg/src/lib/motion/motion.stories.tsx' },
    { code: story("'pages/flights/placement'"), filename: '/virtual/pkg/src/pages/flights/__stories__/p.stories.tsx' },
    { code: story("'components/icons'"), filename: '/virtual/pkg/src/__stories__/icons.stories.tsx' },
    { code: "export default { title: 'components/button' }\n", filename: SHARED },
    { code: 'const meta: Meta = { title: TITLE }\nexport default meta\n', filename: SHARED },
    { code: 'export default makeMeta()\n', filename: SHARED },
    { code: story("'Anything'"), filename: '/virtual/pkg/src/components/button.tsx' },
    { code: story("'Anything'"), filename: '/virtual/pkg/stories/button.stories.tsx' },
    { code: story("'Anything'"), filename: SHARED, options: [{ ignore: ['**/button/**'] }] },
  ],
  invalid: [
    {
      code: story("'components/templates/footer'"),
      filename: '/virtual/pkg/src/features/layouts/__stories__/footer.stories.tsx',
      errors: [
        {
          message:
            'Story title `components/templates/footer` must start with `features/layouts/` — the first title segment mirrors where the story sits in `src/` (`features/<name>/` for a feature, `components/` for shared components).',
          suggestions: [
            {
              messageId: 'usePrefix',
              data: { title: 'features/layouts/templates/footer' },
              output: story("'features/layouts/templates/footer'"),
            },
          ],
        },
      ],
    },
    {
      code: story('"features/show-suppliers/row"'),
      filename: '/virtual/pkg/src/features/shows-suppliers/__stories__/row.stories.tsx',
      errors: [
        {
          messageId: 'wrongPrefix',
          suggestions: [
            {
              messageId: 'usePrefix',
              data: { title: 'features/shows-suppliers/row' },
              output: story('"features/shows-suppliers/row"'),
            },
          ],
        },
      ],
    },
    {
      code: story("'Features/Checkout/CartComponent'"),
      filename: FEATURE,
      errors: [
        {
          messageId: 'wrongPrefix',
          suggestions: [
            {
              messageId: 'usePrefix',
              data: { title: 'features/checkout/Checkout/CartComponent' },
              output: story("'features/checkout/Checkout/CartComponent'"),
            },
          ],
        },
      ],
    },
    {
      code: story("'backoffice/modal'"),
      filename: SHARED,
      errors: [
        {
          messageId: 'wrongPrefix',
          suggestions: [
            { messageId: 'usePrefix', data: { title: 'components/modal' }, output: story("'components/modal'") },
          ],
        },
      ],
    },
    {
      code: story("'Button'"),
      filename: SHARED,
      errors: [
        {
          messageId: 'wrongPrefix',
          suggestions: [
            { messageId: 'usePrefix', data: { title: 'components/Button' }, output: story("'components/Button'") },
          ],
        },
      ],
    },
    {
      code: story("'components'"),
      filename: SHARED,
      errors: [{ messageId: 'wrongPrefix', suggestions: 1 }],
    },
    {
      code: 'export default { component: Button } satisfies Meta\n',
      filename: SHARED,
      errors: [
        {
          message:
            'Story meta has no `title`. Set one starting with `components/` — the first title segment mirrors where the story sits in `src/`.',
        },
      ],
    },
  ],
})

// The package type is read from `infra-kit.config.ts`, so these cases need real packages on disk.
describe('package types', () => {
  let root: string
  let linter: Linter

  const lint = (packageDir: string, relPath: string, title: string): string[] => {
    const config: Linter.Config = {
      files: ['**/*.tsx'],
      plugins: { '@wl': { rules: { 'story-title-prefix': storyTitlePrefix } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/story-title-prefix': 'error' },
    }

    return linter
      .verify(story(`'${title}'`), config, { filename: path.join(root, packageDir, relPath) })
      .map((message) => {
        return message.messageId ?? message.message
      })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'story-title-prefix-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage('apps/ui', 'frontend')
    makePackage('packages/ui-kit', 'lib')
    makePackage('apps/e2e', 'e2e')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it('takes the src layer as the prefix in a frontend package', () => {
    expect(lint('apps/ui', 'src/mobile/push/modal.stories.tsx', 'mobile/push/modal')).toEqual([])
    expect(lint('apps/ui', 'src/mobile/push/modal.stories.tsx', 'components/modal')).toEqual(['wrongPrefix'])
  })

  it('requires components/ in a lib package outside features/', () => {
    expect(lint('packages/ui-kit', 'src/button/button.stories.tsx', 'components/button')).toEqual([])
    expect(lint('packages/ui-kit', 'src/button/button.stories.tsx', 'button/button')).toEqual(['wrongPrefix'])
    expect(lint('packages/ui-kit', 'src/features/prices/__stories__/c.stories.tsx', 'features/prices/c')).toEqual([])
  })

  it('skips packages of other types', () => {
    expect(lint('apps/e2e', 'src/components/x.stories.tsx', 'Anything')).toEqual([])
  })
})
