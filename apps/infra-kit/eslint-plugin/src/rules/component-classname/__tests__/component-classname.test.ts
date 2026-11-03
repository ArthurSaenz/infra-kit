import tsParser from '@typescript-eslint/parser'
import { RuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import { dedent } from '../../../test-utils/dedent'
import { componentClassname } from '../component-classname'

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

const GOOD = dedent`
  interface SliderComponentProps {
    title: string
    className?: string
  }

  export const SliderComponent = (props: SliderComponentProps) => {
    const { title, className } = props

    return <div className={cn('flex', className)}>{title}</div>
  }
`

const NO_CLASSNAME = 'export const SliderComponent = () => <div />'

ruleTester.run('component-classname', componentClassname, {
  valid: [
    { code: GOOD, filename: FILE },
    // Destructured parameter, required `className`, bare binding.
    {
      code: dedent`
        type SliderComponentProps = { className: string }

        export const SliderComponent = ({ className }: SliderComponentProps) => <div className={className} />
      `,
      filename: FILE,
    },
    // Renamed binding with a default, merged through clsx.
    {
      code: dedent`
        type Props = { className?: string }

        export function SliderComponent({ className: cls = '' }: Props) {
          return <section className={clsx(styles.root, { [cls]: true })} />
        }
      `,
      filename: FILE,
    },
    // `props.className` in a template literal.
    {
      code: dedent`
        type Props = { className?: string }

        export const SliderComponent = (props: Props) => <div className={\`a \${props.className}\`} />
      `,
      filename: FILE,
    },
    // Rest props: `rest.className` counts.
    {
      code: dedent`
        type Props = { title: string; className?: string }

        export const SliderComponent = ({ title, ...rest }: Props) => <div className={cn(rest.className)}>{title}</div>
      `,
      filename: FILE,
    },
    // Intersection where one part declares `className`.
    {
      code: dedent`
        type Base = { className?: string }
        type Props = Base & { title: string }

        export const SliderComponent = ({ title, className }: Props) => <p className={cn(className)}>{title}</p>
      `,
      filename: FILE,
    },
    // Imported / generic / extending props types are unknown: the props check is skipped.
    {
      code: dedent`
        import type { Props } from './types'

        export const SliderComponent = ({ className }: Props) => <div className={className} />
      `,
      filename: FILE,
    },
    {
      code: dedent`
        interface Props extends Base { title: string }

        export const SliderComponent = ({ className }: Props) => <div className={className} />
      `,
      filename: FILE,
    },
    {
      code: "export const SliderComponent = ({ className }: ComponentProps<'div'>) => <div className={className} />",
      filename: FILE,
    },
    // Root is a fragment, a conditional, or there are several returns: the JSX check is skipped.
    {
      code: 'type P = { className?: string }\nexport const SliderComponent = (p: P) => <><div /></>',
      filename: FILE,
    },
    {
      code: 'type P = { className?: string; a: boolean }\nexport const SliderComponent = (p: P) => (p.a ? <div /> : <span />)',
      filename: FILE,
    },
    {
      code: dedent`
        type P = { className?: string; a: boolean }

        export const SliderComponent = (p: P) => {
          if (p.a) {
            return null
          }

          return <div />
        }
      `,
      filename: FILE,
    },
    // A spread may carry `className` through.
    {
      code: 'type P = { className?: string }\nexport const SliderComponent = (p: P) => <div {...p} />',
      filename: FILE,
    },
    // Non-exported components are not checked.
    { code: 'const Inner = () => <div />\nexport const x = 1', filename: FILE },
    // Scope: outside the default paths, stories/tests, `ignore`, custom `paths`.
    { code: NO_CLASSNAME, filename: '/repo/src/features/abroad/containers/slider-container.tsx' },
    { code: NO_CLASSNAME, filename: '/repo/src/features/abroad/components/__stories__/slider.stories.tsx' },
    { code: NO_CLASSNAME, filename: '/repo/src/features/abroad/components/__tests__/slider.test.tsx' },
    {
      code: NO_CLASSNAME,
      filename: '/repo/src/features/abroad/components/icons/arrow.tsx',
      options: [{ ignore: ['**/icons/**'] }],
    },
    { code: NO_CLASSNAME, filename: FILE, options: [{ paths: ['**/ui/**'] }] },
  ],
  invalid: [
    // No props at all: the component cannot accept `className`, and the root does not merge it.
    {
      code: NO_CLASSNAME,
      filename: FILE,
      errors: [
        { messageId: 'missingClassNameProp', data: { name: 'SliderComponent' } },
        { messageId: 'rootMissingClassName', data: { name: 'SliderComponent' } },
      ],
    },
    // Multi-line interface without `className`: fixed by appending the member.
    {
      code: dedent`
        interface SliderComponentProps {
          title: string
        }

        export const SliderComponent = ({ title, className }: SliderComponentProps) => (
          <div className={cn('a', className)}>{title}</div>
        )
      `,
      output: dedent`
        interface SliderComponentProps {
          title: string
          className?: string
        }

        export const SliderComponent = ({ title, className }: SliderComponentProps) => (
          <div className={cn('a', className)}>{title}</div>
        )
      `,
      filename: FILE,
      errors: [{ messageId: 'missingClassNameProp' }],
    },
    // Semicolon-separated members keep their separator.
    {
      code: dedent`
        interface Props {
          title: string;
        }

        export const SliderComponent = ({ className }: Props) => <div className={className} />
      `,
      output: dedent`
        interface Props {
          title: string;
          className?: string;
        }

        export const SliderComponent = ({ className }: Props) => <div className={className} />
      `,
      filename: FILE,
      errors: [{ messageId: 'missingClassNameProp' }],
    },
    // Single-line type literal alias.
    {
      code: 'type Props = { title: string }\nexport const SliderComponent = ({ className }: Props) => <div className={className} />',
      output:
        'type Props = { title: string; className?: string }\nexport const SliderComponent = ({ className }: Props) => <div className={className} />',
      filename: FILE,
      errors: [{ messageId: 'missingClassNameProp' }],
    },
    // Empty inline type literal.
    {
      code: 'export const SliderComponent = ({ className }: {}) => <div className={className} />',
      output: 'export const SliderComponent = ({ className }: { className?: string }) => <div className={className} />',
      filename: FILE,
      errors: [{ messageId: 'missingClassNameProp' }],
    },
    // Root without `className`.
    {
      code: dedent`
        type Props = { className?: string }

        export const SliderComponent = ({ className }: Props) => <div />
      `,
      filename: FILE,
      errors: [{ messageId: 'rootMissingClassName' }],
    },
    // Root with a static `className` that drops the prop.
    {
      code: dedent`
        type Props = { className?: string }

        export const SliderComponent = ({ className }: Props) => <div className="flex" />
      `,
      filename: FILE,
      errors: [{ messageId: 'rootMissingClassName' }],
    },
    // `styles.className` is a different value, not the prop.
    {
      code: dedent`
        type Props = { className?: string }

        export const SliderComponent = (props: Props) => <div className={cn(styles.className)} />
      `,
      filename: FILE,
      errors: [{ messageId: 'rootMissingClassName' }],
    },
    // Destructured without `className` and no rest: the root cannot reach it.
    {
      code: dedent`
        type Props = { title: string; className?: string }

        export const SliderComponent = ({ title }: Props) => <div className={cn('a')}>{title}</div>
      `,
      filename: FILE,
      errors: [{ messageId: 'rootMissingClassName' }],
    },
    // `*-component.tsx` outside a feature is in the default scope too.
    {
      code: NO_CLASSNAME,
      filename: '/repo/src/components/badge-component.tsx',
      errors: [{ messageId: 'missingClassNameProp' }, { messageId: 'rootMissingClassName' }],
    },
  ],
})
