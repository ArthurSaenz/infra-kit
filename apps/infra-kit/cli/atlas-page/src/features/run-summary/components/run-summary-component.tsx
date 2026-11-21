import { LogLink } from '../../../components/log-link'
import { cx } from '../../../lib/cx'
import type { RunSummaryComponentProps } from '../types'
import { RunFactsComponent } from './run-facts-component'

export const RunSummaryComponent = (props: RunSummaryComponentProps) => {
  const { facts, logLinks, className } = props

  return (
    <header className={cx('atlas-header', className)}>
      <div className="atlas-header__brand">
        <svg className="atlas-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="4" cy="6" r="2.5" />
          <circle cx="12" cy="12" r="2.5" />
          <circle cx="20" cy="18" r="2.5" />
          <path d="M6 7 L10 11 M14 13 L18 17" />
        </svg>
        <h1 className="atlas-header__title">atlas</h1>
        {facts === null ? null : <RunFactsComponent facts={facts} />}
      </div>
      <ul className="legend" aria-label="Legend">
        <li className="legend__item legend__item--local">local</li>
        <li className="legend__item legend__item--cloud">cloud</li>
        <li className="legend__item legend__item--warn">served differs</li>
        <li className="legend__item legend__item--foreign">other runner</li>
      </ul>
      {logLinks.length === 0 ? null : (
        <nav className="atlas-header__logs" aria-label="Run logs">
          <span className="atlas-header__logs-label">logs</span>
          {logLinks.map((link) => {
            return <LogLink key={link.label} link={link} />
          })}
        </nav>
      )}
    </header>
  )
}
