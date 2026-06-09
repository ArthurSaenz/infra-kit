import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { componentFileOrder } from '../component-file-order'

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
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
})

// Wrong order shared between the "no component" and the paths-option cases.
const WRONG_ORDER = [
  'interface CompProps {',
  '  a: string',
  '}',
  "import x from 'x'",
  'const Comp = (props: CompProps) => {',
  '  return x ? props.a : null',
  '}',
].join('\n')

ruleTester.run('component-file-order', componentFileOrder, {
  valid: [
    // Canonical order: imports -> interface -> component.
    {
      code: [
        "import x from 'x'",
        '',
        'interface CompProps {',
        '  a: string',
        '}',
        '',
        'const Comp = (props: CompProps) => {',
        '  return x ? props.a : null',
        '}',
      ].join('\n'),
    },
    // A const between the interface and the component is allowed.
    {
      code: [
        "import x from 'x'",
        '',
        'interface CompProps {',
        '  a: string',
        '}',
        '',
        'const HELPERS = { x }',
        '',
        'const Comp = (props: CompProps) => {',
        '  return HELPERS.x ? props.a : null',
        '}',
      ].join('\n'),
    },
    // Props declared as a type alias.
    {
      code: [
        "import x from 'x'",
        '',
        'type CompProps = { a: string }',
        '',
        'const Comp = (props: CompProps) => {',
        '  return x ? props.a : null',
        '}',
      ].join('\n'),
    },
    // No component in the file — ordering is not enforced even when it is wrong.
    {
      code: ['interface FooProps {', '  a: string', '}', "import x from 'x'", 'const helper = () => x'].join('\n'),
    },
    // First component anchors the boundary; a trailing second component does not cause a false positive.
    {
      code: [
        "import x from 'x'",
        '',
        'interface AProps {',
        '  a: string',
        '}',
        '',
        'const A = (props: AProps) => {',
        '  return <span>{x ? props.a : null}</span>',
        '}',
        '',
        'const B = () => <div />',
      ].join('\n'),
    },
    // paths option provided but the filename does not match — rule is inactive.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/components/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
    },
    // ignore option matches the filename — rule is skipped.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/generated/comp.tsx',
      options: [{ ignore: ['**/generated/**'] }],
    },
    // ignore takes precedence over paths when both match.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/legacy/comp.tsx',
      options: [{ paths: ['**/features/**'], ignore: ['**/legacy/**'] }],
    },
  ],
  invalid: [
    // Import appears after the interface.
    {
      code: WRONG_ORDER,
      errors: [{ messageId: 'importsFirst' }],
    },
    // Component declared before its interface.
    {
      code: [
        "import x from 'x'",
        '',
        'const Comp = () => <div />',
        '',
        'interface CompProps {',
        '  a: string',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'interfaceBeforeComponent' }],
    },
    // paths option provided and the filename matches — rule is active.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
      errors: [{ messageId: 'importsFirst' }],
    },
    // ignore option provided but the filename does not match — rule stays active.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ ignore: ['**/generated/**'] }],
      errors: [{ messageId: 'importsFirst' }],
    },
    // Import after the component in a file with no props interface.
    {
      code: ['const Comp = () => <div />', "import x from 'x'", 'export default x'].join('\n'),
      errors: [{ messageId: 'importsFirst' }],
    },
  ],
})
