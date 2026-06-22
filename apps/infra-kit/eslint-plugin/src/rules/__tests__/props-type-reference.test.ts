import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { propsTypeReference } from '../props-type-reference'

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

// An inline-typed component shared between the paths/ignore option cases.
const INLINE_TYPED = 'const Comp = (props: { a: string }) => <div>{props.a}</div>'

ruleTester.run('props-type-reference', propsTypeReference, {
  valid: [
    // Named type reference on an identifier param — the desired shape.
    { code: 'function Button(props: ButtonProps) { return <button>{props.label}</button> }' },
    { code: 'const Button = (props: ButtonProps) => <button />' },
    // Named type on a destructured param.
    { code: 'const Button = ({ label }: ButtonProps) => <button>{label}</button>' },
    // No type annotation at all — out of scope (this rule only governs inline object types).
    { code: 'function Button(props) { return <div /> }' },
    // Not a component (lowercase name, no JSX return) — never flagged even with an inline type.
    { code: 'function helper(opts: { x: number }) { return opts.x }' },
    // Intersection that *contains* an inline literal is a `TSIntersectionType`, not a bare
    // `TSTypeLiteral` — intentionally NOT flagged in v1 (documented limitation).
    { code: 'function Button(props: Base & { x: number }) { return <div /> }' },
    // Component with no parameters — nothing to inspect.
    { code: 'const Button = () => <div />' },
    // paths option provided but the filename does not match — rule is inactive.
    {
      code: INLINE_TYPED,
      filename: '/repo/src/components/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
    },
    // ignore option matches the filename — rule is skipped.
    {
      code: INLINE_TYPED,
      filename: '/repo/src/generated/comp.tsx',
      options: [{ ignore: ['**/generated/**'] }],
    },
    // ignore takes precedence over paths when both match.
    {
      code: INLINE_TYPED,
      filename: '/repo/src/features/legacy/comp.tsx',
      options: [{ paths: ['**/features/**'], ignore: ['**/legacy/**'] }],
    },
  ],
  invalid: [
    // Inline object type on an identifier props param — assert the interpolated `<Name>Props`.
    {
      code: 'function Button(props: { label: string }) { return <button>{props.label}</button> }',
      errors: [
        {
          message:
            "Use a named props type (e.g. `ButtonProps`) instead of an inline object type for this component's props.",
        },
      ],
    },
    // Arrow component with an inline object type.
    {
      code: 'const Button = (props: { label: string }) => <button>{props.label}</button>',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    // Inline object type on a destructured param.
    {
      code: 'function Button({ label }: { label: string }) { return <button>{label}</button> }',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    {
      code: 'const Button = ({ label }: { label: string }) => <button>{label}</button>',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    // Empty object literal is still a `TSTypeLiteral` → flagged.
    {
      code: 'function Button(props: {}) { return <div /> }',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    // Generic component — the inner type is still an inline literal, so it is flagged (intentional).
    {
      code: 'function Button<T>(props: { value: T }) { return <div /> }',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    // Default-param value moves the annotation onto the `AssignmentPattern`'s `.left`; the
    // unwrap path must still see the inline type.
    {
      code: 'function Button(props: { x: number } = {}) { return <div /> }',
      errors: [{ messageId: 'useNamedPropsType' }],
    },
    // Anonymous default-exported component — no resolvable name, so the generic variant fires.
    {
      code: 'export default (props: { x: number }) => <div />',
      errors: [{ messageId: 'useNamedPropsTypeAnonymous' }],
    },
    // paths option provided and the filename matches — rule is active.
    {
      code: INLINE_TYPED,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
      errors: [{ messageId: 'useNamedPropsType' }],
    },
  ],
})
