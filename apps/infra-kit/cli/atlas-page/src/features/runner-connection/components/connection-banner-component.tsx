import { cx } from '../../../lib/cx'
import { formatClock } from '../../../lib/format-clock'
import type { ConnectionBannerComponentProps } from '../types'

export const ConnectionBannerComponent = (props: ConnectionBannerComponentProps) => {
  const { status, lastUpdate, className } = props

  if (status === 'disconnected') {
    const last = lastUpdate === null ? 'never' : formatClock(lastUpdate)

    return (
      <div className={cx('status-banner status-banner--down', className)} role="status">
        <span className="status-banner__pulse" aria-hidden="true" />
        runner disconnected · last update {last}
      </div>
    )
  }

  if (status === 'outdated') {
    return (
      <div className={cx('status-banner status-banner--outdated', className)} role="status">
        infra-kit was updated while this page was open · reload to see the current run
      </div>
    )
  }

  return null
}
