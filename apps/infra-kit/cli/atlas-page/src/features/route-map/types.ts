import type { Edge, Node } from '@xyflow/react'

import type { AtlasBackend, AtlasRoute, AtlasSite, AtlasSnapshot } from '../../lib/atlas-contract'

export type RouteSource = AtlasRoute['source']

export interface ColumnNodeData extends Record<string, unknown> {
  title: string
  caption: string
}

export interface SiteNodeData extends Record<string, unknown> {
  site: AtlasSite
  isViewer: boolean
}

export interface PathNodeData extends Record<string, unknown> {
  route: AtlasRoute
  isViewer: boolean
  reasonText: string
  /** Set only when what the viewer's vite serves disagrees with the runner's plan. */
  servedWarning: string | null
}

export interface BackendNodeData extends Record<string, unknown> {
  backend: AtlasBackend
}

export interface CloudNodeData extends Record<string, unknown> {
  host: string
}

export type AtlasFlowNode =
  | Node<ColumnNodeData, 'column'>
  | Node<SiteNodeData, 'site'>
  | Node<PathNodeData, 'path'>
  | Node<BackendNodeData, 'backend'>
  | Node<CloudNodeData, 'cloud'>

export interface RouteEdgeData extends Record<string, unknown> {
  source: RouteSource
  isViewer: boolean
}

export type AtlasFlowEdge = Edge<RouteEdgeData>

export interface AtlasFlowGraph {
  nodes: AtlasFlowNode[]
  edges: AtlasFlowEdge[]
}

export interface RouteMapContainerProps {
  /** `null` until the runner has answered once. */
  snapshot: AtlasSnapshot | null
  /** The runner stopped answering: with no snapshot it is the error state. */
  isDisconnected: boolean
  /** The drawn snapshot is not the runner's current one, so the canvas is dimmed. */
  isStale: boolean
}
