import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

import { cx } from '../../../lib/cx'
import type { CloudNodeData } from '../types'

type CloudNodeComponentProps = NodeProps<Node<CloudNodeData, 'cloud'>> & { className?: string }

export const CloudNodeComponent = (props: CloudNodeComponentProps) => {
  const { data, className } = props

  return (
    <article className={cx('atlas-node target-node cloud-node', className)}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="atlas-node__row">
        <span className="source-tag source-tag--cloud">cloud</span>
      </div>
      <div className="atlas-node__host cloud-node__host">{data.host}</div>
    </article>
  )
}
