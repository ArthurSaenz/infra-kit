import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { propsDestructuringNewline } from '../props-destructuring-newline'

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
      code: ['const Comp = (props) => {', '  const { a, b } = props', '', '  return a', '}'].join('\n'),
    },
    // TS-annotated, correct shape.
    {
      code: ['const Comp = (props: Props) => {', '  const { a } = props', '', '  return null', '}'].join('\n'),
    },
    // Function declaration, correct shape.
    {
      code: ['function Comp(props) {', '  const { a } = props', '', '  return null', '}'].join('\n'),
    },
    // Component with no params.
    { code: 'const Comp = () => <div />' },
    // Hook (camelCase, no JSX) — not a component, inline destructuring is fine.
    { code: 'const useThing = ({ a }) => a' },
    // Plain helper (camelCase, no JSX) — not a component.
    { code: ['function merge({ a, b }) {', '  return a + b', '}'].join('\n') },
  ],
  invalid: [
    // Arrow, block body, plain JS.
    {
      code: ['const Comp = ({ a, b }) => {', '  return a', '}'].join('\n'),
      output: ['const Comp = (props) => {', '  const { a, b } = props', '', '  return a', '}'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Arrow, block body, TS type annotation is preserved on `props`.
    {
      code: ['const Comp = ({ a }: Props) => {', '  return a', '}'].join('\n'),
      output: ['const Comp = (props: Props) => {', '  const { a } = props', '', '  return a', '}'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Function declaration.
    {
      code: ['function Comp({ a, b }) {', '  return a + b', '}'].join('\n'),
      output: ['function Comp(props) {', '  const { a, b } = props', '', '  return a + b', '}'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Expression-bodied arrow returning JSX is wrapped into a block.
    {
      code: 'const Comp = ({ name }) => <div>{name}</div>',
      output: ['const Comp = (props) => {', '  const { name } = props', '', '  return <div>{name}</div>', '}'].join(
        '\n',
      ),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in memo() — still recognised by its PascalCase variable name.
    {
      code: ['const Comp = memo(({ a }) => {', '  return a', '})'].join('\n'),
      output: ['const Comp = memo((props) => {', '  const { a } = props', '', '  return a', '})'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Anonymous arrow detected purely by its JSX return.
    {
      code: 'export default ({ title }) => <h1>{title}</h1>',
      output: ['export default (props) => {', '  const { title } = props', '', '  return <h1>{title}</h1>', '}'].join(
        '\n',
      ),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in forwardRef() — only the first (props) param is rewritten, ref is left intact.
    {
      code: ['const Comp = forwardRef(({ a }, ref) => {', '  return a', '})'].join('\n'),
      output: ['const Comp = forwardRef((props, ref) => {', '  const { a } = props', '', '  return a', '})'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
    // Wrapped in React.memo() — member-expression wrapper is recognised.
    {
      code: ['const Comp = React.memo(({ a }) => {', '  return a', '})'].join('\n'),
      output: ['const Comp = React.memo((props) => {', '  const { a } = props', '', '  return a', '})'].join('\n'),
      errors: [{ messageId: 'destructureOnNewLine' }],
    },
  ],
})
