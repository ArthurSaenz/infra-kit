import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

import { cx } from '../../../lib/cx'
import type { PathNodeData } from '../types'

type PathNodeComponentProps = NodeProps<Node<PathNodeData, 'path'>> & { className?: string }

export const PathNodeComponent = (props: PathNodeComponentProps) => {
  const { data, className } = props

  const { route, isViewer, reasonText, servedWarning } = data

  return (
    <article
      className={cx(
        'atlas-node path-node',
        `path-node--${route.source}`,
        isViewer && 'is-viewer',
        route.target === null && 'is-orphan',
        className,
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="atlas-node__row">
        <code className="path-node__path">{route.path}</code>
        {servedWarning === null ? null : (
          <span className="badge badge--warn" title={servedWarning}>
            <span aria-hidden="true">▲</span> {route.served}
          </span>
        )}
      </div>
      <div className="path-node__reason">
        <span className={`source-tag source-tag--${route.source}`}>{route.source}</span>
        <span>{reasonText}</span>
      </div>
      {servedWarning === null ? null : <div className="path-node__warning">{servedWarning}</div>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  )
}
