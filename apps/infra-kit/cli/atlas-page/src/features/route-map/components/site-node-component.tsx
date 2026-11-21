import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

import { HealthDot } from '../../../components/health-dot'
import { LogLink } from '../../../components/log-link'
import { cx } from '../../../lib/cx'
import { serviceLogLink } from '../../../lib/log-links'
import type { SiteNodeData } from '../types'

type SiteNodeComponentProps = NodeProps<Node<SiteNodeData, 'site'>> & { className?: string }

export const SiteNodeComponent = (props: SiteNodeComponentProps) => {
  const { data, className } = props

  const { site, isViewer } = data

  return (
    <article className={cx('atlas-node site-node', isViewer && 'is-viewer', className)}>
      {isViewer ? <span className="site-node__here">you are here</span> : null}
      <div className="atlas-node__row">
        <span className="atlas-node__name">{site.app}</span>
        <HealthDot health={site.health} />
      </div>
      <div className="atlas-node__host">{site.host ?? 'no host yet'}</div>
      <div className="atlas-node__meta">
        <span className="atlas-node__package">{site.packageName}</span>
        <LogLink link={serviceLogLink(site.log)} />
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  )
}
