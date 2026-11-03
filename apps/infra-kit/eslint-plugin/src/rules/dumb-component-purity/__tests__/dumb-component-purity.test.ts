import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { dumbComponentPurity } from '../dumb-component-purity'

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

const FILE = '/repo/src/features/abroad/components/slider-component.tsx'

const FEATURE_FLAG =
  'export const SliderComponent = () => {\n  const on = useFeatureFlag()\n\n  return <div>{on}</div>\n}'

ruleTester.run('dumb-component-purity', dumbComponentPurity, {
  valid: [
    {
      code: dedent`
        export const SliderComponent = () => {
          const [open, setOpen] = useState(false)
          const ref = React.useRef(null)
          const id = useId()
          const onClick = useCallback(() => setOpen(true), [])

          useEffect(() => {
            ref.current?.focus()
          }, [open])

          return <div id={id} ref={ref} onClick={onClick} />
        }
      `,
      filename: FILE,
    },
    // `allowHooks` extends the defaults.
    {
      code: 'export const SliderComponent = () => <div>{useMediaQuery("(min-width: 1px)")}</div>',
      filename: FILE,
      options: [{ allowHooks: ['useMediaQuery'] }],
    },
    // A side-effect call outside an effect (an event handler) is not this rule's concern.
    {
      code: 'export const SliderComponent = () => <button onClick={() => fetch("/x")} />',
      filename: FILE,
    },
    // Not hooks: lowercase after `use`, or a member call on something other than React.
    { code: 'export const SliderComponent = () => <div>{user()}{lib.useThing()}</div>', filename: FILE },
    // Scope: containers, stories, tests, `ignore`, custom `paths`.
    { code: FEATURE_FLAG, filename: '/repo/src/features/abroad/containers/slider-container.tsx' },
    { code: FEATURE_FLAG, filename: '/repo/src/features/abroad/components/__stories__/slider.stories.tsx' },
    { code: FEATURE_FLAG, filename: '/repo/src/features/abroad/components/slider.test.tsx' },
    { code: FEATURE_FLAG, filename: FILE, options: [{ ignore: ['**/abroad/**'] }] },
    { code: FEATURE_FLAG, filename: FILE, options: [{ paths: ['**/ui/**'] }] },
  ],
  invalid: [
    {
      code: FEATURE_FLAG,
      filename: FILE,
      errors: [{ messageId: 'forbiddenHook', data: { hook: 'useFeatureFlag' } }],
    },
    // `React.useX`, hooks the convention leaves out, and hooks outside component bodies.
    {
      code: dedent`
        const useLocal = () => useQuery()

        export const SliderComponent = () => {
          const ctx = React.useContext(Ctx)

          return <div>{ctx}{useLocal()}</div>
        }
      `,
      filename: FILE,
      errors: [
        { messageId: 'forbiddenHook', data: { hook: 'useQuery' } },
        { messageId: 'forbiddenHook', data: { hook: 'useContext' } },
        { messageId: 'forbiddenHook', data: { hook: 'useLocal' } },
      ],
    },
    // Side effects inside effects, including nested async functions and `React.useLayoutEffect`.
    {
      code: dedent`
        export const SliderComponent = () => {
          useEffect(() => {
            const load = async () => {
              await fetch('/api')
              await httpClient.get('/api')
            }

            load()
            analytics.track('open')
            window.analytics.track('open')
          }, [])

          React.useLayoutEffect(() => {
            trackAnalyticsEvent('open')
          })

          return <div />
        }
      `,
      filename: FILE,
      errors: [
        { messageId: 'sideEffectInEffect', data: { call: 'fetch' } },
        { messageId: 'sideEffectInEffect', data: { call: 'httpClient.get' } },
        { messageId: 'sideEffectInEffect', data: { call: 'analytics.track' } },
        { messageId: 'sideEffectInEffect', data: { call: 'window.analytics.track' } },
        { messageId: 'sideEffectInEffect', data: { call: 'trackAnalyticsEvent' } },
      ],
    },
    // `*-component.tsx` outside a feature is in the default scope too.
    {
      code: FEATURE_FLAG,
      filename: '/repo/src/components/badge-component.tsx',
      errors: [{ messageId: 'forbiddenHook' }],
    },
  ],
})
