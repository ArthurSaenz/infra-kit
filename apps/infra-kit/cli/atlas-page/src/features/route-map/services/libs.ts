import type { XYPosition } from '@xyflow/react'

import type {
  AtlasBackend,
  AtlasReason,
  AtlasRoute,
  AtlasServed,
  AtlasSite,
  AtlasSnapshot,
} from '../../../lib/atlas-contract'
import { cx } from '../../../lib/cx'
import type { AtlasFlowEdge, AtlasFlowGraph, AtlasFlowNode, RouteEdgeData } from '../types'

/** x of each column's left edge; the node widths in app.css are sized to leave a gutter for the edges. */
export const COLUMN_X = { site: 0, path: 380, target: 800 } as const

const HEADER_Y = -84
const PATH_STEP = 84
const SITE_STEP = 124
const GROUP_GAP = 36
const TARGET_STEP = 108

const REASON_TEXT: Readonly<Record<AtlasReason, string>> = {
  local: 'served by a local backend',
  starting: 'local backend is starting',
  'cloud-only': 'cloud only: no local option',
  'not-running': 'not running locally, fell back',
  'launched-failed': 'launched here and failed',
  'local-unserved': 'pinned local, nothing serves it',
  'cloud-unset': 'cloud URL env is not loaded',
}

const SERVED_WARNING: Readonly<Record<AtlasServed, string | null>> = {
  match: null,
  unknown: null,
  differs: 'vite serves a different target',
  'user-proxy': 'a hand-written proxy wins',
}

export const reasonText = (reason: AtlasReason): string => {
  return REASON_TEXT[reason]
}

export const siteNodeId = (siteId: string): string => {
  return `site:${siteId}`
}

export const pathNodeId = (siteId: string, path: string): string => {
  return `path:${siteId}:${path}`
}

export const targetNodeId = (target: NonNullable<AtlasRoute['target']>): string => {
  return `${target.kind}:${target.id}`
}

interface PlacedPath {
  siteId: string
  route: AtlasRoute
  y: number
}

/** Stacks every site's paths in one column; a site sits level with the first of its own paths. */
const placeSitesAndPaths = (sites: AtlasSite[]): { siteY: Map<string, number>; paths: PlacedPath[] } => {
  const siteY = new Map<string, number>()
  const paths: PlacedPath[] = []
  let cursor = 0

  for (const site of sites) {
    siteY.set(site.id, cursor)
    for (const [index, route] of site.routes.entries()) {
      paths.push({ siteId: site.id, route, y: cursor + index * PATH_STEP })
    }
    cursor += Math.max(site.routes.length * PATH_STEP, SITE_STEP) + GROUP_GAP
  }

  return { siteY, paths }
}

/**
 * Each target goes as near as it can to the mean height of the paths pointing at it, which keeps the
 * edges short and mostly uncrossed; unreferenced targets queue up underneath.
 */
const placeTargets = (targetIds: string[], paths: PlacedPath[]): Map<string, number> => {
  const wanted = new Map<string, number[]>()

  for (const placed of paths) {
    if (placed.route.target === null) continue
    const id = targetNodeId(placed.route.target)

    wanted.set(id, [...(wanted.get(id) ?? []), placed.y])
  }

  const mean = (id: string): number => {
    const ys = wanted.get(id)

    return ys === undefined
      ? Number.POSITIVE_INFINITY
      : ys.reduce((sum, y) => {
          return sum + y
        }, 0) / ys.length
  }

  const ordered = [...targetIds].sort((a, b) => {
    return mean(a) - mean(b)
  })

  const placed = new Map<string, number>()
  let floor = Number.NEGATIVE_INFINITY

  for (const id of ordered) {
    const want = mean(id)
    const y = Math.max(Number.isFinite(want) ? want : floor, floor)
    const settled = Number.isFinite(y) ? y : 0

    placed.set(id, settled)
    floor = settled + TARGET_STEP
  }

  return placed
}

const columnNodes = (): AtlasFlowNode[] => {
  const column = (id: string, x: number, title: string, caption: string): AtlasFlowNode => {
    return {
      id,
      type: 'column',
      position: { x, y: HEADER_Y },
      data: { title, caption },
      draggable: false,
      selectable: false,
    }
  }

  return [
    column('column:sites', COLUMN_X.site, 'Sites', 'every running app'),
    column('column:paths', COLUMN_X.path, 'Paths', 'proxy routes per site'),
    column('column:targets', COLUMN_X.target, 'Targets', 'backends and clouds'),
  ]
}

const routeEdge = (id: string, from: string, to: string, data: RouteEdgeData, animated: boolean): AtlasFlowEdge => {
  return {
    id,
    source: from,
    target: to,
    type: 'route',
    animated,
    selectable: false,
    className: cx('route-edge', `route-edge--${data.source}`, data.isViewer && 'is-viewer'),
    data,
  }
}

/** A live local edge animates; a cloud edge or one into a backend that is not up stays still. */
const isFlowing = (route: AtlasRoute, backends: ReadonlyMap<string, AtlasBackend>): boolean => {
  if (route.target === null) return false
  if (route.target.kind === 'cloud') return true

  return backends.get(route.target.id)?.health === 'ok'
}

/**
 * The pure snapshot → React Flow translation. `positions` holds where the viewer dragged a node; it
 * outranks the computed layout so a poll never snaps a moved node back.
 */
export const toFlowGraph = (
  snapshot: AtlasSnapshot,
  positions: ReadonlyMap<string, XYPosition> = new Map(),
): AtlasFlowGraph => {
  const viewerId = snapshot.viewer.siteId

  const backends = new Map(
    snapshot.backends.map((backend) => {
      return [backend.id, backend]
    }),
  )

  const clouds = new Map(
    snapshot.clouds.map((cloud) => {
      return [cloud.id, cloud]
    }),
  )

  const { siteY, paths } = placeSitesAndPaths(snapshot.sites)

  const targetIds = [
    ...snapshot.backends.map((backend) => {
      return targetNodeId({ kind: 'backend', id: backend.id })
    }),
    ...snapshot.clouds.map((cloud) => {
      return targetNodeId({ kind: 'cloud', id: cloud.id })
    }),
  ]

  const targetY = placeTargets(targetIds, paths)

  const at = (id: string, x: number, y: number): XYPosition => {
    return positions.get(id) ?? { x, y }
  }

  const nodes: AtlasFlowNode[] = columnNodes()
  const edges: AtlasFlowEdge[] = []

  for (const site of snapshot.sites) {
    const id = siteNodeId(site.id)

    nodes.push({
      id,
      type: 'site',
      position: at(id, COLUMN_X.site, siteY.get(site.id) ?? 0),
      data: { site, isViewer: site.id === viewerId },
    })
  }

  for (const { siteId, route, y } of paths) {
    const id = pathNodeId(siteId, route.path)
    const isViewer = siteId === viewerId

    nodes.push({
      id,
      type: 'path',
      position: at(id, COLUMN_X.path, y),
      data: { route, isViewer, reasonText: reasonText(route.reason), servedWarning: SERVED_WARNING[route.served] },
    })
    edges.push(
      routeEdge(`edge:${siteNodeId(siteId)}->${id}`, siteNodeId(siteId), id, { source: route.source, isViewer }, false),
    )

    const target = route.target
    const known = target !== null && (target.kind === 'backend' ? backends.has(target.id) : clouds.has(target.id))

    if (!known) continue

    const targetId = targetNodeId(target)

    edges.push(
      routeEdge(
        `edge:${id}->${targetId}`,
        id,
        targetId,
        { source: route.source, isViewer },
        isFlowing(route, backends),
      ),
    )
  }

  for (const backend of snapshot.backends) {
    const id = targetNodeId({ kind: 'backend', id: backend.id })

    nodes.push({ id, type: 'backend', position: at(id, COLUMN_X.target, targetY.get(id) ?? 0), data: { backend } })
  }

  for (const cloud of snapshot.clouds) {
    const id = targetNodeId({ kind: 'cloud', id: cloud.id })

    nodes.push({
      id,
      type: 'cloud',
      position: at(id, COLUMN_X.target, targetY.get(id) ?? 0),
      data: { host: cloudHostname(cloud.host) },
    })
  }

  return { nodes, edges }
}

/** The snapshot may carry a full origin; the page promises a bare hostname for every cloud target. */
export const cloudHostname = (host: string): string => {
  try {
    return new URL(host.includes('://') ? host : `https://${host}`).hostname
  } catch {
    return host
  }
}

/**
 * React Flow keeps a node's measured size on the node object itself; a node rebuilt from a fresh
 * snapshot without it is hidden until re-measured, which would blink the whole diagram on every poll.
 */
export const carryMeasurements = (next: AtlasFlowNode[], previous: readonly AtlasFlowNode[]): AtlasFlowNode[] => {
  const measured = new Map(
    previous.map((node) => {
      return [node.id, node.measured]
    }),
  )

  return next.map((node) => {
    const size = measured.get(node.id)

    return size === undefined ? node : { ...node, measured: size }
  })
}

// Until React Flow measures a node, the widest and tallest card in app.css stand in for its size.
const UNMEASURED = { width: 340, height: 120 }
const CANVAS_MARGIN = 96

/**
 * The box the viewport and the cards are held inside: the laid-out diagram plus a margin. `layout` is the
 * untouched layout, not the dragged nodes, so dragging a card to the edge cannot push the box outwards.
 */
export const canvasExtent = (
  layout: readonly AtlasFlowNode[],
  measured: readonly AtlasFlowNode[],
): [[number, number], [number, number]] => {
  const sizes = new Map(
    measured.map((node) => {
      return [node.id, node.measured]
    }),
  )

  const boxes = layout.map((node) => {
    const size = sizes.get(node.id)

    return {
      left: node.position.x,
      top: node.position.y,
      right: node.position.x + (size?.width ?? UNMEASURED.width),
      bottom: node.position.y + (size?.height ?? UNMEASURED.height),
    }
  })

  if (boxes.length === 0)
    return [
      [-CANVAS_MARGIN, -CANVAS_MARGIN],
      [CANVAS_MARGIN, CANVAS_MARGIN],
    ]

  const lefts = boxes.map((box) => {
    return box.left
  })

  const tops = boxes.map((box) => {
    return box.top
  })

  const rights = boxes.map((box) => {
    return box.right
  })

  const bottoms = boxes.map((box) => {
    return box.bottom
  })

  return [
    [Math.min(...lefts) - CANVAS_MARGIN, Math.min(...tops) - CANVAS_MARGIN],
    [Math.max(...rights) + CANVAS_MARGIN, Math.max(...bottoms) + CANVAS_MARGIN],
  ]
}

/**
 * How far the viewport may travel, in flow units. A diagram smaller than the window may slide anywhere
 * inside it; a larger one pans until its `box` edge shows. Neither can leave the window.
 */
export const panExtent = (
  box: [[number, number], [number, number]],
  viewport: { width: number; height: number },
): [[number, number], [number, number]] => {
  const [[left, top], [right, bottom]] = box

  return [
    [Math.min(left, right - viewport.width), Math.min(top, bottom - viewport.height)],
    [Math.max(right, left + viewport.width), Math.max(bottom, top + viewport.height)],
  ]
}
