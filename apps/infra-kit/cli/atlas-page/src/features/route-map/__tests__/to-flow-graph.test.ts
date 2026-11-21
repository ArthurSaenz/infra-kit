import { describe, expect, it } from 'vitest'

import { makeSnapshot } from '../../../testing/snapshot-fixture'
import {
  COLUMN_X,
  canvasExtent,
  carryMeasurements,
  cloudHostname,
  panExtent,
  pathNodeId,
  siteNodeId,
  toFlowGraph,
} from '../services/main'
import type { AtlasFlowNode } from '../types'

const nodeById = (nodes: AtlasFlowNode[], id: string): AtlasFlowNode => {
  const node = nodes.find((candidate) => {
    return candidate.id === id
  })

  if (node === undefined) throw new Error(`no node ${id}`)

  return node
}

describe('toFlowGraph', () => {
  it('lays sites, paths and targets out in three fixed columns', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    const columnOf = (type: string): number[] => {
      return [
        ...new Set(
          nodes
            .filter((node) => {
              return node.type === type
            })
            .map((node) => {
              return node.position.x
            }),
        ),
      ]
    }

    expect(columnOf('site')).toEqual([COLUMN_X.site])
    expect(columnOf('path')).toEqual([COLUMN_X.path])
    expect([...columnOf('backend'), ...columnOf('cloud')]).toEqual([COLUMN_X.target, COLUMN_X.target])
  })

  it('shows every running site and highlights only the viewer', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    expect(nodeById(nodes, siteNodeId('shop/ui')).data).toMatchObject({ isViewer: true })
    expect(nodeById(nodes, siteNodeId('admin/ui')).data).toMatchObject({ isViewer: false })
  })

  it('highlights nothing when the snapshot names no viewer', () => {
    const { nodes, edges } = toFlowGraph(makeSnapshot({ viewer: { siteId: null } }))

    expect(
      nodes.some((node) => {
        return node.data.isViewer === true
      }),
    ).toBe(false)
    expect(
      edges.some((edge) => {
        return edge.data?.isViewer === true
      }),
    ).toBe(false)
  })

  it('colours every edge by its route source', () => {
    const { edges } = toFlowGraph(makeSnapshot())

    const toPay = edges.find((edge) => {
      return edge.target === 'cloud:pay'
    })

    const toShopApi = edges.find((edge) => {
      return edge.target === 'backend:shop/api'
    })

    expect(toPay?.className).toContain('route-edge--cloud')
    expect(toShopApi?.className).toContain('route-edge--local')
  })

  it('animates only edges into a live target', () => {
    const { edges } = toFlowGraph(makeSnapshot())

    const animated = (target: string): boolean | undefined => {
      return edges.find((edge) => {
        return edge.target === target
      })?.animated
    }

    expect(animated('backend:shop/api')).toBe(true)
    expect(animated('cloud:pay')).toBe(true)
    expect(animated('backend:admin/api')).toBe(false)
  })

  it('puts a human-readable reason on each route and warns only on differs / user-proxy', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    const pathData = (siteId: string, path: string) => {
      return nodeById(nodes, pathNodeId(siteId, path)).data
    }

    expect(pathData('shop/ui', '/api')).toMatchObject({ reasonText: 'served by a local backend', servedWarning: null })
    expect(pathData('shop/ui', '/auth').servedWarning).toBe('vite serves a different target')
    expect(pathData('shop/ui', '/pay').servedWarning).toBe('a hand-written proxy wins')
    expect(pathData('admin/ui', '/search')).toMatchObject({
      reasonText: 'cloud URL env is not loaded',
      servedWarning: null,
    })
  })

  it('draws no target edge for a route with no target', () => {
    const { edges } = toFlowGraph(makeSnapshot())

    expect(
      edges.filter((edge) => {
        return edge.source === pathNodeId('admin/ui', '/search')
      }),
    ).toEqual([])
  })

  it('passes the owner through so another runner’s backend can be drawn dashed', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    expect(nodeById(nodes, 'backend:auth/api').data).toMatchObject({ backend: { owner: 'other-runner' } })
  })

  it('reduces a cloud target to its hostname', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    expect(nodeById(nodes, 'cloud:pay').data).toEqual({ host: 'pay.staging.example.com' })
    expect(cloudHostname('api.example.com')).toBe('api.example.com')
  })

  it('keeps a dragged node where the viewer left it across polls', () => {
    const moved = { x: 999, y: -40 }
    const id = 'backend:shop/api'
    const next = makeSnapshot({ revision: 'rev-2' })
    const { nodes } = toFlowGraph(next, new Map([[id, moved]]))

    expect(nodeById(nodes, id).position).toEqual(moved)
    expect(nodeById(nodes, siteNodeId('shop/ui')).position).toEqual(
      nodeById(toFlowGraph(next).nodes, siteNodeId('shop/ui')).position,
    )
  })

  it('stacks the targets without overlap', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    const ys = nodes
      .filter((node) => {
        return node.type === 'backend' || node.type === 'cloud'
      })
      .map((node) => {
        return node.position.y
      })
      .sort((a, b) => {
        return a - b
      })

    for (const [index, y] of ys.entries()) {
      if (index > 0) expect(y - ys[index - 1]!).toBeGreaterThanOrEqual(100)
    }
  })
})

describe('carryMeasurements', () => {
  it('keeps a measured size on the rebuilt node with the same id', () => {
    const [first] = toFlowGraph(makeSnapshot()).nodes
    const previous = [{ ...first!, measured: { width: 300, height: 40 } }]
    const [rebuilt] = carryMeasurements(toFlowGraph(makeSnapshot()).nodes, previous)

    expect(rebuilt?.measured).toEqual({ width: 300, height: 40 })
  })
})

describe('canvasExtent', () => {
  it('wraps the layout with the same margin on every side', () => {
    const { nodes } = toFlowGraph(makeSnapshot())
    const [[left, top], [right, bottom]] = canvasExtent(nodes, [])

    const xs = nodes.map((node) => {
      return node.position.x
    })

    const ys = nodes.map((node) => {
      return node.position.y
    })

    expect(Math.min(...xs) - left).toBe(Math.min(...ys) - top)
    expect(right).toBeGreaterThan(Math.max(...xs))
    expect(bottom).toBeGreaterThan(Math.max(...ys))
  })

  it('does not grow when a card is dragged away from its laid-out place', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    const dragged = nodes.map((node) => {
      return { ...node, position: { x: node.position.x + 5000, y: node.position.y + 5000 } }
    })

    expect(canvasExtent(nodes, dragged)).toEqual(canvasExtent(nodes, []))
  })

  it('uses the measured size of a card once React Flow has one', () => {
    const { nodes } = toFlowGraph(makeSnapshot())

    const huge = nodes.map((node) => {
      return { ...node, measured: { width: 2000, height: 2000 } }
    })

    expect(canvasExtent(nodes, huge)[1][0]).toBeGreaterThan(canvasExtent(nodes, [])[1][0])
  })
})

describe('panExtent', () => {
  const box: [[number, number], [number, number]] = [
    [0, 0],
    [1000, 600],
  ]

  it('lets a diagram smaller than the window slide to either edge of it', () => {
    expect(panExtent(box, { width: 1500, height: 900 })).toEqual([
      [-500, -300],
      [1500, 900],
    ])
  })

  it('stops a diagram larger than the window at its own edges', () => {
    expect(panExtent(box, { width: 400, height: 300 })).toEqual(box)
  })
})
