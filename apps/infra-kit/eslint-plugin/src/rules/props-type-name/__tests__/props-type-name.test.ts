import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { propsTypeName } from '../props-type-name'

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

// A component whose props type does not follow the `<ComponentName>Props` convention. Shared
// between the paths/ignore option cases.
const WRONG_NAME = 'const UserCard = (props: Props) => <div>{props.a}</div>'

ruleTester.run('props-type-name', propsTypeName, {
  valid: [
    // Props type named exactly `<ComponentName>Props`.
    {
      code: 'const UserCard = (props: UserCardProps) => <div>{props.a}</div>',
    },
    // Destructured props parameter with the conventional name.
    {
      code: 'const UserCard = ({ a }: UserCardProps) => <div>{a}</div>',
    },
    // Function declaration component with the conventional name.
    {
      code: dedent`
        function UserCard(props: UserCardProps) {
          return <div>{props.a}</div>
        }
      `,
    },
    // forwardRef-wrapped component: the name is resolved through the wrapper and the props type
    // matches the variable name.
    {
      code: dedent`
        import { forwardRef } from 'react'

        const UserCard = forwardRef((props: UserCardProps, ref) => <div ref={ref}>{props.a}</div>)
      `,
    },
    // Anonymous component: no name to derive the expected props type from, so it is not checked.
    {
      code: 'export default (props: Props) => <div>{props.a}</div>',
    },
    // Inline props type is the `props-type-reference` rule's concern, not this one — not flagged here.
    {
      code: 'const UserCard = (props: { a: string }) => <div>{props.a}</div>',
    },
    // No typed props parameter — nothing to constrain.
    {
      code: 'const UserCard = () => <div />',
    },
    // Qualified-name annotation does not resolve to a simple name, so it is left alone.
    {
      code: 'const UserCard = (props: NS.Props) => <div>{props.a}</div>',
    },
    // paths option provided but the filename does not match — rule is inactive.
    {
      code: WRONG_NAME,
      filename: '/repo/src/components/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
    },
    // ignore option matches the filename — rule is skipped.
    {
      code: WRONG_NAME,
      filename: '/repo/src/generated/comp.tsx',
      options: [{ ignore: ['**/generated/**'] }],
    },
    // ignore takes precedence over paths when both match.
    {
      code: WRONG_NAME,
      filename: '/repo/src/features/legacy/comp.tsx',
      options: [{ paths: ['**/features/**'], ignore: ['**/legacy/**'] }],
    },
  ],
  invalid: [
    // Props type named `Props` instead of `UserCardProps`.
    {
      code: WRONG_NAME,
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'Props' } }],
    },
    // Destructured props parameter with a non-conventional type name.
    {
      code: 'const UserCard = ({ a }: Props) => <div>{a}</div>',
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'Props' } }],
    },
    // Function declaration component with a mismatched props type name.
    {
      code: dedent`
        function UserCard(props: CardProps) {
          return <div>{props.a}</div>
        }
      `,
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'CardProps' } }],
    },
    // Imported props type with a non-conventional name is still flagged (escape via paths/ignore).
    {
      code: dedent`
        import type { Foo } from './types'

        const UserCard = (props: Foo) => <div>{props.a}</div>
      `,
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'Foo' } }],
    },
    // forwardRef-wrapped component whose props type name does not match the resolved variable name.
    {
      code: dedent`
        import { forwardRef } from 'react'

        const UserCard = forwardRef((props: Props, ref) => <div ref={ref}>{props.a}</div>)
      `,
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'Props' } }],
    },
    // paths option provided and the filename matches — rule is active.
    {
      code: WRONG_NAME,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
      errors: [{ messageId: 'propsTypeNameMismatch', data: { expected: 'UserCardProps', actual: 'Props' } }],
    },
  ],
})
