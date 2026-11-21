import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

import type { AtlasFlowEdge } from '../types'

type RouteEdgeComponentProps = EdgeProps<AtlasFlowEdge> & { className?: string }

/** The arrowhead is one of the two markers `EdgeMarkersComponent` defines, so its colour follows the theme tokens. */
export const RouteEdgeComponent = (props: RouteEdgeComponentProps) => {
  const { data, className } = props

  const [path] = getBezierPath(props)

  return <BaseEdge className={className} path={path} markerEnd={`url(#atlas-arrow-${data?.source ?? 'local'})`} />
}
