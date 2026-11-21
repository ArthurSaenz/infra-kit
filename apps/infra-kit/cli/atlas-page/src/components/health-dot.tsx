import type { AtlasBackend } from '../lib/atlas-contract'

interface HealthDotProps {
  health: AtlasBackend['health']
}

export const HealthDot = (props: HealthDotProps) => {
  const { health } = props

  return (
    <span className={`health health--${health}`} title={`health: ${HEALTH_LABEL[health]}`}>
      <span className="health__dot" aria-hidden="true" />
      <span className="health__label">{HEALTH_LABEL[health]}</span>
    </span>
  )
}

const HEALTH_LABEL: Readonly<Record<HealthDotProps['health'], string>> = {
  ok: 'up',
  down: 'down',
  starting: 'starting',
  unverified: 'unverified',
  unknown: 'no probe',
}
