import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { propsDestructuringBlankLine } from '../props-destructuring-blank-line'

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

ruleTester.run('props-destructuring-blank-line', propsDestructuringBlankLine, {
  valid: [
    // Blank line already present.
    {
      code: ['const Comp = (props) => {', '  const { a } = props', '', '  return a', '}'].join('\n'),
    },
    // Destructuring is the only statement — nothing to separate from.
    {
      code: ['const Comp = (props) => {', '  const { a } = props', '}'].join('\n'),
    },
    // Not a component (camelCase, no JSX) — ignored.
    {
      code: ['const useThing = (props) => {', '  const { a } = props', '  return a', '}'].join('\n'),
    },
    // Component that does not destructure `props` — out of scope.
    {
      code: ['const Comp = (props) => {', '  const value = props.a', '  return value', '}'].join('\n'),
    },
  ],
  invalid: [
    // Missing blank line before the next statement.
    {
      code: ['const Comp = (props) => {', '  const { a } = props', '  return a', '}'].join('\n'),
      output: ['const Comp = (props) => {', '  const { a } = props', '', '  return a', '}'].join('\n'),
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
    // TS-annotated props, function declaration.
    {
      code: ['function Comp(props: Props) {', '  const { a, b } = props', '  return a + b', '}'].join('\n'),
      output: ['function Comp(props: Props) {', '  const { a, b } = props', '', '  return a + b', '}'].join('\n'),
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
    // Missing blank line before a trailing comment.
    {
      code: ['const Comp = (props) => {', '  const { a } = props', '  // render', '  return <div>{a}</div>', '}'].join(
        '\n',
      ),
      output: [
        'const Comp = (props) => {',
        '  const { a } = props',
        '',
        '  // render',
        '  return <div>{a}</div>',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
  ],
})
