import { describe, expect, it } from 'vitest'

import { buildCmuxLayout } from 'src/dev/cmux-layout'
import type { CmuxLayoutNode, CmuxPaneLeaf, CmuxSplitNode } from 'src/dev/cmux-layout'

/**
 * Pure layout construction for `infra-kit dev --cmux`. Each command becomes one
 * pane leaf; N commands tile into a balanced binary tree whose split direction
 * alternates by depth. No shell, no fs — the tiling math is asserted directly.
 */

const isLeaf = (node: CmuxLayoutNode): node is CmuxPaneLeaf => {
  return 'pane' in node
}

const isSplit = (node: CmuxLayoutNode): node is CmuxSplitNode => {
  return 'children' in node
}

/** Collect every leaf command in left-to-right (in-order) traversal order. */
const collectCommands = (node: CmuxLayoutNode): string[] => {
  if (isLeaf(node)) {
    return node.pane.surfaces.map((s) => {
      return s.command
    })
  }

  return [...collectCommands(node.children[0]), ...collectCommands(node.children[1])]
}

const leafCount = (node: CmuxLayoutNode): number => {
  return isLeaf(node) ? 1 : leafCount(node.children[0]) + leafCount(node.children[1])
}

describe('buildCmuxLayout', () => {
  it('throws on an empty command list', () => {
    expect(() => {
      return buildCmuxLayout([])
    }).toThrow(/at least one command/)
  })

  it('returns a bare leaf for a single command', () => {
    const layout = buildCmuxLayout(['cmd-a'])

    expect(isLeaf(layout)).toBe(true)
    expect(layout).toEqual({ pane: { surfaces: [{ type: 'terminal', command: 'cmd-a' }] } })
  })

  it('splits two commands horizontally at 0.5 with two leaves', () => {
    const layout = buildCmuxLayout(['cmd-a', 'cmd-b'])

    expect(isSplit(layout)).toBe(true)
    const split = layout as CmuxSplitNode

    expect(split.direction).toBe('horizontal')
    expect(split.split).toBe(0.5)
    expect(isLeaf(split.children[0])).toBe(true)
    expect(isLeaf(split.children[1])).toBe(true)
    expect(collectCommands(layout)).toEqual(['cmd-a', 'cmd-b'])
  })

  it('nests one side into a split node for three commands', () => {
    const layout = buildCmuxLayout(['cmd-a', 'cmd-b', 'cmd-c']) as CmuxSplitNode

    // ceil(3/2) = 2 on the left (a split of two), 1 on the right (a bare leaf).
    expect(layout.split).toBeCloseTo(0.67, 2)
    expect(isSplit(layout.children[0])).toBe(true)
    expect(isLeaf(layout.children[1])).toBe(true)
    expect(collectCommands(layout)).toEqual(['cmd-a', 'cmd-b', 'cmd-c'])
  })

  it('alternates split direction by depth (root horizontal, children vertical)', () => {
    const layout = buildCmuxLayout(['a', 'b', 'c', 'd']) as CmuxSplitNode

    expect(layout.direction).toBe('horizontal')
    expect((layout.children[0] as CmuxSplitNode).direction).toBe('vertical')
    expect((layout.children[1] as CmuxSplitNode).direction).toBe('vertical')
  })

  it('preserves one leaf per command, in order, for a larger set', () => {
    const commands = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const layout = buildCmuxLayout(commands)

    expect(leafCount(layout)).toBe(commands.length)
    expect(collectCommands(layout)).toEqual(commands)
  })
})
