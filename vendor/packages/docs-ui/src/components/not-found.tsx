import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { DefaultNotFound } from 'fumadocs-ui/layouts/home/not-found'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export interface NotFoundProps {
  baseOptions: BaseLayoutProps
}

/**
 * Parameterized 404. The consuming app supplies its own layout options (e.g. nav title)
 * so this stays white-label — no hardcoded brand name.
 */
export const NotFound = (props: NotFoundProps) => {
  const { baseOptions } = props

  return (
    <HomeLayout {...baseOptions}>
      <DefaultNotFound />
    </HomeLayout>
  )
}
