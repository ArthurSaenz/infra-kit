import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compareToManifest, sha256, writeManifest } from 'src/lib/vendor'
import { mirroredSha256 } from 'src/lib/vendor/hash'
import { localBlockOf, stripLocalBlock, withLocalBlock } from 'src/lib/vendor/local-block'

const BLOCK = '# infra-kit:local-start\n!**/src/coverage\n# infra-kit:local-end'

const text = (content: Buffer): string => {
  return content.toString('utf8')
}

describe('localBlockOf', () => {
  it('returns the block with its markers', () => {
    expect(localBlockOf(Buffer.from(`node_modules\n${BLOCK}\ndist\n`))).toBe(BLOCK)
  })

  it('accepts any comment leader on the marker lines', () => {
    const markdown = '<!-- infra-kit:local-start -->\nmine\n<!-- infra-kit:local-end -->'
    const js = '  // infra-kit:local-start\nconst mine = 1\n  // infra-kit:local-end'

    expect(localBlockOf(Buffer.from(`# Title\n${markdown}\n`))).toBe(markdown)
    expect(localBlockOf(Buffer.from(`${js}\n`))).toBe(js)
  })

  it('is null without markers, for an unterminated block, and for a marker that is not alone on its line', () => {
    expect(localBlockOf(Buffer.from('node_modules\n'))).toBeNull()
    expect(localBlockOf(Buffer.from('# infra-kit:local-start\nmine\n'))).toBeNull()
    expect(localBlockOf(Buffer.from('see `# infra-kit:local-start` and `# infra-kit:local-end`\n'))).toBeNull()
  })
})

describe('withLocalBlock / stripLocalBlock', () => {
  it('appends the block after a source without one, and stripping gives the source back', () => {
    const source = Buffer.from('node_modules\ndist\n')
    const merged = withLocalBlock(source, BLOCK)

    expect(text(merged)).toBe(`node_modules\ndist\n${BLOCK}\n`)
    expect(stripLocalBlock(merged)).toEqual(source)
  })

  it('adds the missing newline before appending to a source that lacks a final one', () => {
    expect(text(withLocalBlock(Buffer.from('dist'), BLOCK))).toBe(`dist\n${BLOCK}\n`)
  })

  it("replaces the source's own block in place", () => {
    const source = Buffer.from('a\n# infra-kit:local-start\nstarter\n# infra-kit:local-end\nb\n')

    expect(text(withLocalBlock(source, BLOCK))).toBe(`a\n${BLOCK}\nb\n`)
  })

  it('leaves content without a block untouched', () => {
    const content = Buffer.from([0, 1, 2, 255])

    expect(stripLocalBlock(content)).toBe(content)
  })
})

describe('mirroredSha256 and the manifest', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-local-block-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('equals sha256 for a file without a block and ignores the block otherwise', () => {
    const plain = path.join(tmp, 'plain')
    const marked = path.join(tmp, 'marked')

    fs.writeFileSync(plain, 'dist\n')
    fs.writeFileSync(marked, `dist\n${BLOCK}\n`)

    expect(mirroredSha256(plain)).toBe(sha256(plain))
    expect(mirroredSha256(marked)).toBe(sha256(plain))
  })

  it('reports no drift when only the local block changes, and drift when a mirrored line does', () => {
    const file = path.join(tmp, 'configs/.prettierignore')

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `dist\n${BLOCK}\n`)

    const manifest = writeManifest(tmp, { source: 'starter', commit: 'abc' })

    fs.writeFileSync(file, `dist\n# infra-kit:local-start\nevals/reports\n# infra-kit:local-end\n`)
    expect(compareToManifest(tmp, manifest).modified).toEqual([])

    fs.writeFileSync(file, `build\n${BLOCK}\n`)
    expect(compareToManifest(tmp, manifest).modified).toEqual(['configs/.prettierignore'])
  })
})
