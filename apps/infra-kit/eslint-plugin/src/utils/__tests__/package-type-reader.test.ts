import { describe, expect, it } from 'vitest'

import { readDeclaredType } from '../package-type-reader'

describe('readDeclaredType', () => {
  it('reads a single-quoted literal', () => {
    expect(readDeclaredType("export default { type: 'backend' }")).toBe('backend')
  })

  it('reads a double-quoted literal', () => {
    expect(readDeclaredType('export default { type: "mobile" }')).toBe('mobile')
  })

  it('reads a literal with no space after the colon', () => {
    expect(readDeclaredType("type:'lib'")).toBe('lib')
  })

  it('reads a literal on an indented line', () => {
    expect(readDeclaredType("export default defineConfig({\n    type: 'e2e',\n})\n")).toBe('e2e')
  })

  it('reads a one-line object literal', () => {
    expect(readDeclaredType("{ type: 'frontend' }")).toBe('frontend')
  })

  it('rejects a computed value', () => {
    expect(readDeclaredType('export default { type: someVar }')).toBeUndefined()
    expect(readDeclaredType('export default { type: pickType() }')).toBeUndefined()
  })

  it('rejects a literal outside the known types', () => {
    expect(readDeclaredType("export default { type: 'plugin' }")).toBeUndefined()
  })

  it('rejects a key that merely ends in `type`', () => {
    expect(readDeclaredType("export default { mimetype: 'frontend' }")).toBeUndefined()
  })

  it('ignores a commented-out literal above the live one', () => {
    expect(readDeclaredType("export default {\n  // type: 'backend',\n  type: 'frontend',\n}\n")).toBe('frontend')
  })

  it('ignores a literal that only appears in a block comment', () => {
    expect(readDeclaredType("/* type: 'e2e' */\nexport default {}\n")).toBeUndefined()
    expect(readDeclaredType("/*\n * type: 'e2e'\n */\nexport default {}\n")).toBeUndefined()
  })

  it('keeps the live literal when a trailing comment mentions another', () => {
    expect(readDeclaredType("export default {\n  type: 'frontend', // was 'backend'\n}\n")).toBe('frontend')
  })

  it('is not disturbed by a URL value on another line', () => {
    const text = [
      'export default {',
      "  templates: { cloud: 'https://<env>.hulyo.co.il', local: 'https://<app>.localhost' },",
      "  type: 'backend',",
      '}',
      '',
    ].join('\n')

    expect(readDeclaredType(text)).toBe('backend')
  })

  it('returns undefined when no type is declared', () => {
    expect(readDeclaredType('export default {}')).toBeUndefined()
    expect(readDeclaredType('')).toBeUndefined()
  })
})
