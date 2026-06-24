import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { componentArrowFunction } from '../component-arrow-function'

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

const COMPONENT_FILE = 'src/components/default/foo-component.tsx'

ruleTester.run('component-arrow-function', componentArrowFunction, {
  valid: [
    // Arrow component — the accepted form.
    { code: 'const Foo = () => <div />', filename: COMPONENT_FILE },
    // Arrow component with typed props.
    {
      code: dedent`
        const Foo = ({ a }: FooProps) => {
          return <div>{a}</div>
        }
      `,
      filename: COMPONENT_FILE,
    },
    // Wrapped arrows (memo / forwardRef) stay valid.
    { code: 'const Foo = memo(() => <div />)', filename: COMPONENT_FILE },
    { code: 'const Foo = forwardRef(() => <div />)', filename: COMPONENT_FILE },
    { code: 'const Foo = memo(() => null)', filename: COMPONENT_FILE },
    // Exported / default arrows.
    { code: 'export const Foo = () => <div />', filename: COMPONENT_FILE },
    { code: 'export default () => <div />', filename: COMPONENT_FILE },
    // Non-component declarations are never reported.
    {
      code: dedent`
        function helper() {
          return 1
        }
      `,
      filename: COMPONENT_FILE,
    },
    // camelCase function that does not return JSX is not a component.
    {
      code: dedent`
        function useThing() {
          return 2
        }
      `,
      filename: COMPONENT_FILE,
    },
    // Anonymous, non-rendering wrapped default is not identifiable as a component.
    { code: 'export default memo(function () { return null })', filename: COMPONENT_FILE },
    // Re-export of a binding — caught at its declaration site, not here.
    {
      code: dedent`
        const Foo = () => <div />
        export { Foo }
      `,
      filename: COMPONENT_FILE,
    },
    // `export default Identifier` — the declaration itself is governed elsewhere.
    {
      code: dedent`
        const Foo = () => <div />
        export default Foo
      `,
      filename: COMPONENT_FILE,
    },
    // `ignore` excludes pages even though they contain a function-declaration component.
    {
      code: dedent`
        function Page() {
          return <div />
        }
      `,
      filename: 'src/pages/home.tsx',
      options: [{ ignore: ['**/pages/**'] }],
    },
    // `ignore` also excludes routes (matches the recommended preset's default ignore).
    {
      code: dedent`
        export default function Route() {
          return <div />
        }
      `,
      filename: 'src/routes/index.tsx',
      options: [{ ignore: ['**/pages/**', '**/routes/**'] }],
    },
    // `paths` restricts the rule to matching files only.
    {
      code: dedent`
        function Foo() {
          return <div />
        }
      `,
      filename: 'src/widgets/foo.tsx',
      options: [{ paths: ['**/components/**'] }],
    },
    // Story files keep the rule on, but arrow templates remain valid.
    {
      code: dedent`
        const Template = (args) => <Foo {...args} />

        export const Default = Template.bind({})
      `,
      filename: 'src/components/default/foo-component.stories.tsx',
    },
  ],
  invalid: [
    // Function-declaration component.
    {
      code: dedent`
        function Foo() {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration' }],
    },
    // Exported function declaration.
    {
      code: dedent`
        export function Foo() {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration' }],
    },
    // Default-exported named function declaration.
    {
      code: dedent`
        export default function Foo() {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration' }],
    },
    // PascalCase function declaration with no JSX — flagged by the `isComponent` name heuristic.
    {
      code: dedent`
        function Foo() {
          return null
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration' }],
    },
    // Anonymous default-exported function declaration that returns JSX.
    {
      code: dedent`
        export default function () {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration', data: { name: 'component' } }],
    },
    // Function-expression component.
    {
      code: dedent`
        const Foo = function () {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionExpression' }],
    },
    // Exported function-expression component.
    {
      code: dedent`
        export const Foo = function () {
          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionExpression' }],
    },
    // Wrapped function-expression component.
    {
      code: dedent`
        const Foo = memo(function () {
          return <div />
        })
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionExpression' }],
    },
    // Anonymous wrapped default — name falls back to `component`.
    {
      code: dedent`
        export default memo(function () {
          return <div />
        })
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionExpression', data: { name: 'component' } }],
    },
    // PascalCase non-rendering function — documented intentional over-flag.
    {
      code: dedent`
        function MakeStore() {
          return createStore()
        }
      `,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'functionDeclaration' }],
    },
    // `paths` matches → reported.
    {
      code: dedent`
        function Foo() {
          return <div />
        }
      `,
      filename: 'src/components/default/foo-component.tsx',
      options: [{ paths: ['**/components/**'] }],
      errors: [{ messageId: 'functionDeclaration' }],
    },
  ],
})
