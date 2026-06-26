import { describe, expect, it } from 'vitest'

import { formatAlignedRows } from '../render'

describe('formatAlignedRows', () => {
  it('pads every left cell to the widest left cell and joins with the default 2-space gap', () => {
    expect(
      formatAlignedRows([
        ['a', 'x'],
        ['bbb', 'y'],
      ]),
    ).toEqual(['a    x', 'bbb  y'])
  })

  it('honours a custom gap', () => {
    expect(
      formatAlignedRows(
        [
          ['a', 'x'],
          ['bb', 'y'],
        ],
        ' | ',
      ),
    ).toEqual(['a  | x', 'bb | y'])
  })

  it('reproduces the menu label format (name padded + 2 spaces + description)', () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ['merge-dev', 'Merge dev branch into every release branch'],
      ['release-list', 'List all release branches'],
    ]

    const width = Math.max(
      ...rows.map(([left]) => {
        return left.length
      }),
    )
    const expected = rows.map(([left, right]) => {
      return `${left.padEnd(width)}  ${right}`
    })

    expect(formatAlignedRows(rows)).toEqual(expected)
  })

  it('returns an empty array for no rows', () => {
    expect(formatAlignedRows([])).toEqual([])
  })
})
