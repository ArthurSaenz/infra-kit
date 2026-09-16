/**
 * Pure split planning for `infra-kit dev --orca`.
 *
 * Orca has no layout JSON: a tab is built imperatively — one `terminal create`,
 * then one `terminal split` per extra pane, each anchored on an existing handle.
 * This module turns a flat command list into that ordered split list while
 * keeping a balanced-tree tiling (a grid, not one long strip). Side-effect free
 * (no fs, no cwd, no shell) so the tiling math stays unit-testable.
 */

export type OrcaSplitDirection = 'horizontal' | 'vertical'

/**
 * One `terminal split`: `from` indexes the pane list (0 = the `terminal create`
 * pane; every step appends the pane it creates), so a step is only valid once the
 * steps before it have run in order.
 */
export interface OrcaSplitStep {
  from: number
  direction: OrcaSplitDirection
  command: string
}

/**
 * Split `commands` into a balanced binary tree — the left half takes
 * `Math.ceil(n / 2)` — with the direction alternating by depth (even → horizontal,
 * odd → vertical) so panes tile into a grid rather than one axis.
 *
 * Emitted in pre-order: a subtree's root split runs BEFORE its children's, because
 * Orca splits the pane as it currently is — splitting `a` vertically first and
 * horizontally second would put the third pane beside `a` alone instead of beside
 * the whole `a`/`b` column.
 */
const planSubtree = (commands: string[], depth: number, anchor: number, steps: OrcaSplitStep[]): void => {
  if (commands.length <= 1) return

  const leftCount = Math.ceil(commands.length / 2)
  const left = commands.slice(0, leftCount)
  const right = commands.slice(leftCount)

  steps.push({ from: anchor, direction: depth % 2 === 0 ? 'horizontal' : 'vertical', command: right[0]! })

  const rightAnchor = steps.length

  planSubtree(left, depth + 1, anchor, steps)
  planSubtree(right, depth + 1, rightAnchor, steps)
}

/**
 * Build the ordered `terminal split` steps that lay `commands` out as a balanced
 * grid, `commands[0]` being the pane `terminal create` opened. A single command
 * needs no split; an empty list throws.
 *
 * @example
 * buildOrcaSplitPlan(['a', 'b', 'c'])
 * // => [{ from: 0, direction: 'horizontal', command: 'c' },   // pane 1, right of a
 * //     { from: 0, direction: 'vertical', command: 'b' }]     // pane 2, below a
 */
export const buildOrcaSplitPlan = (commands: string[]): OrcaSplitStep[] => {
  if (commands.length === 0) {
    throw new Error('buildOrcaSplitPlan: at least one command is required')
  }

  const steps: OrcaSplitStep[] = []

  planSubtree(commands, 0, 0, steps)

  return steps
}
