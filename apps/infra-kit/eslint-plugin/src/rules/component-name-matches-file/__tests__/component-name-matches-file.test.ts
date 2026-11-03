import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { componentNameMatchesFile } from '../component-name-matches-file'

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

const COMPONENTS = '/repo/src/features/abroad/components'
const CONTAINERS = '/repo/src/features/abroad/containers'
const WRONG = 'export const Slider = () => <div />'

ruleTester.run('component-name-matches-file', componentNameMatchesFile, {
  valid: [
    // Outside features a file opts in only through its suffix.
    { code: 'export const TooltipV2 = () => <div />', filename: '/repo/src/tooltip-v2/tooltip.tsx' },
    // Shared component libraries keep a folder-per-component layout; the suffix is a feature convention.
    {
      code: 'export const Accordion = () => <div />',
      filename: '/repo/src/components/default/accordion/accordion.tsx',
    },
    {
      code: 'export const AbroadSliderComponent = () => <div />',
      filename: `${COMPONENTS}/abroad-slider-component.tsx`,
    },
    {
      code: dedent`
        export function JulyoBaggageContainer() {
          return <div />
        }
      `,
      filename: `${CONTAINERS}/julyo-baggage-container.tsx`,
    },
    // `export { X }` of a local component.
    {
      code: dedent`
        const AbroadSliderComponent = () => <div />

        export { AbroadSliderComponent }
      `,
      filename: `${COMPONENTS}/abroad-slider-component.tsx`,
    },
    // memo-wrapped component resolves through the wrapper.
    {
      code: "import { memo } from 'react'\nexport const AbroadSliderComponent = memo(() => <div />)",
      filename: `${COMPONENTS}/abroad-slider-component.tsx`,
    },
    // Several exported components: one matching is enough.
    {
      code: 'export const Item = () => <li />\nexport const ListComponent = () => <ul />',
      filename: `${COMPONENTS}/list-component.tsx`,
    },
    // Several exported components, none matching: ambiguous, left to `max-components-per-file`.
    {
      code: 'export const A = () => <li />\nexport const B = () => <ul />',
      filename: `${COMPONENTS}/list-component.tsx`,
    },
    // Non-exported components and non-component exports are not checked.
    { code: 'const Slider = () => <div />\nexport const x = 1', filename: '/repo/src/lib/x.tsx' },
    // Re-export from another module is declared elsewhere.
    { code: "export { Slider } from './slider'", filename: '/repo/src/lib/x.tsx' },
    // Outside `components/` / `containers/`, any basename is allowed as long as the name matches.
    { code: 'export const UserCard = () => <div />', filename: '/repo/src/lib/user-card.tsx' },
    // Skipped files.
    { code: WRONG, filename: `${COMPONENTS}/index.tsx` },
    { code: 'export const Slider = () => null', filename: '/repo/src/lib/x.ts' },
    { code: WRONG, filename: `${COMPONENTS}/__stories__/abroad-slider-component.stories.tsx` },
    { code: WRONG, filename: `${COMPONENTS}/__tests__/abroad-slider-component.test.tsx` },
    { code: WRONG, filename: '/repo/src/pages/home/home.tsx' },
    { code: WRONG, filename: '/repo/src/routes/home.tsx' },
    { code: WRONG, filename: '/repo/src/components/primitives/slider.tsx' },
    // `ignore` replaces the default, `paths` narrows the scope.
    { code: WRONG, filename: '/repo/src/generated/x.tsx', options: [{ ignore: ['**/generated/**'] }] },
    { code: WRONG, filename: '/repo/src/lib/x.tsx', options: [{ paths: ['**/features/**'] }] },
  ],
  invalid: [
    {
      code: dedent`
        type Props = { a: string }

        export const Slider = (props: Props) => <div>{props.a}</div>

        export default Slider
      `,
      filename: `${COMPONENTS}/abroad-slider-component.tsx`,
      errors: [
        {
          messageId: 'nameMismatch',
          data: { file: 'abroad-slider-component.tsx', expected: 'AbroadSliderComponent', actual: 'Slider' },
          suggestions: [
            {
              messageId: 'renameComponent',
              data: { actual: 'Slider', expected: 'AbroadSliderComponent' },
              output: dedent`
                type Props = { a: string }

                export const AbroadSliderComponent = (props: Props) => <div>{props.a}</div>

                export default AbroadSliderComponent
              `,
            },
          ],
        },
      ],
    },
    // `export { X }`: the rename covers the shared local/exported range once.
    {
      code: dedent`
        function Baggage() {
          return <div />
        }

        export { Baggage }
      `,
      filename: `${CONTAINERS}/julyo-baggage-container.tsx`,
      errors: [
        {
          messageId: 'nameMismatch',
          suggestions: [
            {
              messageId: 'renameComponent',
              output: dedent`
                function JulyoBaggageContainer() {
                  return <div />
                }

                export { JulyoBaggageContainer }
              `,
            },
          ],
        },
      ],
    },
    // The expected name is already taken in the module: no rename suggestion.
    {
      code: 'const UserCard = 1\nexport const Card = () => <div>{UserCard}</div>',
      filename: '/repo/src/lib/user-card.tsx',
      options: [{ paths: ['**/lib/**'] }],
      errors: [{ messageId: 'nameMismatch', suggestions: [] }],
    },
    // Wrong suffix under `components/` (nested) and `containers/`; the name still matches the file.
    {
      code: 'export const Slider = () => <div />',
      filename: `${COMPONENTS}/slider/slider.tsx`,
      errors: [{ messageId: 'wrongSuffix', data: { dir: 'components', suffix: '-component', file: 'slider.tsx' } }],
    },
    {
      code: 'export const Baggage = () => <div />',
      filename: `${CONTAINERS}/baggage.tsx`,
      errors: [{ messageId: 'wrongSuffix', data: { dir: 'containers', suffix: '-container', file: 'baggage.tsx' } }],
    },
    // The nearest of `components/` / `containers/` decides the suffix.
    {
      code: 'export const BaggageContainer = () => <div />',
      filename: '/repo/src/features/a/containers/x/components/baggage-container.tsx',
      errors: [
        { messageId: 'wrongSuffix', data: { dir: 'components', suffix: '-component', file: 'baggage-container.tsx' } },
      ],
    },
    // A file with no exported component still gets the suffix check.
    {
      code: 'export const x = 1',
      filename: `${COMPONENTS}/helpers.tsx`,
      errors: [{ messageId: 'wrongSuffix' }],
    },
    // `paths` and `ignore` overriding the defaults re-enable `pages/`.
    {
      code: WRONG,
      filename: '/repo/src/pages/home/home.tsx',
      options: [{ paths: ['**/pages/**'], ignore: [] }],
      errors: [
        {
          messageId: 'nameMismatch',
          data: { file: 'home.tsx', expected: 'Home', actual: 'Slider' },
          suggestions: [{ messageId: 'renameComponent', output: 'export const Home = () => <div />' }],
        },
      ],
    },
  ],
})
