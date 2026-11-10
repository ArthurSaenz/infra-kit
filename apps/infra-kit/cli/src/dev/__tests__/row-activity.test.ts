import { describe, expect, it } from 'vitest'

import { RowActivity } from '../row-activity'

const harness = (counts: Record<string, number> = {}): { rows: RowActivity; announced: string[] } => {
  const announced: string[] = []

  return {
    rows: new RowActivity({
      errorsOf: (tag) => {
        return counts[tag] ?? 0
      },
      onFirstError: (tag) => {
        announced.push(tag)
      },
    }),
    announced,
  }
}

describe('rowActivity', () => {
  it('counts a row`s requests and forgets the ones older than a minute on prune', () => {
    const { rows } = harness()

    rows.recordRequest('shop/api', 1_000)
    rows.recordRequest('shop/api', 50_000)
    rows.recordRequest('blog/api', 50_000)

    expect(rows.requestsPerMinute('shop/api')).toBe(2)

    rows.prune(70_000)

    expect(rows.requestsPerMinute('shop/api')).toBe(1)
    expect(rows.requestsPerMinute('blog/api')).toBe(1)
    expect(rows.requestsPerMinute('never/api')).toBe(0)
  })

  it('announces a row`s first error once, however often the count is read', () => {
    const counts: Record<string, number> = { 'shop/ui': 0 }
    const { rows, announced } = harness(counts)

    expect(rows.errors('shop/ui')).toBe(0)
    expect(announced).toEqual([])

    counts['shop/ui'] = 3

    expect(rows.errors('shop/ui')).toBe(3)
    expect(rows.errors('shop/ui')).toBe(3)
    expect(announced).toEqual(['shop/ui'])
  })
})
