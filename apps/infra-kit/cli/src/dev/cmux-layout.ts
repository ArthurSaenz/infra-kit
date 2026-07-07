/**
 * Pure cmux layout construction for `infra-kit dev --cmux`.
 *
 * Turns a flat list of per-pane shell commands into the recursive binary-tree
 * layout JSON cmux's `new-workspace --layout` consumes. Side-effect free (no fs,
 * no cwd, no shell) so the tiling math stays unit-testable in isolation.
 */

/** A single terminal surface inside a pane, running one shell command. */
export interface CmuxTerminalSurface {
  type: 'terminal'
  command: string
}

/** A leaf node: one pane holding one or more terminal surfaces. */
export interface CmuxPaneLeaf {
  pane: {
    surfaces: CmuxTerminalSurface[]
  }
}

/** An internal node: a horizontal/vertical split into exactly two children. */
export interface CmuxSplitNode {
  direction: 'horizontal' | 'vertical'
  split: number
  children: [CmuxLayoutNode, CmuxLayoutNode]
}

/** Either a pane leaf or a two-way split — the recursive layout tree. */
export type CmuxLayoutNode = CmuxPaneLeaf | CmuxSplitNode

/** Wrap a single command in a bare pane leaf. */
const makeLeaf = (command: string): CmuxPaneLeaf => {
  return { pane: { surfaces: [{ type: 'terminal', command }] } }
}

/**
 * Recursively split `commands` into a balanced binary tree: the left half takes
 * `Math.ceil(n / 2)` commands, the split ratio is that count over the total
 * (2-decimal), and the direction alternates by depth (even → horizontal,
 * odd → vertical) so panes tile into a grid rather than one axis.
 */
const buildNode = (commands: string[], depth: number): CmuxLayoutNode => {
  if (commands.length === 1) {
    return makeLeaf(commands[0]!)
  }

  const leftCount = Math.ceil(commands.length / 2)
  const left = commands.slice(0, leftCount)
  const right = commands.slice(leftCount)

  return {
    direction: depth % 2 === 0 ? 'horizontal' : 'vertical',
    split: Math.round((leftCount / commands.length) * 100) / 100,
    children: [buildNode(left, depth + 1), buildNode(right, depth + 1)],
  }
}

/**
 * Build a balanced cmux layout tree with one pane leaf per command. A single
 * command yields a bare leaf; N commands tile into a grid via alternating
 * horizontal/vertical splits. Throws when `commands` is empty.
 *
 * @example
 * buildCmuxLayout(['a', 'b'])
 * // => {
 * //   direction: 'horizontal',
 * //   split: 0.5,
 * //   children: [
 * //     { pane: { surfaces: [{ type: 'terminal', command: 'a' }] } },
 * //     { pane: { surfaces: [{ type: 'terminal', command: 'b' }] } },
 * //   ],
 * // }
 */
export const buildCmuxLayout = (commands: string[]): CmuxLayoutNode => {
  if (commands.length === 0) {
    throw new Error('buildCmuxLayout: at least one command is required')
  }

  return buildNode(commands, 0)
}
