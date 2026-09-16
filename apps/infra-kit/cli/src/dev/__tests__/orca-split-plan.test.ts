import { describe, expect, it } from 'vitest'

import { buildOrcaSplitPlan } from 'src/dev/orca-split-plan'

/**
 * Pure split planning for `infra-kit dev --orca`. A balanced tiling tree expressed as an ordered
 * `terminal split` list: pane 0 is the `terminal create`, every step appends one
 * pane, and `from` indexes that growing list. The exact step lists are asserted, not just their
 * shape — the order IS the geometry (a root split must land before its children's).
 */
describe('buildOrcaSplitPlan', () => {
  it('throws on an empty command list', () => {
    expect(() => {
      return buildOrcaSplitPlan([])
    }).toThrow(/at least one command/)
  })

  it('needs no split for a single command — the create pane is the whole tab', () => {
    expect(buildOrcaSplitPlan(['a'])).toEqual([])
  })

  it('two commands: one horizontal split off the create pane', () => {
    expect(buildOrcaSplitPlan(['a', 'b'])).toEqual([{ from: 0, direction: 'horizontal', command: 'b' }])
  })

  it('three commands: horizontal for the right column first, then vertical under the first pane', () => {
    // ceil(3/2) = 2 on the left (a over b), 1 on the right (c). Measured tree in
    // docs/orca-cli-findings.md §3.3: horizontal(vertical(h0, h2), h1).
    expect(buildOrcaSplitPlan(['a', 'b', 'c'])).toEqual([
      { from: 0, direction: 'horizontal', command: 'c' },
      { from: 0, direction: 'vertical', command: 'b' },
    ])
  })

  it('five commands: the right subtree is anchored on the pane its root split created', () => {
    // Left [a b c] on pane 0, right [d e] on pane 1; the left half nests once more (depth 2 → horizontal).
    expect(buildOrcaSplitPlan(['a', 'b', 'c', 'd', 'e'])).toEqual([
      { from: 0, direction: 'horizontal', command: 'd' },
      { from: 0, direction: 'vertical', command: 'c' },
      { from: 0, direction: 'horizontal', command: 'b' },
      { from: 1, direction: 'vertical', command: 'e' },
    ])
  })

  it('emits exactly one step per non-first command, each `from` naming an already-created pane', () => {
    const commands = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const steps = buildOrcaSplitPlan(commands)

    expect(steps).toHaveLength(commands.length - 1)
    expect(
      steps.map((s) => {
        return s.command
      }),
    ).toEqual(expect.arrayContaining(commands.slice(1)))

    steps.forEach((step, index) => {
      expect(step.from).toBeLessThanOrEqual(index)
    })
  })
})
