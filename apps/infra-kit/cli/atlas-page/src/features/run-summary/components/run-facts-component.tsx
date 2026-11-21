import { cx } from '../../../lib/cx'
import type { RunFactsComponentProps } from '../types'

export const RunFactsComponent = (props: RunFactsComponentProps) => {
  const { facts, className } = props

  return (
    <span className={cx('atlas-header__facts', className)}>
      <span>pid {facts.pid}</span>
      <span aria-hidden="true">·</span>
      <span>
        {facts.siteCount} sites, {facts.backendCount} backends
      </span>
      {facts.checkedAt === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span>checked {facts.checkedAt}</span>
        </>
      )}
    </span>
  )
}
