import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useStore,
} from '@xyflow/react'
import type { EdgeTypes, NodeChange, NodeTypes, XYPosition } from '@xyflow/react'
import { useCallback, useMemo, useState } from 'react'

import type { AtlasSnapshot } from '../../../lib/atlas-contract'
import { cx } from '../../../lib/cx'
import { BackendNodeComponent } from '../components/backend-node-component'
import { CloudNodeComponent } from '../components/cloud-node-component'
import { ColumnNodeComponent } from '../components/column-node-component'
import { EdgeMarkersComponent } from '../components/edge-markers-component'
import { PathNodeComponent } from '../components/path-node-component'
import { RouteEdgeComponent } from '../components/route-edge-component'
import { SiteNodeComponent } from '../components/site-node-component'
import { canvasExtent, carryMeasurements, panExtent, toFlowGraph } from '../services/main'
import type { AtlasFlowNode, RouteMapContainerProps } from '../types'

export const RouteMapContainer = (props: RouteMapContainerProps) => {
  const { snapshot, isDisconnected, isStale } = props

  if (snapshot === null) {
    // No snapshot yet is loading; no snapshot and a runner that stopped answering is the error.
    return <p className="atlas-empty">{isDisconnected ? 'no runner answered' : 'reaching the runner…'}</p>
  }

  return (
    <ReactFlowProvider>
      <RouteMapCanvas snapshot={snapshot} isStale={isStale} />
    </ReactFlowProvider>
  )
}

interface RouteMapCanvasProps {
  snapshot: AtlasSnapshot
  isStale: boolean
}

const RouteMapCanvas = (props: RouteMapCanvasProps) => {
  const { snapshot, isStale } = props

  const [dragged, setDragged] = useState<ReadonlyMap<string, XYPosition>>(() => {
    return new Map()
  })

  const [nodes, setNodes] = useState<AtlasFlowNode[]>(() => {
    return toFlowGraph(snapshot).nodes
  })

  const [shown, setShown] = useState(snapshot)

  // A new snapshot rebuilds the nodes during render (React's "adjust state on prop change"), so the
  // poll that changed it and the redraw land in one commit.
  if (shown !== snapshot) {
    setShown(snapshot)
    setNodes((previous) => {
      return carryMeasurements(toFlowGraph(snapshot, dragged).nodes, previous)
    })
  }

  const layout = useMemo(() => {
    return toFlowGraph(snapshot)
  }, [snapshot])

  const extent = useMemo(() => {
    return canvasExtent(layout.nodes, nodes)
  }, [layout, nodes])

  const viewportWidth = useStore((store) => {
    return store.width / store.transform[2]
  })

  const viewportHeight = useStore((store) => {
    return store.height / store.transform[2]
  })

  const pan = useMemo(() => {
    return panExtent(extent, { width: viewportWidth, height: viewportHeight })
  }, [extent, viewportWidth, viewportHeight])

  const onNodesChange = useCallback((changes: NodeChange<AtlasFlowNode>[]) => {
    setNodes((previous) => {
      return applyNodeChanges(changes, previous)
    })

    const moves = changes.flatMap((change) => {
      return change.type === 'position' && change.position !== undefined ? [[change.id, change.position] as const] : []
    })

    if (moves.length === 0) return

    setDragged((previous) => {
      return new Map([...previous, ...moves])
    })
  }, [])

  return (
    <div className={cx('atlas-canvas', isStale && 'is-disconnected')}>
      <EdgeMarkersComponent />
      <ReactFlow<AtlasFlowNode>
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        translateExtent={pan}
        nodeExtent={extent}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
        <MiniMap pannable zoomable nodeClassName={minimapClass} maskColor="var(--minimap-mask)" />
      </ReactFlow>
    </div>
  )
}

const FIT_VIEW = { padding: 0.12 }

const NODE_TYPES: NodeTypes = {
  column: ColumnNodeComponent,
  site: SiteNodeComponent,
  path: PathNodeComponent,
  backend: BackendNodeComponent,
  cloud: CloudNodeComponent,
}

const EDGE_TYPES: EdgeTypes = { route: RouteEdgeComponent }

const minimapClass = (node: AtlasFlowNode): string => {
  return `minimap-node minimap-node--${node.type ?? 'unknown'}`
}
