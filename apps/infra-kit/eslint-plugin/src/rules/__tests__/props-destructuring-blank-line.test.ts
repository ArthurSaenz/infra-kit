import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { propsDestructuringBlankLine } from '../props-destructuring-blank-line'
import { dedent } from './_dedent'

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
      code: dedent`
        const Comp = (props) => {
          const { a } = props

          return a
        }
      `,
    },
    // Destructuring is the only statement — nothing to separate from.
    {
      code: dedent`
        const Comp = (props) => {
          const { a } = props
        }
      `,
    },
    // Not a component (camelCase, no JSX) — ignored.
    {
      code: dedent`
        const useThing = (props) => {
          const { a } = props
          return a
        }
      `,
    },
    // Component that does not destructure `props` — out of scope.
    {
      code: dedent`
        const Comp = (props) => {
          const value = props.a
          return value
        }
      `,
    },
  ],
  invalid: [
    // Missing blank line before the next statement.
    {
      code: dedent`
        const Comp = (props) => {
          const { a } = props
          return a
        }
      `,
      output: dedent`
        const Comp = (props) => {
          const { a } = props

          return a
        }
      `,
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
    // TS-annotated props, function declaration.
    {
      code: dedent`
        function Comp(props: Props) {
          const { a, b } = props
          return a + b
        }
      `,
      output: dedent`
        function Comp(props: Props) {
          const { a, b } = props

          return a + b
        }
      `,
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
    // Missing blank line before a trailing comment.
    {
      code: dedent`
        const Comp = (props) => {
          const { a } = props
          // render
          return <div>{a}</div>
        }
      `,
      output: dedent`
        const Comp = (props) => {
          const { a } = props

          // render
          return <div>{a}</div>
        }
      `,
      errors: [{ messageId: 'blankLineAfterProps' }],
    },
  ],
})
