import type { Node, NodeProps } from '@xyflow/react'

import { cx } from '../../../lib/cx'
import type { ColumnNodeData } from '../types'

type ColumnNodeComponentProps = NodeProps<Node<ColumnNodeData, 'column'>> & { className?: string }

export const ColumnNodeComponent = (props: ColumnNodeComponentProps) => {
  const { data, className } = props

  return (
    <header className={cx('column-node', className)}>
      <span className="column-node__title">{data.title}</span>
      <span className="column-node__caption">{data.caption}</span>
    </header>
  )
}
