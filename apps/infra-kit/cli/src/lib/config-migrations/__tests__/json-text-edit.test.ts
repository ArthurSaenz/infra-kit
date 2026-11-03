import { describe, expect, it } from 'vitest'

import { appendTopLevelMembers, prependTopLevelMembers, replaceTopLevelValue } from '../json-text-edit'

const PRETTY = '{\n  "a": [1, 2],\n  "b": { "c": "x,}" }\n}\n'

describe('json-text-edit', () => {
  it('prepends members after the opening brace and keeps every other byte', () => {
    expect(prependTopLevelMembers(PRETTY, [['v', 1]], '  ')).toBe(
      '{\n  "v": 1,\n  "a": [1, 2],\n  "b": { "c": "x,}" }\n}\n',
    )
  })

  it('appends members after the last one, nested lines one level deeper', () => {
    expect(appendTopLevelMembers(PRETTY, [['d', { e: ['f'] }]], '  ')).toBe(
      '{\n  "a": [1, 2],\n  "b": { "c": "x,}" },\n  "d": {\n    "e": [\n      "f"\n    ]\n  }\n}\n',
    )
  })

  it('replaces one top-level value, never a nested key of the same name', () => {
    const raw = '{\n  "x": { "v": 1 },\n  "v": 1\n}\n'

    expect(replaceTopLevelValue(raw, 'v', 2)).toBe('{\n  "x": { "v": 1 },\n  "v": 2\n}\n')
    expect(replaceTopLevelValue(raw, 'missing', 2)).toBeNull()
  })

  it('handles an empty object and a single-line one', () => {
    expect(prependTopLevelMembers('{}\n', [['v', 1]], '  ')).toBe('{\n  "v": 1\n}\n')
    expect(prependTopLevelMembers('{"a":1}', [['v', 1]], '  ')).toBe('{"v": 1, "a":1}')
    expect(JSON.parse(appendTopLevelMembers('{"a":1}', [['v', [1]]], '  ')!)).toEqual({ a: 1, v: [1] })
  })

  it('keeps CRLF line endings', () => {
    expect(prependTopLevelMembers('{\r\n  "a": 1\r\n}\r\n', [['v', 1]], '  ')).toBe(
      '{\r\n  "v": 1,\r\n  "a": 1\r\n}\r\n',
    )
  })

  it('refuses text that is not a JSON object', () => {
    expect(prependTopLevelMembers('[1]', [['v', 1]], '  ')).toBeNull()
  })
})
