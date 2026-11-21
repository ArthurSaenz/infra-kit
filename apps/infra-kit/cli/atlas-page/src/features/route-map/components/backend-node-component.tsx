import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

import { HealthDot } from '../../../components/health-dot'
import { LogLink } from '../../../components/log-link'
import { cx } from '../../../lib/cx'
import { serviceLogLink } from '../../../lib/log-links'
import type { BackendNodeData } from '../types'

type BackendNodeComponentProps = NodeProps<Node<BackendNodeData, 'backend'>> & { className?: string }

export const BackendNodeComponent = (props: BackendNodeComponentProps) => {
  const { data, className } = props

  const { backend } = data
  const foreign = backend.owner === 'other-runner'

  return (
    <article
      className={cx(
        'atlas-node target-node backend-node',
        `health-edge--${backend.health}`,
        foreign && 'is-foreign',
        className,
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="atlas-node__row">
        <span className="atlas-node__name">{backend.id}</span>
        <HealthDot health={backend.health} />
      </div>
      <div className="atlas-node__host">{backend.host ?? 'no host yet'}</div>
      <div className="atlas-node__meta">
        <span className="atlas-node__package">{foreign ? 'another runner' : (backend.app ?? 'this run')}</span>
        <LogLink link={serviceLogLink(backend.log)} />
      </div>
    </article>
  )
}
