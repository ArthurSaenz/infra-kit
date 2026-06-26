import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { maxComponentsPerFile } from '../max-components-per-file'

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

// Four trivial components on one line each; reused across cases at different ceilings.
const FOUR_COMPONENTS = dedent`
  const A = () => <div />
  const B = () => <div />
  const C = () => <div />
  const D = () => <div />
`

ruleTester.run('max-components-per-file', maxComponentsPerFile, {
  valid: [
    // #1 — exactly at the ceiling is allowed (only `> max` reports); count 4 === 4.
    { code: FOUR_COMPONENTS, filename: COMPONENT_FILE, options: [{ maxComponents: 4 }] },
    // #2 — under the ceiling.
    {
      code: dedent`
        const A = () => <div />
        const B = () => <div />
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 4 }],
    },
    // #3 — a single component under the dumb-component ceiling of 1.
    {
      code: 'export const Card = () => <div />',
      filename: 'src/components/card/card-component.tsx',
      options: [{ maxComponents: 1 }],
    },
    // #4 — re-exports declare nothing, so they never count toward the limit.
    {
      code: dedent`
        export { A } from './a'
        export { B } from './b'
        export { C } from './c'

        const Main = () => <div />
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 1 }],
    },
    // #5 — styled-components are tagged-template calls, not component functions; not counted.
    {
      code: dedent`
        const Box = styled.div\`color: red;\`
        const Title = styled.h1\`font-size: 2rem;\`
        const Panel = styled.section\`padding: 1rem;\`

        const Main = () => <Box><Title /><Panel /></Box>
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 1 }],
    },
    // #6 — a memo()-wrapped component counts once, not as a separate extra.
    {
      code: dedent`
        const Inner = () => <div />
        const Wrapped = memo(() => <div />)
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 2 }],
    },
    // #7 — `ignore` wins: an over-limit file skipped by the ignore glob (pages/routes default).
    {
      code: `${FOUR_COMPONENTS}\nconst E = () => <div />\n`,
      filename: 'src/pages/dashboard.tsx',
      options: [{ maxComponents: 1, ignore: ['**/pages/**', '**/routes/**'] }],
    },
    // #8 — `paths` excludes a file: over-limit components not linted.
    {
      code: `${FOUR_COMPONENTS}\nconst E = () => <div />\n`,
      filename: 'src/widgets/foo.tsx',
      options: [{ maxComponents: 1, paths: ['**/components/**'] }],
    },
  ],
  invalid: [
    // #9 — five components over a ceiling of 4 → one error on the 5th, file-scoped count.
    {
      code: `${FOUR_COMPONENTS}\nconst E = () => <div />\n`,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 4 }],
      errors: [{ messageId: 'tooManyComponents', data: { count: 5, max: 4, name: 'E' } }],
    },
    // #10 — default ceiling (no `maxComponents`): a 5th component trips DEFAULT_MAX_COMPONENTS (4).
    {
      code: `${FOUR_COMPONENTS}\nconst E = () => <div />\n`,
      filename: COMPONENT_FILE,
      errors: [{ messageId: 'tooManyComponents', data: { count: 5, max: 4, name: 'E' } }],
    },
    // #11 — multi-declarator: `const A = …, B = …, C = …` counts 3; the 2nd is the first offender.
    {
      code: 'const A = () => <div />, B = () => <div />, C = () => <div />',
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 1 }],
      errors: [{ messageId: 'tooManyComponents', data: { count: 3, max: 1, name: 'B' } }],
    },
    // #12 — anonymous default export beyond the limit → name falls back to `component`.
    {
      code: dedent`
        const A = () => <div />
        export default () => <div />
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 1 }],
      errors: [{ messageId: 'tooManyComponents', data: { count: 2, max: 1, name: 'component' } }],
    },
    // #13 — KNOWN BEHAVIOUR (pinned): a PascalCase non-JSX factory IS counted, because
    // `isComponent` short-circuits on the PascalCase name before checking for JSX. Two such
    // declarations over a ceiling of 1 report. Documented heuristic, not a bug.
    {
      code: dedent`
        const Make = () => ({ a: 1 })
        const Build = () => ({ b: 2 })
      `,
      filename: COMPONENT_FILE,
      options: [{ maxComponents: 1 }],
      errors: [{ messageId: 'tooManyComponents', data: { count: 2, max: 1, name: 'Build' } }],
    },
    // #14 — dumb-component file with a main component + a private sub-component trips max 1.
    {
      code: dedent`
        const Row = () => <li />

        export const List = () => <ul><Row /></ul>
      `,
      filename: 'src/components/list/list-component.tsx',
      options: [{ maxComponents: 1 }],
      errors: [{ messageId: 'tooManyComponents', data: { count: 2, max: 1, name: 'List' } }],
    },
  ],
})
