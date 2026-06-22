import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { propsDestructuringNewline } from '../props-destructuring-newline'
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

ruleTester.run('props-destructuring-newline', propsDestructuringNewline, {
  valid: [
    // Canonical shape: single `props` param, destructured on its own line.
    {
      code: dedent`
        const Comp = (props) => {
          const { a, b } = props

          return a
        }
      `,
    },
    // TS-annotated, correct shape.
    {
      code: dedent`
        const Comp = (props: Props) => {
          const { a } = props

          return null
        }
      `,
    },
    // Function declaration, correct shape.
    {
      code: dedent`
        function Comp(props) {
          const { a } = props

          return null
        }
      `,
    },
    // Component with no params.
    { code: 'const Comp = () => <div />' },
    // No-props component with a block body — nothing to destructure, must not error.
    {
      code: dedent`
        export const Page = () => {
          const router = useRouter()

          return <div />
        }
      `,
    },
    // Hook (camelCase, no JSX) — not a component, inline destructuring is fine.
    { code: 'const useThing = ({ a }) => a' },
    // Plain helper (camelCase, no JSX) — not a component.
    {
      code: dedent`
        function merge({ a, b }) {
          return a + b
        }
      `,
    },
  ],
  invalid: [
    // Arrow, block body, plain JS.
    {
      code: dedent`
        const Comp = ({ a, b }) => {
          return a
        }
      `,
      output: dedent`
        const Comp = (props) => {
          const { a, b } = props

          return a
        }
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Arrow, block body, TS type annotation is preserved on `props`.
    {
      code: dedent`
        const Comp = ({ a }: Props) => {
          return a
        }
      `,
      output: dedent`
        const Comp = (props: Props) => {
          const { a } = props

          return a
        }
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Function declaration.
    {
      code: dedent`
        function Comp({ a, b }) {
          return a + b
        }
      `,
      output: dedent`
        function Comp(props) {
          const { a, b } = props

          return a + b
        }
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Expression-bodied arrow returning JSX is wrapped into a block.
    {
      code: 'const Comp = ({ name }) => <div>{name}</div>',
      output: dedent`
        const Comp = (props) => {
          const { name } = props

          return <div>{name}</div>
        }
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in memo() — still recognised by its PascalCase variable name.
    {
      code: dedent`
        const Comp = memo(({ a }) => {
          return a
        })
      `,
      output: dedent`
        const Comp = memo((props) => {
          const { a } = props

          return a
        })
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Anonymous arrow detected purely by its JSX return.
    {
      code: 'export default ({ title }) => <h1>{title}</h1>',
      output: dedent`
        export default (props) => {
          const { title } = props

          return <h1>{title}</h1>
        }
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in forwardRef() — only the first (props) param is rewritten, ref is left intact.
    {
      code: dedent`
        const Comp = forwardRef(({ a }, ref) => {
          return a
        })
      `,
      output: dedent`
        const Comp = forwardRef((props, ref) => {
          const { a } = props

          return a
        })
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in React.memo() — member-expression wrapper is recognised.
    {
      code: dedent`
        const Comp = React.memo(({ a }) => {
          return a
        })
      `,
      output: dedent`
        const Comp = React.memo((props) => {
          const { a } = props

          return a
        })
      `,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Pattern binds `props` via a `...props` rest: still a violation, but there is no safe
    // autofix (it would produce `const { icon, ...props } = props`), so it reports with no fix.
    {
      code: dedent`
        function Icon({ icon, ...props }) {
          return <svg />
        }
      `,
      output: null,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Expression-bodied arrow returning JSX with a `...props` rest — reports, no autofix.
    {
      code: 'const Compo = ({ icon, ...props }) => <Icon />',
      output: null,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Pattern binds `props` directly (shorthand) — same collision risk, reports with no fix.
    {
      code: 'const Comp = ({ props }) => <div />',
      output: null,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Pattern binds `props` via a nested rename — reports with no fix.
    {
      code: 'const Comp = ({ data: props }) => <div>{props}</div>',
      output: null,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in forwardRef() with a `...props` rest: reports without a fix, and the `ref`
    // second param is left untouched (no-fix path must not rewrite anything).
    {
      code: dedent`
        const Comp = forwardRef(({ icon, ...props }, ref) => {
          return <svg />
        })
      `,
      output: null,
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
  ],
})
