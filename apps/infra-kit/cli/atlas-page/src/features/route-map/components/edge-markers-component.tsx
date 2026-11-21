import { cx } from '../../../lib/cx'

interface EdgeMarkersComponentProps {
  className?: string
}

/** Defined once for the page: React Flow's own markers take a literal colour, which a theme cannot swap. */
export const EdgeMarkersComponent = (props: EdgeMarkersComponentProps) => {
  const { className } = props

  return (
    <svg className={cx('edge-markers', className)} aria-hidden="true" focusable="false">
      <defs>
        {(['local', 'cloud'] as const).map((source) => {
          return (
            <marker
              key={source}
              id={`atlas-arrow-${source}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path className={`edge-marker edge-marker--${source}`} d="M0 0 L10 5 L0 10 z" />
            </marker>
          )
        })}
      </defs>
    </svg>
  )
}
