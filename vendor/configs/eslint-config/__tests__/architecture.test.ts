import { ESLint } from 'eslint'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import config from '../src/index.js'
import { code, expectClean, expectFlagged, lintCase, only } from './_lint-case.js'

const lintWith = async (options: Parameters<typeof config>[0], source: string, fileName: string) => {
  const cwd = path.resolve(import.meta.dirname, '..')
  const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: await config(options) })
  const [result] = await eslint.lintText(source, { filePath: path.resolve(cwd, fileName) })

  return result?.messages ?? []
}

describe('architecture: rules of hooks', () => {
  it('flags a hook called inside a cell render callback', async () => {
    const messages = await lintCase({
      fileName: 'src/features/shows/components/events-list-component.tsx',
      source: code`
        import { useState } from 'react'

        export const columns = [{ renderCell: () => { const [open] = useState(false); return open } }]
      `,
    })

    expectFlagged(messages, 'react-hooks/rules-of-hooks', 'renderCell')
  })

  it('accepts hooks at the top of a component', async () => {
    const messages = await lintCase({
      fileName: 'src/features/shows/components/events-cell-component.tsx',
      source: code`
        import { useState } from 'react'

        export const EventsCellComponent = () => {
          const [open] = useState(false)

          return <span>{String(open)}</span>
        }
      `,
    })

    expectClean(messages, 'react-hooks/rules-of-hooks')
  })
})

describe('architecture: dumb component imports', () => {
  const dumb = 'src/features/review/components/review-modal-component.tsx'

  it.each([
    ["import { useAtomValue } from 'jotai'", 'jotai'],
    ["import * as service from '../service'", '../service'],
    ["import { reviewService } from '../services'", '../services'],
    ["import { httpClient } from '#root/lib/http-client'", 'http-client'],
    ["import { reviewAnalytics } from '@pkg/analytics'", '@pkg/analytics'],
    ["import { useNavigate } from '@tanstack/react-router'", 'useNavigate'],
  ])('flags `%s`', async (statement, needle) => {
    const messages = await lintCase({ fileName: dumb, source: `${statement}\n\nexport const x = 1\n` })

    expectFlagged(messages, 'no-restricted-imports', needle)
  })

  it('allows type-only imports and router Link', async () => {
    const messages = await lintCase({
      fileName: dumb,
      source: code`
        import type { Atom } from 'jotai'
        import { Link } from '@tanstack/react-router'

        import type { ReviewState } from '../services'

        export type X = [Atom<ReviewState>, typeof Link]
      `,
    })

    expectClean(messages, 'no-restricted-imports')
  })

  it('still enforces the public-API patterns inside dumb components', async () => {
    const messages = await lintCase({
      fileName: dumb,
      source: "import { x } from '#root/features/other/components/other-component'\n\nexport const y = x\n",
    })

    expectFlagged(messages, 'no-restricted-imports', "feature's public API")
  })

  it('leaves containers free to read state', async () => {
    const messages = await lintCase({
      fileName: 'src/features/review/containers/review-modal-container.tsx',
      source: "import { useAtomValue } from 'jotai'\n\nexport const x = useAtomValue\n",
    })

    expectClean(messages, 'no-restricted-imports')
  })
})

describe('architecture: platform access', () => {
  it('flags raw fetch in a feature and allows it in the http client', async () => {
    const source = "export const get = async () => fetch('/x')\n"

    expectFlagged(
      await lintCase({ fileName: 'src/features/deals/services.ts', source }),
      'no-restricted-globals',
      'http client',
    )
    expectClean(await lintCase({ fileName: 'src/lib/http-client/index.ts', source }), 'no-restricted-globals')
  })

  it('does not touch backend services', async () => {
    const source = "export const get = async () => fetch('/x')\n"

    expectClean(await lintCase({ fileName: 'src/services/deals.ts', source }), 'no-restricted-globals')
  })

  it('flags import.meta.env outside the env module', async () => {
    const source = 'export const api = import.meta.env.VITE_API\n'

    expectFlagged(await lintCase({ fileName: 'src/features/deals/services.ts', source }), 'no-restricted-syntax', 'env')
    expectClean(await lintCase({ fileName: 'src/lib/env.ts', source }), 'no-restricted-syntax')
  })

  it('flags window.location navigation', async () => {
    const messages = await lintCase({
      fileName: 'src/features/redirect/services.ts',
      source: code`
        export const go = (url: string) => {
          window.location.href = url
          window.location.assign(url)
        }
      `,
    })

    expect(only(messages, 'no-restricted-syntax')).toHaveLength(2)
  })

  it('flags React.FC', async () => {
    const messages = await lintCase({
      fileName: 'src/features/calendar/components/calendar-component.tsx',
      source: "import type React from 'react'\n\nexport const CalendarComponent: React.FC = () => null\n",
    })

    expectFlagged(messages, 'no-restricted-syntax', 'React.FC')
  })

  it('flags a component injected as a flat prop', async () => {
    const messages = await lintCase({
      fileName: 'src/features/hotels/components/hotel-view-component.tsx',
      source: code`
        import type { ComponentType } from 'react'

        export interface HotelViewProps {
          Summary: ComponentType<{ id: string }>
        }
      `,
    })

    expectFlagged(messages, 'no-restricted-syntax', '`components` prop')
  })

  it('flags an optional React.ComponentType on a props type alias', async () => {
    const messages = await lintCase({
      fileName: 'src/features/hotels/components/hotel-view-component.tsx',
      source: code`
        import type React from 'react'

        export type HotelViewProps = { Summary?: React.ComponentType | undefined }
      `,
    })

    expectFlagged(messages, 'no-restricted-syntax', '`components` prop')
  })

  it('flags a PascalCase prop typed as `typeof` a component', async () => {
    const messages = await lintCase({
      fileName: 'src/features/packages/containers/packages-details-container.tsx',
      source: code`
        import { FlightsDetailsComponent } from '../components/flights-details-component'

        export interface PackagesDetailsProps {
          FlightsDetails: typeof FlightsDetailsComponent
          schema: typeof FlightsDetailsComponent
        }
      `,
    })

    expectFlagged(messages, 'no-restricted-syntax', '`components` prop')
  })

  it('allows the components bag, slots, render functions and polymorphic `as`', async () => {
    const messages = await lintCase({
      fileName: 'src/features/hotels/components/hotel-view-component.tsx',
      source: code`
        import type { ComponentType, ElementType, ReactNode } from 'react'

        export interface HotelComponents {
          Summary: ComponentType<{ id: string }>
          Gallery: ComponentType
        }

        export interface HotelViewProps {
          components: Pick<HotelComponents, 'Summary'>
          header: ReactNode
          renderFooter: (id: string) => ReactNode
          as?: ElementType
        }

        export interface HotelCardProps {
          components: { Badge: ComponentType }
        }
      `,
    })

    expectClean(messages, 'no-restricted-syntax')
  })

  it("keeps antfu's own restricted syntax", async () => {
    const messages = await lintCase({ fileName: 'src/features/a/types.ts', source: 'export const enum E { A }\n' })

    expect(only(messages, 'no-restricted-syntax')).toHaveLength(1)
  })

  it('appends consumer restrictedSyntax entries', async () => {
    const messages = await lintWith(
      { restrictedSyntax: [{ selector: 'TSInterfaceDeclaration[id.name=/^I[A-Z]/]', message: 'No I prefix' }] },
      'export interface IUser { id: string }\n',
      'src/features/users/types.ts',
    )

    expectFlagged(messages, 'no-restricted-syntax', 'No I prefix')
  })

  it('is dropped with architecture: false', async () => {
    const messages = await lintWith(
      { architecture: false },
      "export const get = async () => fetch('/x')\n",
      'src/features/deals/services.ts',
    )

    expectClean(messages, 'no-restricted-globals')
  })
})

describe('architecture: component modules', () => {
  it('flags a component file that also exports a function', async () => {
    const messages = await lintCase({
      fileName: 'src/features/a/components/a-component.tsx',
      source: code`
        export const AComponent = () => <div />

        export const formatA = (value: string) => value.trim()
      `,
    })

    expectFlagged(messages, 'react-refresh/only-export-components', 'only exports components')
  })

  it('leaves route files alone', async () => {
    const messages = await lintCase({
      fileName: 'src/routes/index.tsx',
      source: code`
        export const loader = () => null

        export const Page = () => <div />
      `,
    })

    expectClean(messages, 'react-refresh/only-export-components')
  })
})

describe('architecture: disable directives', () => {
  it('forbids disabling a boundary rule, even with a reason', async () => {
    const messages = await lintCase({
      fileName: 'src/features/a/containers/a-container.tsx',
      source: code`
        // eslint-disable-next-line boundaries/dependencies -- temp
        import { x } from '#root/features/b'

        export const y = x
      `,
    })

    expectFlagged(messages, 'eslint-comments/no-restricted-disable', 'boundaries/dependencies')
  })

  it('requires a description on any other disable', async () => {
    const source = (comment: string) => `// eslint-disable-next-line no-console${comment}\nconsole.log(1)\n`

    expectFlagged(
      await lintCase({ fileName: 'src/lib/a.ts', source: source('') }),
      'eslint-comments/require-description',
      'description',
    )
    expectClean(
      await lintCase({ fileName: 'src/lib/a.ts', source: source(' -- CLI output') }),
      'eslint-comments/require-description',
    )
  })
})
