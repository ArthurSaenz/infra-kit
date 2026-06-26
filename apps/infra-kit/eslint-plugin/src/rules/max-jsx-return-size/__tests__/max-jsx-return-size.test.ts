import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { maxJsxReturnSize } from '../max-jsx-return-size'

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

// 21 JSX elements: one <div> wrapper + 20 <span /> children. Trips the default
// ceiling of 20 without passing `maxElements`, pinning DEFAULT_MAX_ELEMENTS.
const TWENTY_SPANS = Array.from({ length: 20 }).fill('<span />').join('')

ruleTester.run('max-jsx-return-size', maxJsxReturnSize, {
  valid: [
    // #1 — under threshold (count 2 ≤ 3).
    { code: 'const Foo = () => <div><span /></div>', filename: COMPONENT_FILE, options: [{ maxElements: 3 }] },
    // #2 — exactly at threshold is allowed (only `> max` reports); count 3 === 3.
    {
      code: 'const Foo = () => <div><span /><span /></div>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
    },
    // #3 — small guard (1) + small main (2), neither exceeds.
    {
      code: dedent`
        const Foo = ({ loading }: FooProps) => {
          if (loading) return <Spinner />

          return <div><span /></div>
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
    },
    // #4 — extraction reward: hoisted JSX is referenced as {header} (not counted),
    // so the return counts only <div> (1); inlined it would be 4.
    {
      code: dedent`
        const Foo = () => {
          const header = <header><h1 /><nav /></header>

          return <div>{header}</div>
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
    },
    // #5 — fragment wrapper is free: <>…</> contributes 0; two <span /> = 2 ≤ 2.
    {
      code: 'const Foo = () => <><span /><span /></>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
    },
    // #6 — non-component functions are never measured (and render no JSX anyway).
    {
      code: dedent`
        function helper() {
          return 1
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 1 }],
    },
    // #7 — `paths` excludes a file: over-threshold component not linted.
    {
      code: 'const Foo = () => <div><span /><span /><span /></div>',
      filename: 'src/widgets/foo.tsx',
      options: [{ maxElements: 3, paths: ['**/components/**'] }],
    },
    // #8 — `ignore` wins: over-threshold component skipped by ignore glob.
    {
      code: 'const Foo = () => <div><span /><span /><span /></div>',
      filename: 'src/components/default/foo-component.tsx',
      options: [{ maxElements: 3, ignore: ['**/components/**'] }],
    },
    // #8b — bare `return;` guard does not crash and renders no JSX on that path;
    // the JSX return (count 1) is under threshold.
    {
      code: dedent`
        const Foo = ({ data }: FooProps) => {
          if (!data) {
            return
          }

          return <div />
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
    },
  ],
  invalid: [
    // #9 — single nested return over threshold: div, section, span, span = 4 > 3.
    {
      code: 'const Foo = () => <div><section><span /><span /></section></div>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 4, max: 3, name: 'Foo' } }],
    },
    // #10 — boundary +1: count 3 === max(2)+1 reports exactly once.
    {
      code: 'const Foo = () => <div><span /><span /></div>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } }],
    },
    // #11 — two over-threshold returns (both if-branches) → two errors (per-return).
    {
      code: dedent`
        const Foo = ({ flag }: FooProps) => {
          if (flag) {
            return <a><b /><c /></a>
          }

          return <d><e /><f /></d>
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [
        { messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } },
        { messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } },
      ],
    },
    // #12 — small guard (1) not reported; only the oversized main return (3).
    {
      code: dedent`
        const Foo = ({ loading }: FooProps) => {
          if (loading) return <Spinner />

          return <div><span /><span /></div>
        }
      `,
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } }],
    },
    // #13 — arrow implicit-return over threshold (no block): main, a, b = 3 > 2.
    {
      code: 'const Foo = () => <main><a /><b /></main>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } }],
    },
    // #14 — inline-callback JSX counts in the parent return (Option A): ul, li, a = 3.
    {
      code: 'const Foo = () => <ul>{items.map(() => <li><a /></li>)}</ul>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } }],
    },
    // #15 — DOUBLE-COUNT REGRESSION: with maxElements 1, the outer return (3) AND
    // the inline callback body alone (li, a = 2) would each trip under the rejected
    // function-node-selector scoping. Scope-2 visits only the top-level component,
    // so there is EXACTLY ONE error. Reverting to selectors breaks this test.
    {
      code: 'const Foo = () => <ul>{items.map(() => <li><a /></li>)}</ul>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 1 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 1, name: 'Foo' } }],
    },
    // #16 — `paths` matches → reported.
    {
      code: 'const Foo = () => <div><span /><span /></div>',
      filename: 'src/components/default/foo-component.tsx',
      options: [{ maxElements: 2, paths: ['**/components/**'] }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Foo' } }],
    },
    // #17 — anonymous default component → name falls back to `component`.
    {
      code: 'export default () => <div><span /><span /></div>',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'component' } }],
    },
    // #18 — default applied (no `maxElements`): 21 elements > DEFAULT_MAX_ELEMENTS (20).
    {
      code: `const Big = () => <div>${TWENTY_SPANS}</div>`,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'tooManyElements', data: { count: 21, max: 20, name: 'Big' } }],
    },
    // #19 — conditional branches are SUMMED: a, b, c, d = 4 > 3.
    {
      code: 'const Foo = () => (cond ? <a><b /></a> : <c><d /></c>)',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 3 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 4, max: 3, name: 'Foo' } }],
    },
    // #20 — JSX in attributes is counted: Widget, Icon, Bolt = 3 > 2.
    {
      code: 'const Widget = () => <Panel icon={<Icon><Bolt /></Icon>} />',
      filename: COMPONENT_FILE,
      options: [{ maxElements: 2 }],
      errors: [{ messageId: 'tooManyElements', data: { count: 3, max: 2, name: 'Widget' } }],
    },
  ],
})
