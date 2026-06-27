import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, expect, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
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

// Wrong order shared between the paths/ignore option cases. `CompProps` sits before the
// import (importsFirst) and is separated from `Comp` by the import (not immediately before).
const WRONG_ORDER = dedent`
  interface CompProps {
    a: string
  }
  import x from 'x'
  const Comp = (props: CompProps) => {
    return x ? props.a : null
  }
`

ruleTester.run('component-file-order', componentFileOrder, {
  valid: [
    // Canonical order: imports -> interface -> component (interface immediately before).
    {
      code: dedent`
        import x from 'x'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
    },
    // Helper consts are allowed *after* the component.
    {
      code: dedent`
        import x from 'x'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }

        const HELPERS = { x }
      `,
    },
    // Props declared as a type alias, immediately before the component.
    {
      code: dedent`
        import x from 'x'

        type CompProps = { a: string }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
    },
    // No component in the file — ordering is not enforced even when it is wrong.
    {
      code: dedent`
        interface FooProps {
          a: string
        }
        import x from 'x'
        const helper = () => x
      `,
    },
    // Two components, each with its own props directly before it (the user's real case).
    {
      code: dedent`
        import x from 'x'

        interface AProps {
          a: string
        }

        const A = (props: AProps) => {
          return <span>{x ? props.a : null}</span>
        }

        interface BProps {
          b: string
        }

        const B = (props: BProps) => <div>{props.b}</div>
      `,
    },
    // Helpers between the two component blocks are fine — they come after the first component
    // and before the second component's own (adjacent) interface.
    {
      code: dedent`
        import x from 'x'

        interface AProps {
          a: string
        }

        const A = (props: AProps) => <span>{x ? props.a : null}</span>

        const HELPERS = { x }

        interface BProps {
          b: string
        }

        const B = (props: BProps) => <div>{props.b}</div>
      `,
    },
    // A trailing second component without its own props interface is not checked.
    {
      code: dedent`
        import x from 'x'

        interface AProps {
          a: string
        }

        const A = (props: AProps) => <span>{x ? props.a : null}</span>

        const B = () => <div />
      `,
    },
    // Anonymous default-exported component: no resolvable name, so no props to match.
    {
      code: dedent`
        import x from 'x'

        interface Props { a: string }

        export default () => <div>{x}</div>
      `,
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
    // Story files are exempted via the ignore option even with a wrong order.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/components/Button.stories.tsx',
      options: [{ ignore: ['**/*.stories.tsx'] }],
    },
    // ignore takes precedence over paths when both match.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/legacy/comp.tsx',
      options: [{ paths: ['**/features/**'], ignore: ['**/legacy/**'] }],
    },
    // Multiple imports, then the interface immediately after the last one — passes.
    {
      code: dedent`
        import x from 'x'
        import y from 'y'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x && y ? props.a : null
        }
      `,
    },
    // `'use client'` directive at the top — the directive prologue is legitimate leading
    // content and must not count as a stray statement before the props interface.
    {
      code: dedent`
        'use client'

        import x from 'x'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
    },
    // `'use server'` directive behaves the same as `'use client'`.
    {
      code: dedent`
        'use server'

        import x from 'x'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
    },
    // Directive with no imports — exercises the vacuous-truth branch with a leading directive.
    {
      code: dedent`
        'use client'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => (props.a ? <div>{props.a}</div> : null)
      `,
    },
    // Multiple directives in the prologue — every leading string literal is skipped.
    {
      code: dedent`
        'use client'
        'use strict'

        import x from 'x'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
    },
    // Props type imported (not declared locally) and the component immediately after the imports —
    // valid. There is no in-file interface, so the component is anchored straight to the imports.
    {
      code: dedent`
        import x from 'x'
        import type { CompProps } from './types'

        const Comp = (props: CompProps) => {
          return x ? <div>{props.a}</div> : null
        }
      `,
    },
    // Imported props type with a helper *after* the component — allowed, like the local-interface
    // case. Only definitions wedged before the component break the imports→component adjacency.
    {
      code: dedent`
        import x from 'x'
        import type { CompProps } from './types'

        const Comp = (props: CompProps) => <div>{x ? props.a : null}</div>

        const HELPERS = { x }
      `,
    },
    // A leading directive plus an imported props type, component immediately after the imports —
    // valid. The directive is legitimate leading content, not a stray before the component.
    {
      code: dedent`
        'use client'

        import x from 'x'
        import type { CompProps } from './types'

        const Comp = (props: CompProps) => <div>{x ? props.a : null}</div>
      `,
    },
    // Only the *first* component is anchored to the imports: the second component's imported props
    // type with a stray before it is not checked (mirrors the local-interface-anchoring scope).
    {
      code: dedent`
        import x from 'x'
        import type { BProps } from './types'

        interface AProps {
          a: string
        }

        const A = (props: AProps) => <span>{x ? props.a : null}</span>

        const SOMETHING = 1

        const B = (props: BProps) => <div>{SOMETHING ? props.b : null}</div>
      `,
    },
    // Props interface whose name does NOT follow the `<Component>Props` convention, declared
    // immediately before the component — valid. The component is matched by the type its parameter
    // actually references (`Props`), not by a name guess.
    {
      code: dedent`
        import x from 'x'

        interface Props {
          a: string
        }

        const UserCard = (props: Props) => {
          return x ? props.a : null
        }
      `,
    },
    // Two components sharing one props type. A single declaration cannot sit immediately before
    // both, so adjacency is unenforceable for a shared type and is intentionally skipped.
    {
      code: dedent`
        import x from 'x'

        interface Props {
          a: string
        }

        const A = (props: Props) => <span>{x ? props.a : null}</span>

        const B = (props: Props) => <div>{props.a}</div>
      `,
    },
    // A qualified-name props annotation (`NS.Props`) is not a simple named reference, so it does not
    // resolve; the rule falls back to the `<Component>Props` convention, finds no such local type,
    // and reports nothing rather than crashing.
    {
      code: dedent`
        import x from 'x'

        const UserCard = (props: NS.Props) => {
          return x ? props : null
        }
      `,
    },
    // forwardRef-wrapped component with its props interface immediately before it — valid. The props
    // type is resolved from the inner function's first parameter, through the wrapper.
    {
      code: dedent`
        import { forwardRef } from 'react'

        interface Props {
          a: string
        }

        const Comp = forwardRef((props: Props, ref) => <div ref={ref}>{props.a}</div>)
      `,
    },
  ],
  invalid: [
    // Interface before the import, and separated from the component by the import.
    // `data` asserts the message now interpolates the real interface + component names.
    {
      code: WRONG_ORDER,
      errors: [
        { messageId: 'interfaceImmediatelyBeforeComponent', data: { interface: 'CompProps', component: 'Comp' } },
        { messageId: 'importsFirst' },
      ],
    },
    // Component declared before its interface.
    {
      code: dedent`
        import x from 'x'

        const Comp = () => <div />

        interface CompProps {
          a: string
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }],
    },
    // A non-import statement wedged between the interface and its component breaks adjacency.
    {
      code: dedent`
        import x from 'x'

        interface CompProps {
          a: string
        }

        const HELPERS = { x }

        const Comp = (props: CompProps) => {
          return HELPERS.x ? props.a : null
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }],
    },
    // Second component's own props is declared after it; the first component is untouched.
    {
      code: dedent`
        import x from 'x'

        interface AProps {
          a: string
        }

        const A = (props: AProps) => <span>{x ? props.a : null}</span>

        const B = (props: BProps) => <div>{props.b}</div>

        interface BProps {
          b: string
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }],
    },
    // paths option provided and the filename matches — rule is active.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ paths: ['**/features/**'] }],
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }, { messageId: 'importsFirst' }],
    },
    // ignore option provided but the filename does not match — rule stays active.
    {
      code: WRONG_ORDER,
      filename: '/repo/src/features/user/comp.tsx',
      options: [{ ignore: ['**/generated/**'] }],
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }, { messageId: 'importsFirst' }],
    },
    // Import after the component in a file with no props interface.
    {
      code: dedent`
        const Comp = () => <div />
        import x from 'x'
        export default x
      `,
      errors: [{ messageId: 'importsFirst' }],
    },
    // A stray const wedged between the imports and the props interface.
    {
      code: dedent`
        import x from 'x'

        const SOMETHING = 1

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return SOMETHING ? <div>{x ? props.a : null}</div> : null
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyAfterImports', data: { interface: 'CompProps', component: 'Comp' } }],
    },
    // A stray type/helper (non-const) between the imports and the props interface.
    {
      code: dedent`
        import x from 'x'

        type Foo = number

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          const foo: Foo = 1
          return foo && x ? <div>{props.a}</div> : null
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyAfterImports' }],
    },
    // Zero imports, stray const, then interface + component — locks the vacuous-truth branch.
    {
      code: dedent`
        const SOMETHING = 1

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => (SOMETHING ? <div>{props.a}</div> : null)
      `,
      errors: [{ messageId: 'interfaceImmediatelyAfterImports' }],
    },
    // Combined: stray def AND component before its interface — two genuinely distinct errors.
    {
      code: dedent`
        import x from 'x'

        const SOMETHING = 1

        const Comp = (props: CompProps) => (SOMETHING && x ? <div>{props.a}</div> : null)

        interface CompProps {
          a: string
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }, { messageId: 'interfaceImmediatelyAfterImports' }],
    },
    // A directive placed AFTER an import is not a prologue (the leading run broke at the
    // import), so the misplaced string is still a stray statement before the interface.
    {
      code: dedent`
        import x from 'x'

        'use client'

        interface CompProps {
          a: string
        }

        const Comp = (props: CompProps) => {
          return x ? props.a : null
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyAfterImports' }],
    },
    // Props type imported, but a stray const wedged between the imports and the component breaks
    // the imports→component adjacency (the user's real `import type { …Props }` case).
    {
      code: dedent`
        import x from 'x'
        import type { CompProps } from './types'

        const SOMETHING = 1

        const Comp = (props: CompProps) => {
          return SOMETHING && x ? <div>{props.a}</div> : null
        }
      `,
      errors: [{ messageId: 'componentImmediatelyAfterImports', data: { interface: 'CompProps', component: 'Comp' } }],
    },
    // Props type imported, with a stray type alias between the imports and the component.
    {
      code: dedent`
        import x from 'x'
        import type { CompProps } from './types'

        type Foo = number

        const Comp = (props: CompProps) => {
          const foo: Foo = 1
          return foo && x ? <div>{props.a}</div> : null
        }
      `,
      errors: [{ messageId: 'componentImmediatelyAfterImports' }],
    },
    // Imported props type with a leading directive: the directive is not a stray, but the const
    // between the imports and the component still is.
    {
      code: dedent`
        'use client'

        import x from 'x'
        import type { CompProps } from './types'

        const SOMETHING = 1

        const Comp = (props: CompProps) => (SOMETHING && x ? <div>{props.a}</div> : null)
      `,
      errors: [{ messageId: 'componentImmediatelyAfterImports' }],
    },
    // The reported bug: a props interface whose name does NOT match the component, with a stray
    // declaration wedged between it and the component. The interface must be immediately before the
    // component regardless of its name — matched via the parameter type the component references.
    {
      code: dedent`
        interface Props {
          name: string
        }

        const DEFAULT_NAME = 'Anonymous'

        export const UserCard = ({ name }: Props) => {
          return <div>{name || DEFAULT_NAME}</div>
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }],
    },
    // Non-convention props name with a stray between the imports and the (correctly adjacent)
    // interface — the imports-anchor check still fires for a generically named props type.
    {
      code: dedent`
        import x from 'x'

        const SOMETHING = 1

        interface Props {
          a: string
        }

        const UserCard = (props: Props) => {
          return SOMETHING ? <div>{x ? props.a : null}</div> : null
        }
      `,
      errors: [{ messageId: 'interfaceImmediatelyAfterImports' }],
    },
    // forwardRef-wrapped component with a stray wedged between its interface and the component —
    // adjacency is enforced through the wrapper.
    {
      code: dedent`
        import { forwardRef } from 'react'

        interface Props {
          a: string
        }

        const HELPERS = { a: 1 }

        const Comp = forwardRef((props: Props, ref) => <div ref={ref}>{props.a || HELPERS.a}</div>)
      `,
      errors: [{ messageId: 'interfaceImmediatelyBeforeComponent' }],
    },
    // Disagreement case: the component references `UserCardProps`, but a differently-named interface
    // (`Props`) sits adjacent. The parameter type is authoritative, so the violation fires on the
    // real (non-adjacent) `UserCardProps`, not the conveniently-adjacent `Props`.
    {
      code: dedent`
        import x from 'x'

        interface UserCardProps {
          a: string
        }

        interface Props {
          b: string
        }

        const UserCard = (props: UserCardProps) => {
          return x ? props.a : null
        }
      `,
      // The message names the authoritative referenced type (`UserCardProps`), not the
      // conveniently-adjacent `Props`.
      errors: [
        {
          messageId: 'interfaceImmediatelyBeforeComponent',
          data: { interface: 'UserCardProps', component: 'UserCard' },
        },
      ],
    },
  ],
})

// The three component-anchored messages must carry identifier placeholders (so an AI fix loop
// reads the concrete interface/component), while `importsFirst` stays generic on purpose.
describe('component-file-order message templates', () => {
  const messages = componentFileOrder.meta?.messages ?? {}

  it('interpolates names into the three anchored messages', () => {
    for (const id of [
      'interfaceImmediatelyBeforeComponent',
      'interfaceImmediatelyAfterImports',
      'componentImmediatelyAfterImports',
    ] as const) {
      expect(messages[id]).toContain('{{interface}}')
      expect(messages[id]).toContain('{{component}}')
    }
  })

  it('keeps importsFirst generic (no placeholders)', () => {
    expect(messages.importsFirst).toBe('Imports must come before the component interface and declaration.')
  })
})
