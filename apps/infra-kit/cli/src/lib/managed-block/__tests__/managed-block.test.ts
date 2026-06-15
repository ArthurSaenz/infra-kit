import { describe, expect, it } from 'vitest'

import { extractVersion, hasManagedBlock, removeManagedBlock, upsertManagedBlock } from '../managed-block'

const START = '<!-- ik:begin -->'
const END = '<!-- ik:end -->'

describe('hasManagedBlock', () => {
  it('detects a well-formed block', () => {
    expect(hasManagedBlock(`x ${START} y ${END} z`, START, END)).toBe(true)
  })

  it('returns false when a marker is missing', () => {
    expect(hasManagedBlock(`only ${START} here`, START, END)).toBe(false)
  })

  it('treats reversed markers (end before start) as absent', () => {
    expect(hasManagedBlock(`${END} middle ${START}`, START, END)).toBe(false)
  })
})

describe('removeManagedBlock', () => {
  it('removes the block and preserves surrounding text', () => {
    const content = `top\n${START}\nmid\n${END}\nbot`

    expect(removeManagedBlock(content, START, END)).toBe('top\nbot')
  })

  it('returns null when no block is present', () => {
    expect(removeManagedBlock('nothing here', START, END)).toBeNull()
  })

  it('returns null for reversed markers (guard)', () => {
    expect(removeManagedBlock(`${END}\nx\n${START}`, START, END)).toBeNull()
  })
})

describe('extractVersion', () => {
  const PREFIX = '<!-- ik:version '

  it('reads the version token after the prefix', () => {
    expect(extractVersion('<!-- ik:version 0.1.105 -->', PREFIX)).toBe('0.1.105')
  })

  it('returns null when the prefix is absent', () => {
    expect(extractVersion('no version here', PREFIX)).toBeNull()
  })
})

describe('upsertManagedBlock', () => {
  it('inserts into an empty file (replace-in-place default)', () => {
    const result = upsertManagedBlock({ content: '', body: 'hello', startMarker: START, endMarker: END })

    expect(result).toBe(`${START}\nhello\n${END}\n`)
  })

  it('inserts into an empty file (append-end)', () => {
    const result = upsertManagedBlock({
      content: '',
      body: 'hello',
      startMarker: START,
      endMarker: END,
      placement: 'append-end',
    })

    expect(result).toBe(`${START}\nhello\n${END}\n`)
  })

  it('replaces an existing block in place, keeping surrounding content verbatim', () => {
    const content = `# top heading\n\n${START}\nold body\n${END}\n\n# bottom heading\n`
    const result = upsertManagedBlock({ content, body: 'new body', startMarker: START, endMarker: END })

    expect(result).toBe(`# top heading\n\n${START}\nnew body\n${END}\n\n# bottom heading\n`)
  })

  it('append-end relocates an existing mid-file block to end-of-file', () => {
    const content = `intro\n\n${START}\nold\n${END}\n\nuser tail`
    const result = upsertManagedBlock({
      content,
      body: 'fresh',
      startMarker: START,
      endMarker: END,
      placement: 'append-end',
    })

    expect(result).toBe(`intro\nuser tail\n${START}\nfresh\n${END}\n`)
  })

  it('append-end lands the block at end-of-file when absent', () => {
    const content = 'existing user content'
    const result = upsertManagedBlock({
      content,
      body: 'b',
      startMarker: START,
      endMarker: END,
      placement: 'append-end',
    })

    expect(result.endsWith(`${START}\nb\n${END}\n`)).toBe(true)
    expect(result.startsWith('existing user content')).toBe(true)
  })

  it('is idempotent — re-running does not nest or duplicate blocks', () => {
    const once = upsertManagedBlock({ content: 'pre\n', body: 'b', startMarker: START, endMarker: END })
    const twice = upsertManagedBlock({ content: once, body: 'b', startMarker: START, endMarker: END })

    expect(twice).toBe(once)
    expect(twice.match(new RegExp(START, 'g'))?.length).toBe(1)
  })

  it('preserves content above and below across an update', () => {
    const first = upsertManagedBlock({ content: 'ABOVE\n', body: 'v1', startMarker: START, endMarker: END })
    const withTail = `${first}BELOW\n`
    const updated = upsertManagedBlock({ content: withTail, body: 'v2', startMarker: START, endMarker: END })

    expect(updated).toContain('ABOVE')
    expect(updated).toContain('BELOW')
    expect(updated).toContain('v2')
    expect(updated).not.toContain('v1')
  })
})
